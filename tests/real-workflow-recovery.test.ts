import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { realFixture } from './fixtures/real.js';
import { until } from './fixtures/chat.js';
for (const scenario of [
  'command',
  'commit',
  'push',
  'publication',
  'report',
  'proof',
])
  test(
    `real ${scenario} SIGKILL preserves effects and reconciles before explicit continuation`,
    { timeout: 60000 },
    async () => {
      const child = fork(
        resolve('scripts/real-workflow-recovery-worker.ts'),
        [scenario],
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
            ([message]) => message as { directory: string; runId: string },
          ),
          once(child, 'exit').then(() => {
            throw new Error('Recovery worker exited before checkpoint');
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Worker checkpoint timed out')),
              30000,
            ).unref(),
          ),
        ]);
        directory = milestone.directory;
        child.kill('SIGKILL');
        await once(child, 'exit');
        if (scenario === 'command') {
          const incompatible = await realFixture({
            directory,
            mode: 'simulation',
          });
          const blocked = await incompatible.client.run(milestone.runId);
          assert.equal(blocked.status, 'termination_blocker');
          assert.equal((await incompatible.client.workflow()).slot, blocked.id);
          await assert.rejects(
            incompatible.client.command(blocked.id, {
              action: 'reconcile',
              operationId: 'wrong-mode',
              expectedRevision: blocked.revision,
            }),
            /compatible/,
          );
          await incompatible.service.close();
        }
        fixture = await realFixture({ directory });
        let run = await fixture.client.run(milestone.runId);
        if (run.status === 'termination_blocker') {
          assert.equal((await fixture.client.workflow()).slot, run.id);
          run = await until(
            async () => {
              const current = await fixture!.client.run(run.id);
              return fixture!.client.command(run.id, {
                action: 'reconcile',
                operationId: `confirm-stopped-${current.revision}`,
                expectedRevision: current.revision,
              });
            },
            (r) => r.status !== 'termination_blocker',
            10000,
          );
        }
        assert.equal(run.status, 'needs_input');
        assert.equal(run.repairCount, 0);
        assert.equal(
          run.attempts.at(-1)!.recoveryCount,
          scenario === 'command' ? 2 : 1,
        );
        assert.equal((await fixture.client.workflow()).slot, undefined);
        if (scenario === 'report') {
          const { AgentOperations } = await import(
            '../apps/server/src/real-workflow.js'
          );
          const { context } = await import('../apps/server/src/storage.js');
          const operations = await fixture.service.workflow['harness'].snapshot(
            AgentOperations,
            context,
          );
          const report =
            operations!.items[run.attempts.at(-1)!.id].implementation;
          assert.ok(report);
          assert.equal(
            report.source,
            await fixture.service.workflow['adapter']!.inspect(run).then(
              (o) => o.source,
            ),
          );
          assert.equal(fixture.creates, 0);
        }
        if (scenario === 'proof') {
          assert.equal(run.stage, 'checks');
          assert.equal(run.implementations?.length, 1);
          assert.ok(run.proofWorkspaces?.length === 2);
          const resource = run.proofWorkspaces!.find((p) =>
            p.id.endsWith('-candidate'),
          )!;
          assert.equal(
            await readFile(
              join(resource.root, 'generated/proof-checkpoint'),
              'utf8',
            ),
            'ready',
          );
          assert.equal(
            run.evidence.some((e) => e.regression?.passed),
            false,
          );
          assert.equal(fixture.creates, 0);
          const { ProcessSupervisor } = await import(
            '../apps/server/src/processes.js'
          );
          const processes = new ProcessSupervisor(
            fixture.service.workflow['harness'],
            fixture.dataDir,
          );
          const command = (await processes.records(run.id)).find((p) =>
            p.id.endsWith('-proof-candidate-test'),
          )!;
          await assert.rejects(
            processes.run({
              id: command.id,
              runId: run.id,
              attemptId: run.attempts.at(-1)!.id,
              cwd: resource.root,
              command: command.command,
              timeout: 10,
              cancellation: 1,
            }),
            /Interrupted command/,
          );
          assert.equal(
            await readFile(
              join(resource.root, 'generated/proof-checkpoint'),
              'utf8',
            ),
            'ready',
          );
        }
        if (scenario === 'command') {
          assert.equal(
            await readFile(join(run.workspace!.path, 'effect.txt'), 'utf8'),
            'effect\n',
          );
          const question = run.interventions.find(
            (i) => i.state === 'pending' && i.reason === 'execution',
          )!;
          run = await fixture.client.command(run.id, {
            action: 'answer',
            operationId: 'inspected-effects',
            expectedRevision: run.revision,
            interventionId: question.id,
            interventionRevision: question.revision,
            answer:
              'Inspected the preserved effect. Continue without repeating the interrupted command.',
          });
          run = await until(
            () => fixture!.client.run(run.id),
            (r) =>
              ['pr_ready', 'needs_input', 'termination_blocker'].includes(
                r.status,
              ),
            30000,
          );
          assert.equal(run.status, 'pr_ready', JSON.stringify(run));
          assert.equal(
            await readFile(join(run.workspace!.path, 'effect.txt'), 'utf8'),
            'effect\n',
          );
        } else if (scenario === 'publication') {
          run = await fixture.client.command(run.id, {
            action: 'reconcile',
            operationId: 'reconcile-pr',
            expectedRevision: run.revision,
          });
          assert.equal(run.status, 'pr_ready');
          assert.equal(fixture.creates, 1);
          assert.equal(
            run.publication?.result,
            'https://github.com/example/project/pull/9',
          );
        }
        if (scenario === 'commit' || scenario === 'push') {
          const question = run.interventions.find(
            (i) => i.state === 'pending' && i.reason === 'execution',
          )!;
          run = await fixture.client.command(run.id, {
            action: 'answer',
            operationId: 'inspected-git-effect',
            expectedRevision: run.revision,
            interventionId: question.id,
            interventionRevision: question.revision,
            answer:
              'Inspected local commit and remote branch. Continue by reconciling existing Git effects.',
          });
          run = await until(
            () => fixture!.client.run(run.id),
            (r) =>
              ['pr_ready', 'needs_input', 'termination_blocker'].includes(
                r.status,
              ),
            30000,
          );
          assert.equal(run.status, 'pr_ready', JSON.stringify(run));
          assert.equal(fixture.creates, 1);
          assert.equal(
            fixture
              .git(run.workspace!.path, ['log', '--all', '--format=%B'])
              .split(`Durable-Factory-Operation: ${run.publication!.id}`)
              .length - 1,
            1,
          );
        }
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
