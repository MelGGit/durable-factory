import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type {
  WorkflowRun,
  StageAttempt,
} from '../packages/shared/src/index.js';
import { workflowFixture } from './fixtures/workflow.js';
function message(child: ChildProcess) {
  return new Promise<{ run: WorkflowRun; attempt?: StageAttempt }>(
    (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Recovery worker did not reach boundary')),
        15000,
      );
      child.once('message', (value) => {
        clearTimeout(timeout);
        resolve(value as never);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Worker exited ${code}`));
      });
      child.once('error', reject);
    },
  );
}
for (const scenario of [
  'boundary',
  'repair',
  'question',
  'publication',
  'cancellation',
]) {
  test(
    `SIGKILL during ${scenario} preserves identity and reconciles durable workflow`,
    { timeout: 30000 },
    async () => {
      const s = await workflowFixture();
      let child: ChildProcess | undefined;
      try {
        const conversationId = await s.issue();
        await s.service.close();
        const remote = join(s.directory, 'simulated-remote.json');
        const spawn = (phase: string) =>
          fork(
            resolve('scripts/workflow-recovery-worker.ts'),
            [s.dataDir, conversationId, scenario, phase, remote],
            {
              execArgv: ['--import', 'tsx'],
              stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
            },
          );
        child = spawn('crash');
        const before = await message(child);
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        child = spawn('recover');
        const after = await message(child);
        assert.equal(after.run.id, before.run.id);
        assert.equal(after.run.repairCount, before.run.repairCount);
        if (before.attempt) {
          const recovered = after.run.attempts.find(
            (a) => a.id === before.attempt!.id,
          )!;
          assert.equal(recovered.taskId, before.attempt.taskId);
          assert.equal(recovered.recoveryCount, 1);
          assert.equal(
            after.run.attempts.filter((a) => a.id === recovered.id).length,
            1,
          );
        }
        if (scenario === 'question')
          assert.deepEqual(after.run.interventions, before.run.interventions);
        else if (scenario === 'cancellation') {
          assert.equal(before.run.status, 'cancelling');
          assert.equal(after.run.status, 'cancelled');
          assert.equal(after.run.stopTarget, 'cancelled');
          assert.equal(after.run.attempts.length, before.run.attempts.length);
        } else assert.equal(after.run.status, 'pr_ready');
        if (scenario === 'publication')
          assert.deepEqual(JSON.parse(await readFile(remote, 'utf8')), [
            after.run.publication!.id,
          ]);
        const closed = once(child, 'exit');
        child.send('close');
        await closed;
        child = undefined;
      } finally {
        if (child) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
        await s.close();
      }
    },
  );
}
