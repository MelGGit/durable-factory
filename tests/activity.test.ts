import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RunActivityClient,
  mergeActivity,
  type RunActivityFrame,
  type WorkflowRun,
} from '../packages/shared/src/index.js';
import { Workflow, simulationAdapter } from '../apps/server/src/workflow.js';
import { context } from '../apps/server/src/storage.js';
import { workflowFixture } from './fixtures/workflow.js';
import { until } from './fixtures/chat.js';
import { fauxAssistantMessage } from '../apps/server/src/chat-fixtures.js';

test('run activity merges independent conversations, paginates tied timestamps, hides task prompts and remains stable after restart', async () => {
  const fixture = await workflowFixture();
  try {
    const planningId = await fixture.issue();
    let run = await fixture.client.startRun(planningId, 'activity');
    run = await until(
      () => fixture.client.run(run.id),
      (r) => r.status === 'pr_ready',
    );
    const reviewer = run.attempts.find(
      (a) => a.stage === 'reviewer',
    )!.conversationId;
    const harness = fixture.service.workflow['harness'];
    const at = Date.now();
    await harness.commit(async (tx) => {
      for (let i = 0; i < 125; i++)
        await tx.appendEntry(
          Number(i % 2 ? reviewer : run.developerConversationId) as never,
          {
            kind: 'pi.assistant',
            model: [
              { ...fauxAssistantMessage(`Visible event ${i}`), timestamp: at },
            ],
          },
        );
      await tx.appendEntry(Number(run.developerConversationId) as never, {
        kind: 'pi.user',
        model: [
          {
            role: 'user',
            content: JSON.stringify({
              role: 'developer',
              contractVersion: 2,
              specification: { secretInternalContext: true },
            }),
            timestamp: at,
          },
        ],
      });
    }, context);
    let client = new RunActivityClient(fixture.service.url);
    const first = await client.activity(run.id, undefined, 11);
    assert.equal(first.items.length, 11);
    let merged = first.items,
      cursor = first.cursor;
    while (cursor) {
      const page = await client.activity(run.id, cursor, 11);
      assert.ok(
        !page.items.some((item) =>
          merged.some((existing) => existing.id === item.id),
        ),
      );
      merged = mergeActivity(page.items, merged);
      cursor = page.cursor;
    }
    assert.equal(
      merged.filter((item) => item.entry?.text.startsWith('Visible event'))
        .length,
      125,
    );
    assert.ok(merged.some((item) => item.actor === 'review'));
    assert.ok(merged.some((item) => item.actor === 'development'));
    assert.ok(!JSON.stringify(merged).includes('secretInternalContext'));
    assert.ok(!merged.some((item) => item.conversationId === planningId));
    const planning = await fixture.chat.history(planningId);
    assert.ok(
      !planning.entries.some((entry) => entry.text.startsWith('Visible event')),
    );
    const wrongCursor = Buffer.from(
      JSON.stringify({ runId: 'other', at, id: 'wrong' }),
    ).toString('base64url');
    await assert.rejects(
      client.activity(run.id, wrongCursor),
      /Invalid activity cursor/,
    );
    await assert.rejects(
      client.activity(run.id, undefined, 101),
      /Invalid activity page/,
    );
    const ids = first.items.map((item) => item.id);
    await fixture.restart();
    client = new RunActivityClient(fixture.service.url);
    assert.deepEqual(
      (await client.activity(run.id, undefined, 11)).items.map(
        (item) => item.id,
      ),
      ids,
    );
    const summaries = (
      await new (await import('../packages/shared/src/index.js')).ChatClient(
        fixture.service.url,
      ).conversations()
    ).conversations;
    assert.match(
      summaries.find((s) => s.id === run.developerConversationId)!.title,
      /Issue #/,
    );
  } finally {
    await fixture.close();
  }
});

test('activity streams publish changes and reconnect from a fresh snapshot', async () => {
  const fixture = await workflowFixture();
  let stop = () => {};
  try {
    let run = await fixture.client.startRun(
      await fixture.issue(),
      'stream-activity',
    );
    run = await until(
      () => fixture.client.run(run.id),
      (r) => r.status === 'pr_ready',
    );
    const client = new RunActivityClient(fixture.service.url);
    const frames: RunActivityFrame[] = [];
    stop = client.watch(
      run.id,
      (_page, frame) => {
        frames.push(frame);
      },
      () => {},
    );
    await until(
      async () => frames,
      (list) => list.length > 0,
    );
    const firstStream = frames[0].streamId;
    await fixture.service.workflow['harness'].commit(async (tx) => {
      await tx.appendEntry(Number(run.developerConversationId) as never, {
        kind: 'factory.workflow',
        data: { text: 'Live progress arrived', at: Date.now() },
      });
    }, context);
    await until(
      async () => frames,
      (list) =>
        list.some((frame) =>
          frame.snapshot.items.some(
            (item) => item.entry?.text === 'Live progress arrived',
          ),
        ),
    );
    await fixture.restart(true, true);
    await until(
      async () => frames,
      (list) =>
        list.some(
          (frame) =>
            frame.streamId !== firstStream && frame.type === 'snapshot',
        ),
      10000,
    );
    const last = frames.at(-1)!;
    assert.equal(
      new Set(last.snapshot.items.map((item) => item.id)).size,
      last.snapshot.items.length,
    );
  } finally {
    stop();
    await fixture.close();
  }
});

for (const quiescent of [true, false])
  test(`legacy paused baseline migration requires process confirmation (${quiescent})`, async () => {
    const adapter = simulationAdapter();
    const execute = adapter.execute;
    adapter.execute = (run, attempt, signal) =>
      attempt.stage === 'developer'
        ? new Promise(() => {})
        : execute(run, attempt, signal);
    const fixture = await workflowFixture(adapter);
    try {
      let run = await fixture.client.startRun(
        await fixture.issue(),
        'legacy-baseline',
      );
      run = await until(
        () => fixture.client.run(run.id),
        (r) => r.stage === 'developer',
      );
      run = await fixture.client.command(run.id, {
        action: 'pause',
        operationId: 'pause-legacy',
        expectedRevision: run.revision,
      });
      await fixture.service.workflow['harness'].commit(async (tx) => {
        const state = await tx.doc(Workflow);
        const saved = state.runs[run.id] as unknown as WorkflowRun;
        delete saved.activity;
        saved.stage = 'baseline';
        saved.setupRequired = true;
        saved.attempts.at(-1)!.stage = 'baseline';
        saved.interventions.push({
          id: 'baseline-only',
          revision: 0,
          state: 'pending',
          reason: 'baseline',
          question: 'Old baseline failed',
          conversationId: saved.developerConversationId,
        });
        saved.interventions.push({
          id: 'unrelated',
          revision: 0,
          state: 'pending',
          reason: 'developer',
          question: 'Keep this question',
          conversationId: saved.developerConversationId,
        });
      }, context);
      const secondPlan = await fixture.issue('second-legacy-plan');
      let inspections = 0;
      adapter.reconcile = async () => {
        inspections++;
        return { quiescent };
      };
      await fixture.restart();
      const migrated = await fixture.client.run(run.id);
      assert.ok(inspections > 0);
      assert.equal(migrated.stage, quiescent ? 'developer' : 'baseline');
      assert.equal(
        migrated.status,
        quiescent ? 'paused' : 'termination_blocker',
      );
      assert.equal(
        migrated.interventions.find((i) => i.id === 'unrelated')!.state,
        'pending',
      );
      assert.equal(
        migrated.interventions.find((i) => i.id === 'baseline-only')!.state,
        quiescent ? 'resolved' : 'pending',
      );
      assert.equal(
        migrated.attempts.at(-1)!.outcome,
        quiescent ? 'skipped' : 'interrupted',
      );
      if (!quiescent) {
        assert.equal((await fixture.client.workflow()).slot, run.id);
        const next = await fixture.client.startRun(
          secondPlan,
          'after-recovery',
        );
        assert.equal(next.status, 'queued');
        assert.equal(next.attempts.length, 0);
        assert.equal((await fixture.client.workflow()).slot, run.id);
        adapter.reconcile = async () => ({ quiescent: true });
        await fixture.client.command(run.id, {
          action: 'reconcile',
          operationId: 'confirm-legacy-stop',
          expectedRevision: migrated.revision,
        });
        await until(
          () => fixture.client.run(next.id),
          (value) => value.stage === 'developer' && value.status === 'running',
        );
        assert.equal((await fixture.client.workflow()).slot, next.id);
      }
      const activity = await new RunActivityClient(
        fixture.service.url,
      ).activity(run.id, undefined, 100);
      const originalSetup = run.attempts.find(
        (attempt) => attempt.stage === 'setup',
      )!;
      assert.ok(
        activity.items.some(
          (item) => item.id === `timeline:${originalSetup.id}`,
        ),
        'Legacy setup history remains visible after baseline migration',
      );
    } finally {
      await fixture.close();
    }
  });

test('reconciling one recovered process blocker cannot release another blocker', async () => {
  const adapter = simulationAdapter(),
    execute = adapter.execute;
  adapter.execute = (run, attempt, signal) =>
    attempt.stage === 'developer'
      ? new Promise(() => {})
      : execute(run, attempt, signal);
  const fixture = await workflowFixture(adapter);
  try {
    const stopped: string[] = [];
    for (const name of ['first-blocker', 'second-blocker']) {
      let run = await fixture.client.startRun(await fixture.issue(name), name);
      run = await until(
        () => fixture.client.run(run.id),
        (r) => r.stage === 'developer',
      );
      await fixture.client.command(run.id, {
        action: 'pause',
        operationId: `pause-${name}`,
        expectedRevision: run.revision,
      });
      stopped.push(run.id);
    }
    const nextPlan = await fixture.issue('after-both-blockers');
    await fixture.service.workflow['harness'].commit(async (tx) => {
      const state = await tx.doc(Workflow);
      for (const id of stopped) {
        const run = state.runs[id];
        run.stage = 'baseline';
        run.attempts.at(-1)!.stage = 'baseline';
      }
    }, context);
    adapter.reconcile = async () => ({ quiescent: false });
    await fixture.restart();
    const next = await fixture.client.startRun(nextPlan, 'wait-for-both');
    assert.equal(next.status, 'queued');
    const first = (await fixture.client.workflow()).slot!;
    const second = stopped.find((id) => id !== first)!;
    adapter.reconcile = async () => ({ quiescent: true });
    for (const id of [first, second]) {
      const blocker = await fixture.client.run(id);
      await fixture.client.command(id, {
        action: 'reconcile',
        operationId: `reconcile-${id}`,
        expectedRevision: blocker.revision,
      });
      if (id === first) {
        assert.equal((await fixture.client.run(next.id)).status, 'queued');
        assert.equal((await fixture.client.workflow()).slot, second);
      }
    }
    await until(
      () => fixture.client.run(next.id),
      (r) => r.stage === 'developer' && r.status === 'running',
    );
    assert.equal((await fixture.client.workflow()).slot, next.id);
  } finally {
    await fixture.close();
  }
});
