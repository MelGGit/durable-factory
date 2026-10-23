import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { access, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { realFixture } from './fixtures/real.js';
import { until } from './fixtures/chat.js';
import { ChatClient } from '../packages/shared/src/index.js';
import { context } from '../apps/server/src/storage.js';
import { Workflow } from '../apps/server/src/workflow.js';
import {
  cleanupSnapshot,
  purgeRunStorage,
  cleanupWorkspace,
  cleanupArtifacts,
} from '../apps/server/src/cleanup.js';
import { Processes } from '../apps/server/src/processes.js';
import { Workspaces } from '../apps/server/src/workspace.js';
import { ProcessSupervisor } from '../apps/server/src/processes.js';
import { PrivateCredentials } from '../apps/server/src/credentials.js';

async function completed(f: Awaited<ReturnType<typeof realFixture>>) {
  const start = await f.client.startIssue(7, crypto.randomUUID());
  return until(
    () => f.client.run(start.id),
    (r) => r.status === 'pr_ready',
    30000,
  );
}
async function merged(
  f: Awaited<ReturnType<typeof realFixture>>,
  closed = true,
) {
  const original = f.github.getIssue;
  f.github.getIssue = async (...args) => ({
    ...(await original(...args)),
    state: closed ? 'closed' : 'open',
  });
  const batch = await f.github.pulls('example/project', '', 1);
  batch.pulls[0].merged = true;
  batch.pulls[0].state = 'closed';
}
async function clean(f: Awaited<ReturnType<typeof realFixture>>) {
  await until(
    async () => {
      await f.service.pollCompletedRuns();
      const value = await f.client.workflow();
      return value;
    },
    (s) => s.runs.length === 0,
    15000,
  );
}

test(
  'merged PR cleanup purges worktrees, artifacts and durable history while preserving settings, credentials and unrelated chat',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    try {
      const chat = new ChatClient(f.service.url);
      const unrelated = await chat.createConversation(
        'Keep my planning',
        crypto.randomUUID(),
      );
      const run = await completed(f);
      const staleIndex = join(
        f.dataDir,
        'worktrees',
        `.${run.id}-${crypto.randomUUID()}.index`,
      );
      await writeFile(staleIndex, 'stale candidate index');
      const settings = await f.client.settings();
      const credentials = await readFile(
        join(f.dataDir, 'credentials', 'github.json'),
        'utf8',
      );
      const inspection = await f.client.inspection(run.id);
      assert.ok(inspection.conversations.some((c) => c.usage.messages > 0));
      await merged(f);
      await clean(f);
      assert.equal((await f.client.settings()).revision, settings.revision);
      assert.equal(
        await readFile(join(f.dataDir, 'credentials', 'github.json'), 'utf8'),
        credentials,
      );
      assert.ok(
        (await chat.conversations()).conversations.some(
          (c) => c.id === unrelated.id,
        ),
      );
      await assert.rejects(access(run.workspace!.path));
      await assert.rejects(access(staleIndex));
      assert.equal(
        f.git(f.repo, [
          'for-each-ref',
          '--format=%(refname)',
          `refs/heads/${run.workspace!.branch}`,
          `refs/durable-factory/${run.id}/`,
        ]),
        '',
      );
      await assert.rejects(f.client.startIssue(7, crypto.randomUUID()));
      assert.equal((await f.client.workflow()).runs.length, 0);
      await f.service.pollCompletedRuns();
      await f.service.close();
      const db = new DatabaseSync(join(f.dataDir, 'factory.sqlite'));
      try {
        for (const table of [
          'entries',
          'tasks',
          'submissions',
          'conversations',
          'documents',
          'document_revisions',
        ]) {
          const column = table === 'document_revisions' ? 'content' : 'record';
          const leftovers = db
            .prepare(`SELECT * FROM ${table} WHERE instr(${column}, ?) > 0`)
            .all(run.id);
          assert.equal(leftovers.length, 0, table);
        }
        for (const id of [
          run.developerConversationId,
          ...run.attempts.map((a) => a.conversationId),
        ])
          assert.equal(
            db
              .prepare('SELECT COUNT(*) AS n FROM conversations WHERE id=?')
              .get(Number(id))?.n,
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
  'unmerged PRs, open issues and changed worktrees are retained; corrected blocked cleanup retries',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    try {
      const run = await completed(f);
      const batch = await f.github.pulls('example/project', '', 1);
      batch.pulls[0].state = 'closed';
      await f.service.pollCompletedRuns();
      assert.equal((await f.client.workflow()).runs.length, 1);
      await merged(f, false);
      await f.service.pollCompletedRuns();
      assert.equal((await f.client.workflow()).runs.length, 1);
      const original = f.github.getIssue;
      f.github.getIssue = async (...args) => ({
        ...(await original(...args)),
        state: 'closed',
      });
      const path = join(run.workspace!.path, 'value.txt');
      const content = await readFile(path, 'utf8');
      await writeFile(path, 'Unexpected user edit');
      await until(
        async () => {
          await f.service.pollCompletedRuns();
          return f.client.run(run.id);
        },
        (r) => r.cleanup?.state === 'blocked',
        15000,
      );
      assert.equal(await readFile(path, 'utf8'), 'Unexpected user edit');
      assert.match(
        (await f.client.run(run.id)).cleanup!.message,
        /unexpected changes/,
      );
      await writeFile(path, content);
      await clean(f);
    } finally {
      await f.close();
    }
  },
);

test(
  'closed issues cannot start through manual or planning-chat admission',
  { timeout: 30000 },
  async () => {
    const f = await realFixture();
    try {
      const original = f.github.getIssue;
      f.github.getIssue = async (...args) => ({
        ...(await original(...args)),
        state: 'closed',
      });
      await assert.rejects(f.client.startIssue(7, crypto.randomUUID()));
      // The planning path resolves the linked issue through the same real adapter.
      const chat = new ChatClient(f.service.url);
      const conversation = await chat.createConversation(
        'Closed linked issue',
        crypto.randomUUID(),
      );
      const { Planning } = await import('../apps/server/src/planning.js');
      await f.service.workflow['harness'].commit(async (tx) => {
        const doc = await tx.doc(Planning, Number(conversation.id) as never);
        (doc as any).value = {
          operation: {
            state: 'created',
            issue: {
              number: 7,
              url: 'https://github.com/example/project/issues/7',
            },
          },
        };
      }, context);
      await assert.rejects(
        f.client.startRun(conversation.id, crypto.randomUUID()),
      );
      assert.equal((await f.client.workflow()).runs.length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'cleanup resumes after filesystem deletion and rejects incompatible database versions before purging',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    try {
      const run = await completed(f);
      await merged(f);
      await until(
        () => f.service.workflow['harness'].inspect(context),
        (s) => !s.tasks.length,
      );
      await f.service.workflow.cleanupState(run.id, {
        state: 'pending',
        message: 'Interrupted cleanup',
      });
      const harness = f.service.workflow['harness'];
      const snapshot = await cleanupSnapshot(harness, run);
      const workspaces = new Workspaces(
        f.dataDir,
        new ProcessSupervisor(harness, f.dataDir),
        new PrivateCredentials(f.dataDir),
      );
      // Simulate a crash boundary after the idempotent filesystem phase.
      await cleanupWorkspace(
        await (await import('node:fs/promises')).realpath(f.dataDir),
        run,
        workspaces,
      );
      await cleanupArtifacts(
        await (await import('node:fs/promises')).realpath(f.dataDir),
        snapshot,
      );
      await f.restart();
      await clean(f);
      await f.service.close();
      const db = new DatabaseSync(join(f.dataDir, 'factory.sqlite'));
      db.exec('UPDATE durable_schema SET version=2');
      db.close();
      assert.throws(
        () => purgeRunStorage(f.dataDir, snapshot),
        /Unsupported Pi SQLite schema/,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'shared planning and another retained run survive cleanup; live processes block deletion',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    try {
      const run = await completed(f);
      const chat = new ChatClient(f.service.url);
      const planning = await chat.createConversation(
        'Shared planning',
        crypto.randomUUID(),
      );
      const retained = await chat.createConversation(
        'Retained run conversation',
        crypto.randomUUID(),
      );
      const harness = f.service.workflow['harness'];
      const otherId = crypto.randomUUID();
      await harness.commit(async (tx) => {
        const state = await tx.doc(Workflow);
        state.runs[run.id].planningConversationId = planning.id;
        state.runs[otherId] = {
          ...JSON.parse(JSON.stringify(run)),
          id: otherId,
          planningConversationId: planning.id,
          developerConversationId: retained.id,
          status: 'cancelled',
          attempts: [],
          evidence: [],
          evidenceHistory: [],
        };
        // JSON documents cannot contain undefined properties.
        delete state.runs[otherId].workspace;
        delete state.runs[otherId].publication;
        state.receipts['retained-receipt'] = {
          payload: 'retained',
          runId: otherId,
        };
      }, context);
      await merged(f);
      const owned = await import('node:child_process');
      const child = owned.spawn(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        { stdio: 'ignore' },
      );
      try {
        const { processTable } = await import(
          '../apps/server/src/processes.js'
        );
        const identity = (await processTable()).find(
          (p) => p.pid === child.pid,
        )!;
        await harness.commit(async (tx) => {
          const state = await tx.doc(Processes);
          state.records['cleanup-live'] = {
            id: 'cleanup-live',
            runId: run.id,
            attemptId: '',
            command: 'owned test child',
            state: 'authorized',
            supervisor: { pid: identity.pid, started: identity.started },
            descendants: [],
            startedAt: Date.now(),
            artifact: '',
          };
        }, context);
        await f.service.pollCompletedRuns();
        assert.match(
          (await f.client.run(run.id)).cleanup!.message,
          /not confirmed stopped/,
        );
        await access(run.workspace!.path);
      } finally {
        child.kill('SIGKILL');
        await new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
      }
      await until(
        async () => {
          await f.service.pollCompletedRuns();
          return f.client.workflow();
        },
        (s) => s.runs.length === 1,
        15000,
      );
      const state = await f.client.workflow();
      assert.equal(state.runs[0].id, otherId);
      assert.ok(
        (await chat.conversations()).conversations.some(
          (c) => c.id === planning.id,
        ),
      );
      assert.ok(
        (await chat.conversations()).conversations.some(
          (c) => c.id === retained.id,
        ),
      );
      assert.equal(
        (await f.service.workflow['harness'].snapshot(Workflow, context))!
          .receipts['retained-receipt'].runId,
        otherId,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'plan to issue, failed check, restart, repair, review, PR and merged cleanup complete offline',
  { timeout: 60000 },
  async () => {
    // Baseline passes; the first implementation fails once. The marker is ignored
    // disposable output, so it does not change the validated candidate identity.
    const check = `node -e "const f=require('node:fs'); if(f.readFileSync('value.txt','utf8').includes('implemented')&&!f.existsSync('generated/check-once')) { f.writeFileSync('generated/check-once','failed'); process.exit(1); }"`;
    const f = await realFixture({ checkCommand: check, reviewQuestion: true });
    try {
      const chat = new ChatClient(f.service.url);
      const conversation = await chat.createConversation(
        'End to end plan',
        crypto.randomUUID(),
      );
      for (const content of ['plan', 'yes']) {
        const request = crypto.randomUUID();
        await chat.submit(conversation.id, content, request);
        await until(
          () => chat.submission(conversation.id, request),
          (s) => s.status === 'completed',
        );
      }
      assert.equal(f.github.calls, 1);
      const issue = f.github.issues[0];
      const originalIssue = f.github.getIssue;
      f.github.getIssue = async (...args) => ({
        ...(await originalIssue(...args)),
        number: issue.number,
        url: issue.url,
        title: (await f.service.planning.read(conversation.id))!.ticket!.title,
        body: issue.body,
      });
      const started = await f.client.startRun(
        conversation.id,
        crypto.randomUUID(),
      );
      let run = await until(
        () => f.client.run(started.id),
        (r) => r.status === 'needs_input',
        30000,
      );
      assert.equal(run.repairCount, 1);
      assert.ok(
        run.evidenceHistory?.some((e) => e.kind === 'checks' && !e.passed),
      );
      const question = run.interventions.find((i) => i.state === 'pending')!;
      await f.restart();
      run = await f.client.run(run.id);
      assert.equal(
        run.interventions.find((i) => i.id === question.id)?.state,
        'pending',
      );
      await f.client.command(run.id, {
        action: 'answer',
        operationId: crypto.randomUUID(),
        expectedRevision: run.revision,
        interventionId: question.id,
        interventionRevision: question.revision,
        answer: 'Use the agreed interpretation.',
      });
      run = await until(
        () => f.client.run(run.id),
        (r) => r.status === 'pr_ready',
        30000,
      );
      assert.equal(run.repairCount, 1);
      await merged(f);
      await clean(f);
      assert.ok(
        !(await chat.conversations()).conversations.some(
          (c) => c.id === conversation.id,
        ),
      );
      assert.equal(f.creates, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'GitHub failure and rate limits defer cleanup without touching local state',
  { timeout: 30000 },
  async () => {
    const f = await realFixture();
    try {
      const run = await completed(f);
      await merged(f);
      const { GitHubFailure } = await import('../apps/server/src/github.js');
      let calls = 0;
      f.github.getPull = async () => {
        calls++;
        throw new GitHubFailure(
          'Rate limited',
          true,
          'PROVIDER_UNAVAILABLE',
          120000,
        );
      };
      await f.service.pollCompletedRuns();
      await f.service.pollCompletedRuns();
      assert.equal(calls, 1);
      assert.equal((await f.client.run(run.id)).cleanup, undefined);
      await access(run.workspace!.path);
    } finally {
      await f.close();
    }
  },
);

test(
  'cleanup preserves ignored files added or changed after publication',
  { timeout: 60000 },
  async () => {
    const check = `node -e "const f=require('node:fs'); f.mkdirSync('generated',{recursive:true}); f.writeFileSync('generated/cache.txt','disposable cache');"`;
    const f = await realFixture({ checkCommand: check });
    try {
      const run = await completed(f);
      assert.equal(run.publication!.cleanupIgnored!.files, 1);
      await merged(f);
      const notes = join(run.workspace!.path, 'generated/user-notes.txt');
      const cache = join(run.workspace!.path, 'generated/cache.txt');
      await writeFile(notes, 'keep my new notes');
      assert.equal(
        f.git(run.workspace!.path, [
          'status',
          '--porcelain',
          '--untracked-files=all',
        ]),
        '',
      );
      await f.service.pollCompletedRuns();
      assert.equal((await f.client.run(run.id)).cleanup?.state, 'blocked');
      assert.equal(await readFile(notes, 'utf8'), 'keep my new notes');
      await rm(notes);
      await writeFile(cache, 'keep my edited notes in this ignored file');
      await f.service.pollCompletedRuns();
      assert.match(
        (await f.client.run(run.id)).cleanup!.message,
        /Ignored files changed/,
      );
      assert.equal(
        await readFile(cache, 'utf8'),
        'keep my edited notes in this ignored file',
      );
      await writeFile(cache, 'disposable cache');
      await clean(f);
    } finally {
      await f.close();
    }
  },
);

test(
  'legacy runs without an ignored-file baseline keep ignored files until resolved',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    try {
      const run = await completed(f);
      await f.service.workflow['harness'].commit(async (tx) => {
        const state = await tx.doc(Workflow);
        delete state.runs[run.id].publication!.cleanupIgnored;
      }, context);
      const notes = join(run.workspace!.path, 'generated/legacy-notes.txt');
      await writeFile(notes, 'legacy notes');
      await merged(f);
      await f.service.pollCompletedRuns();
      assert.match(
        (await f.client.run(run.id)).cleanup!.message,
        /no saved cleanup baseline/,
      );
      assert.equal(await readFile(notes, 'utf8'), 'legacy notes');
      await rm(notes);
      await clean(f);
    } finally {
      await f.close();
    }
  },
);

test(
  'cleanup automatically reopens storage after temporary directory access failure',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    const harness = f.service.workflow['harness'];
    const originalClose = harness.close.bind(harness);
    try {
      const run = await completed(f);
      await merged(f);
      harness.close = async (...args) => {
        await originalClose(...args);
        await chmod(f.dataDir, 0);
      };
      await f.service.pollCompletedRuns();
      let response = await fetch(`${f.service.url}/ready`);
      assert.equal(response.status, 503);
      assert.match(
        (await response.json()).error.message,
        /Restore data-directory access.*retrying/,
      );
      await chmod(f.dataDir, 0o700);
      harness.close = originalClose;
      // Recovery must happen on its own timer even though the service is not ready.
      await until(
        async () => {
          const r = await fetch(`${f.service.url}/ready`);
          return r.status;
        },
        (code) => code === 200,
        10000,
      );
      await clean(f);
      await assert.rejects(access(run.workspace!.path));
      assert.ok((await f.client.settings()).credentials.github);
    } finally {
      await chmod(f.dataDir, 0o700);
      harness.close = originalClose;
      await f.close();
    }
  },
);

test(
  'reopening closes partially initialized harnesses and stops after bounded failures',
  { timeout: 60000 },
  async () => {
    const f = await realFixture();
    const { WorkflowService } = await import('../apps/server/src/workflow.js');
    const originalRecover = WorkflowService.prototype.recover;
    let attempts = 0;
    try {
      await completed(f);
      await merged(f);
      WorkflowService.prototype.recover = async () => {
        attempts++;
        throw new Error('injected private reopening failure');
      };
      await f.service.pollCompletedRuns();
      await until(
        async () => {
          const r = await fetch(`${f.service.url}/ready`);
          return { status: r.status, body: await r.json() };
        },
        (r) => r.body.error?.message.includes('attempts have stopped'),
        10000,
      );
      assert.equal(attempts, 3);
      await f.service.pollCompletedRuns();
      assert.equal(attempts, 3);
      const response = await fetch(`${f.service.url}/ready`);
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.match(body.error.message, /restart the service/);
      assert.ok(!JSON.stringify(body).includes('injected private'));
    } finally {
      WorkflowService.prototype.recover = originalRecover;
      await f.close();
    }
  },
);
