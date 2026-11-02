import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient } from '../packages/shared/src/index.js';
import { open } from './helpers/sse.js';
import { workflowFixture } from './fixtures/workflow.js';

const titles = (frame?: { data?: { conversations: { title: string }[] } }) =>
  frame?.data?.conversations.map((c) => c.title);

/** The first frame within a while that satisfies `match`. */
async function until(
  stream: ReturnType<typeof open>,
  match: (data: any) => boolean,
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const frame = await stream.next(500);
    if (frame && match(frame.data)) return frame;
  }
  return undefined;
}

test('the project stream starts with runs, deletions and conversations, then pushes each change', async () => {
  const s = await workflowFixture();
  try {
    const stream = open(s.service.url, '/api/v1/events');
    const first = await stream.next(3000);
    assert.equal(first?.data.type, 'snapshot');
    assert.deepEqual(first?.data.snapshot.runs, []);
    assert.deepEqual(first?.data.deletions, []);
    assert.deepEqual(first?.data.conversations, []);
    // Nothing changes, so nothing is sent.
    assert.equal(await stream.next(600), undefined);

    const extra = await s.chat.createConversation('Pushed', 'push-1');
    const created = await stream.next(1000);
    assert.equal(created?.data.type, 'update');
    assert.deepEqual(titles(created), ['Pushed']);

    const plan = await s.issue('push-run');
    await s.client.startRun(plan, 'push-start');
    assert.ok(
      await until(stream, (data) => data.snapshot.runs.length > 0),
      'a started run reaches the stream',
    );

    await s.chat.deleteConversation(extra.id);
    assert.ok(
      await until(stream, (data) => data.deletions.length > 0),
      'a deletion reaches the stream',
    );
    stream.close();
  } finally {
    await s.close();
  }
});

test('the project stream resumes from the id of the state a client holds', async () => {
  const s = await workflowFixture();
  try {
    const fresh = open(s.service.url, '/api/v1/events');
    const first = await fresh.next(3000);
    fresh.close();

    const resumed = open(s.service.url, '/api/v1/events', first!.id);
    assert.equal(await resumed.opened(1500), true);
    assert.equal(await resumed.next(500), undefined, 'nothing has changed');
    // A conversation leaves the revision of the runs alone, but changes the id.
    await s.chat.createConversation('After', 'resume-1');
    const change = await resumed.next(2000);
    resumed.close();
    assert.equal(change?.data.type, 'snapshot', 'the next frame stands alone');
    assert.deepEqual(titles(change), ['After']);
    assert.notEqual(change?.id, first?.id);

    const current = open(s.service.url, '/api/v1/events', change!.id);
    assert.equal(await current.next(500), undefined);
    current.close();
    const stale = open(s.service.url, '/api/v1/events', first!.id);
    const resent = await stale.next(3000);
    stale.close();
    assert.deepEqual(titles(resent), ['After']);
  } finally {
    await s.close();
  }
});

test('a project stream shows only the conversations of its project', async () => {
  const s = await workflowFixture();
  try {
    const other = await s.chat.createProject('Other');
    const scoped = new ChatClient(s.service.url, undefined, other.id);
    await s.chat.createConversation('In default', 'scope-default');
    await scoped.createConversation('In other', 'scope-other');
    const all = open(s.service.url, '/api/v1/events');
    const mine = open(s.service.url, `/api/v1/projects/${other.id}/events`);
    const [everything, own] = [await all.next(3000), await mine.next(3000)];
    assert.deepEqual(titles(everything)?.sort(), ['In default', 'In other']);
    assert.deepEqual(titles(own), ['In other']);
    all.close();
    mine.close();
  } finally {
    await s.close();
  }
});

test('stopping the service ends open project streams', async () => {
  const s = await workflowFixture();
  const stream = open(s.service.url, '/api/v1/events');
  const legacy = open(s.service.url, '/api/v1/runs/events');
  try {
    assert.ok(await stream.next(3000));
    assert.ok(await legacy.next(3000));
    const closing = s.service.close();
    assert.equal(await stream.ended(3000), true);
    assert.equal(await legacy.ended(3000), true);
    await closing;
  } finally {
    stream.close();
    legacy.close();
    await s.close();
  }
});
