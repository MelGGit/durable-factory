import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { realFixture } from './fixtures/real.js';
import { until } from './fixtures/chat.js';

for (const phase of ['worktree', 'artifacts'])
  test(
    `SIGKILL after cleanup ${phase} deletion resumes without losing unrelated state`,
    { timeout: 60000 },
    async () => {
      const child = fork(
        resolve('scripts/cleanup-recovery-worker.ts'),
        [phase],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      let directory = '';
      let fixture: Awaited<ReturnType<typeof realFixture>> | undefined;
      try {
        const milestone = await Promise.race([
          once(child, 'message').then(
            ([value]) => value as { directory: string; runId: string },
          ),
          once(child, 'exit').then(() => {
            throw new Error('Cleanup worker exited before milestone');
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Cleanup worker timed out')),
              30000,
            ).unref(),
          ),
        ]);
        directory = milestone.directory;
        child.kill('SIGKILL');
        await once(child, 'exit');
        fixture = await realFixture({ directory });
        const f = fixture;
        const original = f.github.getIssue;
        f.github.getIssue = async (...args) => ({
          ...(await original(...args)),
          state: 'closed',
        });
        await until(
          async () => {
            await f.service.pollCompletedRuns();
            return f.client.workflow();
          },
          (s) => !s.runs.length,
          15000,
        );
        assert.ok((await f.client.settings()).credentials.github);
        assert.equal(f.creates, 1);
        await assert.rejects(f.client.startIssue(7, crypto.randomUUID()));
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
        if (fixture) await fixture.close();
        else if (directory)
          await rm(directory, { recursive: true, force: true });
      }
    },
  );
