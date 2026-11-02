import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient } from '../packages/shared/src/index.js';
import { open } from './helpers/sse.js';
import { workflowFixture } from './fixtures/workflow.js';
import { until } from './fixtures/chat.js';

type Fixture = Awaited<ReturnType<typeof workflowFixture>>;

/** Subscribes the stream the way the web app does. */
async function subscribe(
  s: Fixture,
  streamId: string | undefined,
  channels: unknown,
  { csrf = true, base = '' } = {},
) {
  const session = (await (
    await fetch(`${s.service.url}/api/v1/session`)
  ).json()) as { csrfToken: string };
  const response = await fetch(
    `${s.service.url}/api/v1${base}/events/${streamId}/subscriptions`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-Factory-CSRF': session.csrfToken } : {}),
      },
      body: JSON.stringify({ channels }),
    },
  );
  return { status: response.status, body: await response.json() };
}

const channelOf = (
  message: { event?: string; data?: { channel: string } } | undefined,
  channel: string,
) => message?.event === 'channel' && message.data?.channel === channel;

/** The channel's messages that arrive within a while. */
async function collect(
  stream: ReturnType<typeof open>,
  channel: string,
  wait = 800,
) {
  const out: { data?: string; end?: boolean; error?: string }[] = [];
  for (
    let message = await stream.next(wait);
    message;
    message = await stream.next(wait)
  )
    if (channelOf(message, channel)) out.push(message.data);
  return out;
}

async function started() {
  const s = await workflowFixture();
  const conversation = await s.chat.createConversation('Followed', 'chan-1');
  const stream = open(s.service.url, '/api/v1/events');
  assert.ok(await stream.next(3000));
  return { s, conversation, stream, id: stream.streamId! };
}

test('a subscribed chat arrives over the project stream, then its changes', async () => {
  const { s, conversation, stream, id } = await started();
  try {
    const channel = `chat:${conversation.id}`;
    assert.deepEqual(await subscribe(s, id, [channel]), {
      status: 200,
      body: { channels: [channel] },
    });
    const first = await stream.next(3000);
    assert.ok(channelOf(first, channel));
    assert.equal(first?.id, undefined, 'a channel has no resume version');
    assert.match(first?.data.data, /^data: /, 'the AG-UI text is verbatim');
    assert.match(first?.data.data, /RUN_STARTED/);

    await s.chat.submit(conversation.id, 'hello', 'chan-submit');
    const more = await collect(stream, channel, 1500);
    assert.ok(more.length > 0, 'a change reaches the channel');
    stream.close();
  } finally {
    await s.close();
  }
});

test('a subscribed run activity arrives over the project stream', async () => {
  const { s, stream, id } = await started();
  try {
    const plan = await s.issue('chan-run');
    const run = await s.client.startRun(plan, 'chan-start');
    const channel = `activity:${run.id}`;
    assert.equal((await subscribe(s, id, [channel])).status, 200);
    let seen = false;
    for (let i = 0; i < 20 && !seen; i++)
      seen = channelOf(await stream.next(500), channel);
    assert.ok(seen, 'the activity snapshot arrives');
    stream.close();
  } finally {
    await s.close();
  }
});

test('replacing the set stops removed channels and keeps the others running', async () => {
  const { s, conversation, stream, id } = await started();
  try {
    const other = await s.chat.createConversation('Other', 'chan-2');
    const [a, b] = [`chat:${conversation.id}`, `chat:${other.id}`];
    await subscribe(s, id, [a, b]);
    const firsts = await collect(stream, a, 1000);
    assert.ok(firsts.length > 0);

    await subscribe(s, id, [a]);
    await s.chat.submit(other.id, 'quiet', 'chan-quiet');
    await s.chat.submit(conversation.id, 'loud', 'chan-loud');
    let seenA = false,
      seenB = false,
      snapshotAgain = false;
    for (let i = 0; i < 30; i++) {
      const message = await stream.next(300);
      if (!message) continue;
      if (channelOf(message, a)) {
        seenA = true;
        snapshotAgain ||= /RUN_STARTED/.test(message.data.data);
      }
      if (channelOf(message, b)) seenB = true;
    }
    assert.ok(seenA, 'the kept channel carries on');
    assert.equal(snapshotAgain, false, 'and is not restarted');
    assert.equal(seenB, false, 'the removed channel is silent');
    stream.close();
  } finally {
    await s.close();
  }
});

test('subscriptions are checked', async () => {
  const { s, conversation, stream, id } = await started();
  try {
    const channel = `chat:${conversation.id}`;
    assert.equal((await subscribe(s, 'nope', [channel])).status, 404);
    assert.equal((await subscribe(s, id, ['chat:99999'])).status, 404);
    assert.equal((await subscribe(s, id, ['activity:missing'])).status, 404);
    assert.equal((await subscribe(s, id, ['chat:../x'])).status, 400);
    const many = Array.from({ length: 9 }, (_, i) => `chat:${i}`);
    assert.equal((await subscribe(s, id, many)).status, 400);
    const bare = await subscribe(s, id, [channel], { csrf: false });
    assert.equal(bare.status, 403);

    const other = await s.chat.createProject('Other');
    const scoped = open(s.service.url, `/api/v1/projects/${other.id}/events`);
    assert.ok(await scoped.next(3000));
    const base = `/projects/${other.id}`;
    const outside = await subscribe(s, scoped.streamId, [channel], { base });
    assert.equal(outside.status, 404, 'a chat of another project');
    const inside = await new ChatClient(
      s.service.url,
      undefined,
      other.id,
    ).createConversation('Inside', 'chan-in');
    const own = await subscribe(s, scoped.streamId, [`chat:${inside.id}`], {
      base,
    });
    assert.equal(own.status, 200);
    scoped.close();
    stream.close();
  } finally {
    await s.close();
  }
});

test('closing the project stream stops its channels, and stopping the service ends them', async () => {
  const { s, conversation, stream, id } = await started();
  try {
    await subscribe(s, id, [`chat:${conversation.id}`]);
    assert.ok(await stream.next(3000));
    stream.close();
    await until(
      async () => (await subscribe(s, id, [])).status,
      (status) => status === 404,
    );
    const again = open(s.service.url, '/api/v1/events');
    assert.ok(await again.next(3000));
    await subscribe(s, again.streamId, [`chat:${conversation.id}`]);
    assert.ok(await again.next(3000));
    const closing = s.service.close();
    assert.equal(await again.ended(3000), true);
    await closing;
  } finally {
    await s.close();
  }
});

test('channel traffic leaves the project frames and their resume ids alone', async () => {
  const { s, conversation, stream, id } = await started();
  try {
    await subscribe(s, id, [`chat:${conversation.id}`]);
    await s.chat.createConversation('Later', 'chan-later');
    let frame;
    for (let i = 0; i < 20 && !frame; i++) {
      const message = await stream.next(300);
      if (message?.event !== 'channel' && message?.id) frame = message;
    }
    assert.ok(frame?.id, 'project frames keep their id');
    stream.close();
    const resumed = open(s.service.url, '/api/v1/events', frame.id);
    assert.equal(await resumed.opened(1500), true);
    assert.equal(await resumed.next(600), undefined, 'nothing is resent');
    resumed.close();
  } finally {
    await s.close();
  }
});
