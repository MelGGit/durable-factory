import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../packages/shared/src/index.js';
import {
  occupiedSlots,
  simulationAdapter,
  type StageResult,
} from '../apps/server/src/workflow.js';
import { until } from './fixtures/chat.js';
import { workflowFixture } from './fixtures/workflow.js';

/** Developer work stays in flight until the test lets it finish. */
function gatedAdapter() {
  const adapter = simulationAdapter();
  const waiting = new Map<string, (result: StageResult) => void>();
  adapter.execute = async (run, attempt) => {
    if (attempt.stage === 'developer')
      return new Promise<StageResult>((resolve) =>
        waiting.set(run.id, resolve),
      );
    return {
      outcome: 'passed',
      message: `Simulated ${attempt.stage}`,
      ...(attempt.stage === 'reviewer' ? { verdict: 'pass' as const } : {}),
      ...(attempt.stage === 'publishing'
        ? { publicationResult: 'Simulated PR' }
        : {}),
    };
  };
  const finish = (id: string) =>
    waiting.get(id)!({ outcome: 'passed', message: 'developer done' });
  return { adapter, waiting, finish };
}
const developing = (
  s: Awaited<ReturnType<typeof workflowFixture>>,
  id: string,
) =>
  until(
    () => s.client.run(id),
    (r) => r.stage === 'developer' && r.status === 'running',
  );

test('the runner count defaults to one and only accepts whole numbers from 1 to 16', async () => {
  const s = await workflowFixture(gatedAdapter().adapter);
  try {
    assert.equal((await s.client.runners()).runners, 1);
    assert.equal((await s.client.workflow()).runners, 1);
    for (const bad of [0, 17, 1.5, -1])
      await assert.rejects(
        s.client.saveRunners(bad),
        (e) => e instanceof ApiError && e.code === 'INVALID_INPUT',
      );
    assert.equal((await s.client.saveRunners(3)).runners, 3);
    assert.equal((await s.client.workflow()).runners, 3);
  } finally {
    await s.close();
  }
});

test('with two runners the two oldest runs work at once and the third waits for a free runner', async () => {
  const { adapter, finish } = gatedAdapter();
  const s = await workflowFixture(adapter);
  try {
    await s.client.saveRunners(2);
    const plans = [
      await s.issue('one'),
      await s.issue('two'),
      await s.issue('three'),
    ];
    const a = await s.client.startRun(plans[0], 'start-one');
    const b = await s.client.startRun(plans[1], 'start-two');
    const c = await s.client.startRun(plans[2], 'start-three');
    await developing(s, a.id);
    await developing(s, b.id);
    assert.equal((await s.client.run(c.id)).status, 'queued');
    const state = await s.client.workflow();
    assert.deepEqual([...state.slots].sort(), [a.id, b.id].sort());
    finish(a.id);
    await developing(s, c.id);
    assert.ok(!(await s.client.workflow()).slots.includes(a.id));
    finish(b.id);
    finish(c.id);
  } finally {
    await s.close();
  }
});

test('raising the count starts waiting runs at once, and lowering it never interrupts running work', async () => {
  const { adapter, finish } = gatedAdapter();
  const s = await workflowFixture(adapter);
  try {
    const plans = [
      await s.issue('one'),
      await s.issue('two'),
      await s.issue('three'),
    ];
    const a = await s.client.startRun(plans[0], 'start-one');
    const b = await s.client.startRun(plans[1], 'start-two');
    await developing(s, a.id);
    assert.equal((await s.client.run(b.id)).status, 'queued');

    await s.client.saveRunners(2);
    await developing(s, b.id);

    await s.client.saveRunners(1);
    assert.equal((await s.client.run(a.id)).status, 'running');
    assert.equal((await s.client.run(b.id)).status, 'running');
    const c = await s.client.startRun(plans[2], 'start-three');
    finish(a.id);
    // One runner is still busy with b, so c keeps waiting.
    await until(
      () => s.client.run(a.id),
      (r) =>
        !['running', 'queued'].includes(r.status) || r.stage !== 'developer',
    );
    assert.equal((await s.client.run(c.id)).status, 'queued');
    finish(b.id);
    await developing(s, c.id);
    finish(c.id);
  } finally {
    await s.close();
  }
});

test('an unconfirmed termination keeps its runner and blocks new starts in the same repository', async () => {
  const { adapter } = gatedAdapter();
  adapter.cancel = async () => false;
  adapter.reconcile = async () => ({ quiescent: false });
  const s = await workflowFixture(adapter);
  try {
    await s.client.saveRunners(2);
    const plans = [await s.issue('one'), await s.issue('two')];
    let a = await s.client.startRun(plans[0], 'start-one');
    a = await developing(s, a.id);
    a = await s.client.command(a.id, {
      action: 'cancel',
      operationId: crypto.randomUUID(),
      expectedRevision: a.revision,
    });
    assert.equal(a.status, 'termination_blocker');
    const b = await s.client.startRun(plans[1], 'start-two');
    assert.equal(b.status, 'queued');
    // A second runner is free, but the blocker's repository stays closed.
    assert.equal((await s.client.workflow()).slots.length, 1);
    assert.equal((await s.client.run(b.id)).status, 'queued');
  } finally {
    await s.close();
  }
});

test('runs recorded with a single legacy slot still count as holding a runner', () => {
  assert.deepEqual(occupiedSlots({ slot: 'run-1' }), ['run-1']);
  assert.deepEqual(occupiedSlots({ slot: '' }), []);
  assert.deepEqual(occupiedSlots({ slots: ['a', 'b'], slot: 'a' }), ['a', 'b']);
  assert.deepEqual(occupiedSlots(undefined), []);
});
