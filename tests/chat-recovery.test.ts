import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
function message(child: ChildProcess, phase: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (data) => (stderr += data));
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${phase}: ${stderr}`));
    }, 15000);
    const receive = (value: any) => {
      if (value.phase === phase) {
        cleanup();
        resolve(value);
      }
    };
    const exit = () => {
      cleanup();
      reject(new Error(`Worker exited: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('message', receive);
      child.off('exit', exit);
    };
    child.on('message', receive);
    child.once('exit', exit);
  });
}
for (const scenario of ['model', 'safe', 'unsafe'])
  test(
    `chat service recovers a killed ${scenario} operation and queued input`,
    { timeout: 35000 },
    async () => {
      const dataDir = await mkdtemp(
        join(tmpdir(), `factory-chat-${scenario}-`),
      );
      let child: ChildProcess | undefined;
      const spawn = (mode: string) =>
        fork(
          resolve('scripts/chat-recovery-worker.ts'),
          [dataDir, scenario, mode],
          {
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          },
        );
      try {
        child = spawn('crash');
        const before = await message(child, 'crash');
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        child = spawn('resume');
        const after = await message(child, 'done');
        assert.equal(after.submissionId, before.submissionId);
        assert.equal(
          after.entries.filter((entry: any) => entry.kind === 'pi.user').length,
          2,
        );
        assert.equal(
          new Set(after.entries.map((entry: any) => entry.id)).size,
          after.entries.length,
        );
        if (scenario === 'model')
          assert.ok(
            after.entries.some((entry: any) => entry.interrupted && entry.text),
          );
        else {
          assert.equal(
            (await readFile(join(dataDir, 'calls.txt'), 'utf8'))
              .trim()
              .split('\n').length,
            scenario === 'safe' ? 2 : 1,
          );
          if (scenario === 'unsafe') {
            assert.equal(
              (await readFile(join(dataDir, 'effects.txt'), 'utf8'))
                .trim()
                .split('\n').length,
              1,
            );
            assert.match(JSON.stringify(after.entries), /interrupted/);
            assert.match(JSON.stringify(after.entries), /Committed output/);
          }
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
