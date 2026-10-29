import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  readFile,
  writeFile,
  rename,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatClient } from '../packages/shared/src/index.js';
import { workflowFixture } from './fixtures/workflow.js';
import { realFixture } from './fixtures/real.js';
import { until } from './fixtures/chat.js';
import { Deletions } from '../apps/server/src/deletion-state.js';
import { simulationAdapter } from '../apps/server/src/workflow.js';
import { context } from '../apps/server/src/storage.js';

async function completed(client: ChatClient, id: string) {
  return until(
    async () => {
      try {
        return await client.deletion(id);
      } catch (error) {
        if ((error as { status?: number }).status === 503) return undefined;
        throw error;
      }
    },
    (operation) => operation?.state === 'completed',
    20000,
  );
}

test(
  'planning deletion purges history independently, survives restart, and retries idempotently',
  { timeout: 40000 },
  async () => {
    const f = await workflowFixture();
    try {
      const plan = await f.issue();
      const other = await f.chat.createConversation('Keep this chat', 'keep');
      const operation = await f.chat.deleteConversation(plan);
      assert.equal((await f.chat.deleteConversation(plan)).id, operation.id);
      await assert.rejects(f.chat.submit(plan, 'no', 'late'), /being deleted/);
      await completed(f.chat, operation.id);
      await assert.rejects(f.chat.history(plan), /not found/);
      assert.ok(
        (await f.chat.conversations()).conversations.some(
          (item) => item.id === other.id,
        ),
      );
      assert.equal((await f.chat.deleteConversation(plan)).state, 'completed');
      await f.restart(false);
      const chat = new ChatClient(f.service.url);
      assert.equal((await chat.deletion(operation.id)).state, 'completed');
      await assert.rejects(chat.history(plan), /not found/);
      const db = new DatabaseSync(join(f.dataDir, 'factory.sqlite'));
      try {
        assert.equal(
          (
            db
              .prepare('SELECT count(*) AS count FROM conversations WHERE id=?')
              .get(Number(plan)) as { count: number }
          ).count,
          0,
        );
        assert.equal(
          (
            db
              .prepare(
                'SELECT count(*) AS count FROM entries WHERE conversation_id=?',
              )
              .get(Number(plan)) as { count: number }
          ).count,
          0,
        );
      } finally {
        db.close();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'deleting a planning chat keeps its active implementation and waits for unrelated execution',
  { timeout: 40000 },
  async () => {
    const adapter = simulationAdapter();
    const execute = adapter.execute;
    adapter.execute = (run, attempt, signal) =>
      attempt.stage === 'developer'
        ? new Promise(() => {})
        : execute(run, attempt, signal);
    const f = await workflowFixture(adapter);
    try {
      const plan = await f.issue();
      let run = await f.client.startRun(plan, 'run');
      run = await until(
        () => f.client.run(run.id),
        (r) => r.stage === 'developer',
      );
      const operation = await f.chat.deleteConversation(plan);
      await f.service.pollDeletions();
      assert.equal((await f.chat.deletion(operation.id)).state, 'waiting');
      assert.equal((await f.client.run(run.id)).status, 'running');
      const removal = await f.chat.deleteRun(run.id);
      await completed(f.chat, removal.id);
      await completed(f.chat, operation.id);
    } finally {
      await f.close();
    }
  },
);

test(
  'implementation deletion discards dirty and ignored files, preserves linked planning and remote state',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    try {
      const chat = new ChatClient(f.service.url);
      const plan = await chat.createConversation('Keep plan', 'keep-plan');
      await chat.submit(plan.id, 'plan', 'plan');
      await until(
        () => chat.submission(plan.id, 'plan'),
        (s) => s.status === 'completed',
      );
      await chat.submit(plan.id, 'yes', 'yes');
      await until(
        () => chat.submission(plan.id, 'yes'),
        (s) => s.status === 'completed',
      );
      const issue = f.github.issues[0];
      const originalIssue = f.github.getIssue;
      f.github.getIssue = async (...args) => ({
        ...(await originalIssue(...args)),
        number: issue.number,
        url: issue.url,
        title: (await f.service.planning.read(plan.id))!.ticket!.title,
        body: issue.body,
      });
      let run = await f.client.startRun(plan.id, 'real-run');
      run = await until(
        () => f.client.run(run.id),
        (r) => r.status === 'pr_ready',
        30000,
      );
      await writeFile(join(run.workspace!.path, 'value.txt'), 'unpublished');
      await writeFile(join(run.workspace!.path, 'untracked.txt'), 'untracked');
      await mkdir(join(run.workspace!.path, 'generated'), { recursive: true });
      await writeFile(
        join(run.workspace!.path, 'generated', 'discard.txt'),
        'ignored',
      );
      const pulls = (await f.github.pulls('example/project', '', 1)).pulls.map(
        (pull) => ({ ...pull }),
      );
      const operation = await chat.deleteConversation(
        run.developerConversationId,
      );
      assert.equal(operation.runId, run.id);
      assert.equal((await chat.deleteRun(run.id)).id, operation.id);
      await completed(chat, operation.id);
      await assert.rejects(access(run.workspace!.path));
      await assert.rejects(f.client.run(run.id), /not found/);
      assert.equal((await chat.history(plan.id)).entries.length > 0, true);
      assert.equal((await f.service.planning.read(plan.id))?.runId, undefined);
      assert.equal(
        await readFile(join(f.repo, 'user-draft.txt'), 'utf8'),
        'untouched',
      );
      assert.equal(
        f.git(f.repo, [
          'for-each-ref',
          '--format=%(refname)',
          `refs/heads/${run.workspace!.branch}`,
          `refs/durable-factory/${run.id}/`,
        ]),
        '',
      );
      assert.deepEqual(
        (await f.github.pulls('example/project', '', 1)).pulls,
        pulls,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'saved pending deletion resumes before startup scheduling with workflow disabled',
  { timeout: 40000 },
  async () => {
    const f = await workflowFixture();
    try {
      const plan = await f.issue();
      const run = await f.client.startRun(plan, 'run');
      await until(
        () => f.client.run(run.id),
        (r) => r.status === 'pr_ready',
      );
      const id = `run-${run.id}`;
      await f.service.workflow['harness'].commit(async (tx) => {
        (await tx.doc(Deletions)).items[id] = {
          id,
          runId: run.id,
          conversationIds: [run.developerConversationId],
          state: 'pending',
          message: 'Deletion requested.',
        };
      }, context);
      await f.restart(false);
      const chat = new ChatClient(f.service.url);
      await completed(chat, id);
      const deletionState = await f.service.workflow['harness'].snapshot(
        Deletions,
        context,
      );
      assert.equal(
        Object.keys(deletionState?.suppressedIssues ?? {}).length,
        1,
      );
      assert.ok(
        (await chat.conversations()).conversations.some(
          (item) => item.id === plan,
        ),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'substituted worktree paths block deletion and can be retried after repair',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    try {
      const chat = new ChatClient(f.service.url);
      let run = await f.client.startIssue(7, 'run');
      run = await until(
        () => f.client.run(run.id),
        (r) => r.status === 'pr_ready',
        30000,
      );
      const moved = `${run.workspace!.path}-saved`;
      await rename(run.workspace!.path, moved);
      await symlink(moved, run.workspace!.path);
      const operation = await chat.deleteRun(run.id);
      await f.service.pollDeletions();
      const blocked = await chat.deletion(operation.id);
      assert.match(blocked.message, /ownership/);
      assert.match(
        await readFile(join(moved, 'value.txt'), 'utf8'),
        /implemented/,
      );
      const { unlink } = await import('node:fs/promises');
      await unlink(run.workspace!.path);
      await rename(moved, run.workspace!.path);
      await chat.deleteRun(run.id);
      await completed(chat, operation.id);
    } finally {
      await f.close();
    }
  },
);

test(
  'deleting a running implementation terminates its supervised command before removing the worktree',
  { timeout: 60000 },
  async () => {
    const f = await realFixture({ developerCommand: 'sleep 30' });
    try {
      const chat = new ChatClient(f.service.url);
      let run = await f.client.startIssue(7, 'active-run');
      run = await until(
        () => f.client.run(run.id),
        (r) => r.stage === 'developer' && Boolean(r.workspace),
        20000,
      );
      const { Processes } = await import('../apps/server/src/processes.js');
      await until(
        async () =>
          Object.values(
            (await f.service.workflow['harness'].snapshot(Processes, context))
              ?.records ?? {},
          ),
        (records) =>
          records.some(
            (record) =>
              record.command === 'sleep 30' && record.state === 'authorized',
          ),
        15000,
      );
      const operation = await chat.deleteRun(run.id);
      await assert.rejects(
        f.client.command(run.id, {
          action: 'resume',
          operationId: 'late-resume',
          expectedRevision: run.revision,
        }),
        /being deleted/,
      );
      await completed(chat, operation.id);
      await assert.rejects(access(run.workspace!.path));
      assert.equal((await f.client.workflow()).slot, undefined);
    } finally {
      await f.close();
    }
  },
);

test(
  'deleting an implementation keeps a shared plan and another retained implementation',
  { timeout: 30000 },
  async () => {
    const f = await workflowFixture();
    try {
      const plan = await f.issue();
      const first = await f.client.startRun(plan, 'first');
      await until(
        () => f.client.run(first.id),
        (run) => run.status === 'pr_ready',
      );
      const second = await f.client.startRun(plan, 'second', true);
      await until(
        () => f.client.run(second.id),
        (run) => run.status === 'pr_ready',
      );
      const operation = await f.chat.deleteRun(first.id);
      await completed(f.chat, operation.id);
      assert.equal(
        (await f.client.run(second.id)).planningConversationId,
        plan,
      );
      assert.ok((await f.chat.history(plan)).entries.length);
      const planDeletion = await f.chat.deleteConversation(plan);
      await completed(f.chat, planDeletion.id);
      assert.equal((await f.client.run(second.id)).planningConversationId, '');
      assert.ok(
        (await f.chat.conversations()).conversations.some(
          (item) => item.id === second.developerConversationId,
        ),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'interrupted manual cleanup resumes after its worktree was already removed',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    try {
      const chat = new ChatClient(f.service.url);
      let run = await f.client.startIssue(7, 'partial-cleanup');
      run = await until(
        () => f.client.run(run.id),
        (r) => r.status === 'pr_ready',
        30000,
      );
      const id = `run-${run.id}`;
      // Model a crash after workspace removal but before the storage purge.
      await f.service.workflow['harness'].commit(async (tx) => {
        (await tx.doc(Deletions)).items[id] = {
          id,
          runId: run.id,
          conversationIds: [run.developerConversationId],
          state: 'deleting',
          message: 'Deleting…',
        };
      }, context);
      f.git(f.repo, ['worktree', 'remove', '--force', run.workspace!.path]);
      await f.restart();
      await completed(chat, id);
      assert.equal(
        f.git(f.repo, [
          'for-each-ref',
          '--format=%(refname)',
          `refs/heads/${run.workspace!.branch}`,
        ]),
        '',
      );
      await assert.rejects(f.client.run(run.id), /not found/);
    } finally {
      await f.close();
    }
  },
);

test(
  'active planning deletion stops generation and purges queued sends with workflows disabled',
  { timeout: 30000 },
  async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { startService } = await import('./helpers/credentials.js');
    const { fixture, configure } = await import('./fixtures/chat.js');
    const directory = await mkdtemp(join(tmpdir(), 'factory-delete-planning-'));
    const service = await startService({
      dataDir: directory,
      port: 0,
      workflowMode: 'disabled',
      chat: fixture(5),
    });
    try {
      const chat = new ChatClient(service.url);
      await configure(chat);
      const plan = await chat.createConversation('Active plan', 'active-plan');
      await chat.submit(
        plan.id,
        'A long planning message to keep generation running while deletion is requested.',
        'active',
      );
      await chat.submit(plan.id, 'queued', 'queued');
      const operation = await chat.deleteConversation(plan.id);
      await completed(chat, operation.id);
      await assert.rejects(chat.submission(plan.id, 'queued'), /not found/);
      assert.equal((await chat.conversations()).conversations.length, 0);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'manual deletion serializes with merged cleanup and completes without deleting its linked plan',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    try {
      const chat = new ChatClient(f.service.url);
      let run = await f.client.startIssue(7, 'both-cleanups');
      run = await until(
        () => f.client.run(run.id),
        (r) => r.status === 'pr_ready',
        30000,
      );
      const pulls = (await f.github.pulls('example/project', '', 1)).pulls;
      pulls[0].state = 'closed';
      pulls[0].merged = true;
      const originalIssue = f.github.getIssue;
      f.github.getIssue = async (...args) => ({
        ...(await originalIssue(...args)),
        state: 'closed',
      });
      const operation = await chat.deleteRun(run.id);
      await Promise.all([
        f.service.pollCompletedRuns(),
        f.service.pollDeletions(),
      ]);
      await completed(chat, operation.id);
      assert.equal((await f.client.workflow()).runs.length, 0);
      assert.equal((await chat.deleteRun(run.id)).state, 'completed');
    } finally {
      await f.close();
    }
  },
);

test(
  'manual deletion suppresses label admission across restart until an explicit start',
  { timeout: 60000 },
  async () => {
    const f = await realFixture({ labelReady: true });
    try {
      const chat = new ChatClient(f.service.url);
      let run = await f.client.startIssue(7, 'deleted-label-run');
      run = await until(
        () => f.client.run(run.id),
        (r) => r.status === 'pr_ready',
        30000,
      );
      // Existing data directories may have deletion records without suppression metadata.
      await f.service.workflow['harness'].commit(async (tx) => {
        const state = await tx.doc(Deletions);
        delete (state as Partial<typeof state>).suppressedIssues;
      }, context);
      const operation = await chat.deleteRun(run.id);
      await f.service.pollDeletions();
      assert.equal((await chat.deletion(operation.id)).state, 'completed');
      const settings = await f.client.settings();
      await assert.rejects(
        f.service.workflow.admit(
          { issueNumber: 7, operationId: 'label-deleted-run' },
          undefined,
          settings.revision,
          'label',
        ),
        /Automatic admission is disabled/,
      );
      let polls = 0;
      const readyIssues = f.github.readyIssues!.bind(f.github);
      f.github.readyIssues = async (...args) => {
        polls++;
        return readyIssues(...args);
      };
      await f.restart();
      await until(
        async () => polls,
        (count) => count > 0,
      );
      const { setTimeout } = await import('node:timers/promises');
      await setTimeout(100);
      assert.equal((await f.client.workflow()).runs.length, 0);
      assert.equal((await chat.deletion(operation.id)).state, 'completed');
      const replacement = await f.client.startIssue(7, 'explicit-replacement');
      assert.notEqual(replacement.id, run.id);
      const state = await f.service.workflow['harness'].snapshot(
        Deletions,
        context,
      );
      assert.deepEqual(state?.suppressedIssues, {});
    } finally {
      await f.close();
    }
  },
);

test(
  'failed deletion preparation reopens services and keeps unrelated chats usable',
  { timeout: 30000 },
  async () => {
    const f = await workflowFixture();
    try {
      const doomed = await f.chat.createConversation(
        'Delete after repair',
        'prepare-failure',
      );
      const retained = await f.chat.createConversation(
        'Keep working',
        'prepare-retained',
      );
      const harness = f.service.workflow['harness'];
      const snapshot = harness.snapshot.bind(harness);
      let injected = false;
      harness.snapshot = ((...args: unknown[]) => {
        if (f.service.chat!['closing'] && !injected) {
          injected = true;
          return Promise.reject(new Error('Transient snapshot failure'));
        }
        return Reflect.apply(snapshot, undefined, args);
      }) as typeof harness.snapshot;
      const operation = await f.chat.deleteConversation(doomed.id);
      await f.service.pollDeletions();
      assert.equal(injected, true);
      assert.equal((await f.chat.deletion(operation.id)).state, 'blocked');
      assert.equal((await fetch(`${f.service.url}/ready`)).status, 200);
      await f.chat.submit(
        retained.id,
        'hello after recovery',
        'recovered-send',
      );
      await until(
        () => f.chat.submission(retained.id, 'recovered-send'),
        (s) => s.status === 'completed',
      );
      assert.ok(
        (await f.chat.conversations()).conversations.some(
          (item) => item.id === doomed.id,
        ),
      );
      await f.chat.deleteConversation(doomed.id);
      await completed(f.chat, operation.id);
      assert.ok((await f.chat.history(retained.id)).entries.length);
    } finally {
      await f.close();
    }
  },
);

test(
  'failed automatic cleanup preparation also restores unrelated chat admission',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    try {
      const chat = new ChatClient(f.service.url);
      const retained = await chat.createConversation(
        'Keep automatic cleanup usable',
        'auto-prepare-retained',
      );
      let run = await f.client.startIssue(7, 'auto-prepare-run');
      run = await until(
        () => f.client.run(run.id),
        (r) => r.status === 'pr_ready',
        30000,
      );
      const pulls = (await f.github.pulls('example/project', '', 1)).pulls;
      pulls[0].state = 'closed';
      pulls[0].merged = true;
      const getIssue = f.github.getIssue;
      f.github.getIssue = async (...args) => ({
        ...(await getIssue(...args)),
        state: 'closed',
      });
      const harness = f.service.workflow['harness'];
      const snapshot = harness.snapshot.bind(harness);
      let injected = false;
      harness.snapshot = ((...args: unknown[]) => {
        if (f.service.chat!['closing'] && !injected) {
          injected = true;
          return Promise.reject(
            new Error('Transient cleanup snapshot failure'),
          );
        }
        return Reflect.apply(snapshot, undefined, args);
      }) as typeof harness.snapshot;
      await f.service.pollCompletedRuns();
      assert.equal(injected, true);
      assert.equal((await f.client.run(run.id)).cleanup?.state, 'blocked');
      assert.equal((await fetch(`${f.service.url}/ready`)).status, 200);
      await chat.submit(
        retained.id,
        'hello after automatic recovery',
        'auto-recovered-send',
      );
      await until(
        () => chat.submission(retained.id, 'auto-recovered-send'),
        (s) => s.status === 'completed',
      );
    } finally {
      await f.close();
    }
  },
);
