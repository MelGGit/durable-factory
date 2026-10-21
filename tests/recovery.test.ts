import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RecoveryScenario } from '../apps/server/src/recovery.js';
import { acquireOwnership } from '../apps/server/src/runtime.js';
function spawnWorker(
  dataDir: string,
  scenario: RecoveryScenario,
  mode: string,
) {
  return fork(
    resolve('scripts/recovery-worker.ts'),
    [dataDir, scenario, mode],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
}
function message(child: ChildProcess, expected: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}: ${stderr}`));
    }, 20000);
    const onMessage = (value: any) => {
      if (value.phase === expected) {
        cleanup();
        resolve(value);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Worker exited ${code}: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}
for (const scenario of ['model', 'safe', 'unsafe'] as const)
  test(
    `forced termination during ${scenario} work recovers without duplicate input or unsafe effects`,
    { timeout: 45000 },
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), `factory-${scenario}-`));
      let child: ChildProcess | undefined;
      try {
        await writeFile(join(dataDir, 'fixture.txt'), 'read-only fixture', {
          mode: 0o600,
        });
        child = spawnWorker(dataDir, scenario, 'crash');
        const interrupted = await message(child, scenario);
        if (scenario === 'model')
          assert.equal(interrupted.partialCommitted, true);
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        // A dead process releases its OS lock immediately, without a timeout.
        const recoveredOwner = await acquireOwnership(dataDir);
        await recoveredOwner.release();
        child = spawnWorker(dataDir, scenario, 'resume');
        const done = await message(child, 'done');
        assert.equal(done.result.status, 'done');
        assert.equal(done.queuedResult.status, 'done');
        assert.equal(done.submissionId, done.repeatedId);
        assert.equal(
          String(done.submissionId),
          await readFile(join(dataDir, 'submission-id.txt'), 'utf8'),
        );
        assert.ok(
          done.before.submissions.some(
            (entry: any) => entry.requestId === 'queued-follow-up',
          ),
        );
        const inputs = done.entries.filter(
          (entry: any) => entry.kind === 'pi.user',
        );
        assert.equal(inputs.length, 2);
        assert.equal(
          new Set(done.entries.map((entry: any) => entry.id)).size,
          done.entries.length,
        );
        if (scenario === 'model') {
          const responses = done.entries.flatMap((entry: any) =>
            entry.kind === 'pi.assistant' ? (entry.model ?? []) : [],
          );
          assert.ok(
            responses.some(
              (response: any) =>
                response.stopReason === 'aborted' &&
                JSON.stringify(response.content).includes('Recovered'),
            ),
          );
          assert.equal(
            responses.filter((response: any) => response.stopReason === 'stop')
              .length,
            2,
          );
        }
        if (scenario !== 'model') {
          const calls = (
            await readFile(join(dataDir, 'invocations.txt'), 'utf8')
          )
            .trim()
            .split('\n');
          assert.equal(calls.length, scenario === 'safe' ? 2 : 1);
          const tools = done.entries.filter(
            (entry: any) => entry.kind === 'pi.tool-result',
          );
          assert.equal(tools.length, 1);
          if (scenario === 'unsafe') {
            assert.equal(
              (await readFile(join(dataDir, 'effects.txt'), 'utf8'))
                .trim()
                .split('\n').length,
              1,
            );
            assert.match(JSON.stringify(tools), /interrupted/);
            assert.match(JSON.stringify(tools), /Committed progress/);
          } else assert.match(JSON.stringify(tools), /read-only fixture/);
        }
        if (child.exitCode === null) await once(child, 'exit');
      } finally {
        if (child && child.exitCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );
