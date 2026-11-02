import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, type Message } from './helpers/sse.js';
import { workflowFixture } from './fixtures/workflow.js';
import { lastEventId } from '../apps/server/src/sse.js';
import { simulationAdapter } from '../apps/server/src/workflow.js';

test('a resumed stream is open at once, even though it has nothing to send yet', async () => {
  const s = await workflowFixture();
  try {
    const fresh = open(s.service.url, '/api/v1/runs/events');
    const first = await fresh.next(3000);
    fresh.close();
    // Nothing changes, so the first write would be a heartbeat 15 seconds away.
    const resumed = open(s.service.url, '/api/v1/runs/events', first!.id);
    assert.equal(await resumed.opened(1500), true);
    assert.equal(await resumed.next(200), undefined);
    resumed.close();
  } finally {
    await s.close();
  }
});

test('the Last-Event-ID header is read as given, and ignored when empty or oversized', () => {
  const read = (value: string | undefined) =>
    lastEventId({ headers: { 'last-event-id': value } } as never);
  assert.equal(read('42'), '42');
  assert.equal(read(''), undefined);
  assert.equal(read(undefined), undefined);
  assert.equal(read('x'.repeat(129)), undefined);
});

/** A workflow id is the stored revision, then a fingerprint of the status. */
const revisionOf = (message?: Message) => Number(message?.id?.split('.')[0]);

test('the workflow stream labels frames with the revision and skips a snapshot the client already holds', async () => {
  const s = await workflowFixture();
  try {
    const fresh = open(s.service.url, '/api/v1/runs/events');
    const first = await fresh.next(3000);
    fresh.close();
    assert.equal(first?.data.type, 'snapshot');
    assert.equal(first?.data.sequence, 1);
    assert.equal(revisionOf(first), first?.data.snapshot.revision);

    const resumed = open(s.service.url, '/api/v1/runs/events', first!.id);
    assert.equal(await resumed.next(500), undefined, 'nothing has changed');
    const conversation = await s.issue();
    await s.client.startRun(conversation, 'resume-run');
    const change = await resumed.next(5000);
    resumed.close();
    assert.equal(change?.data.type, 'snapshot', 'the next frame stands alone');
    assert.equal(change?.data.sequence, 1);
    assert.ok(revisionOf(change) > revisionOf(first));
    assert.equal(revisionOf(change), change?.data.snapshot.revision);

    // The simulated run keeps advancing, so the live revision is at least this.
    const current = revisionOf(change);
    const ahead = String(current + 1000);
    for (const held of [String(current - 1), ahead, 'abc', '']) {
      const stale = open(s.service.url, '/api/v1/runs/events', held);
      const frame = await stale.next(3000);
      stale.close();
      assert.equal(frame?.data.type, 'snapshot', `resume from "${held}"`);
      assert.equal(frame?.data.sequence, 1, `resume from "${held}"`);
      assert.ok(frame?.data.snapshot.revision >= current, `from "${held}"`);
    }
  } finally {
    await s.close();
  }
});

test('a workflow status change that leaves the stored revision alone still reaches live and resumed clients', async () => {
  let missing = ['credentials'];
  const s = await workflowFixture({
    ...simulationAdapter(),
    available: async () => missing,
  });
  try {
    const live = open(s.service.url, '/api/v1/runs/events');
    const first = await live.next(3000);
    assert.equal(first?.data.snapshot.enabled, false);
    assert.deepEqual(first?.data.snapshot.missingPrerequisites, [
      'credentials',
    ]);

    missing = [];
    const update = await live.next(3000);
    live.close();
    assert.equal(update?.data.snapshot.enabled, true);
    assert.equal(revisionOf(update), revisionOf(first), 'no stored change');
    assert.notEqual(update?.id, first?.id);

    // A client that last saw the old status is sent the new one.
    const stale = open(s.service.url, '/api/v1/runs/events', first!.id);
    const resent = await stale.next(3000);
    stale.close();
    assert.equal(resent?.data.snapshot.enabled, true);
    assert.equal(resent?.id, update?.id);
    // A client that already holds the new status is not sent it again.
    const current = open(s.service.url, '/api/v1/runs/events', update!.id);
    assert.equal(await current.next(500), undefined);
    current.close();
  } finally {
    await s.close();
  }
});

test('AG-UI streams carry no SSE ids, so a reconnect always starts from a fresh snapshot', async () => {
  const s = await workflowFixture();
  try {
    const conversation = await s.issue();
    const stream = open(
      s.service.url,
      `/api/v1/conversations/${conversation}/ag-ui/events`,
      'anything',
    );
    const first = await stream.next(3000);
    stream.close();
    assert.ok(first, 'the snapshot is sent');
    assert.equal(first.id, undefined);
  } finally {
    await s.close();
  }
});
