import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatClient,
  EventHub,
  WorkflowClient,
  type ConversationSnapshot,
} from '../packages/shared/src/index.js';
import { workflowFixture } from './fixtures/workflow.js';
import { until } from './fixtures/chat.js';

const encoder = new TextEncoder();

/** A service that streams only what the test pushes, and records every
 * subscription it is sent. */
function fakeService() {
  const puts: { streamId: string; channels: string[] }[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/session'))
      return Response.json({ apiVersion: 'v1', csrfToken: 'token' });
    const put = /\/events\/([^/]+)\/subscriptions$/.exec(url);
    if (put) {
      const { channels } = JSON.parse(String(init?.body));
      puts.push({ streamId: put[1], channels });
      return Response.json({ channels });
    }
    const index = streams.length;
    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => void streams.push(controller),
      }),
      { headers: { 'X-Factory-Stream-Id': `stream-${index + 1}` } },
    );
  };
  const hub = new EventHub(new WorkflowClient('http://service', fetcher));
  const frame = (channel: string, extra: object) =>
    `event: channel\ndata: ${JSON.stringify({ channel, ...extra })}\n\n`;
  return {
    hub,
    puts,
    send: (text: string, stream = streams.length - 1) =>
      streams[stream].enqueue(encoder.encode(text)),
    data: (channel: string, text: string, stream?: number) =>
      streams[stream ?? streams.length - 1].enqueue(
        encoder.encode(frame(channel, { data: text })),
      ),
    end: (channel: string, extra: object = {}) =>
      streams[streams.length - 1].enqueue(
        encoder.encode(frame(channel, { end: true, ...extra })),
      ),
    drop: () => streams[streams.length - 1].close(),
    async connected(count = 1) {
      await until(
        async () => streams.length,
        (open) => open >= count,
      );
    },
  };
}

const watch = (hub: EventHub) =>
  hub.watch(
    () => {},
    () => {},
  );
const read = async (response: Response) => {
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  return chunk.done ? undefined : new TextDecoder().decode(chunk.value);
};
/** Reads a response to its end. */
async function drain(response: Response) {
  const reader = response.body!.getReader();
  while (!(await reader.read()).done);
}

test('the hub subscribes channels and routes each one its own text', async () => {
  const fake = fakeService();
  const stop = watch(fake.hub);
  try {
    await fake.connected();
    const [one, two] = await Promise.all([
      fake.hub.channel('chat:1')('http://x'),
      fake.hub.channel('chat:2')('http://x'),
    ]);
    await until(
      async () => fake.puts.length,
      (count) => count > 0,
    );
    assert.deepEqual(fake.puts.at(-1), {
      streamId: 'stream-1',
      channels: ['chat:1', 'chat:2'],
    });
    fake.data('chat:2', 'data: for two\n\n');
    fake.data('chat:1', 'data: for one\n\n');
    // Whatever else arrives, each channel sees only its own text.
    const text = async (response: Response) => {
      let all = '';
      while (!all.includes('for')) all += await read(response);
      return all.replaceAll(': heartbeat\n\n', '');
    };
    assert.equal(await text(one), 'data: for one\n\n');
    assert.equal(await text(two), 'data: for two\n\n');
  } finally {
    stop();
  }
});

test('aborting a channel unsubscribes it', async () => {
  const fake = fakeService();
  const stop = watch(fake.hub);
  try {
    await fake.connected();
    const abort = new AbortController();
    const first = await fake.hub.channel('chat:1')('http://x', {
      signal: abort.signal,
    });
    await fake.hub.channel('chat:2')('http://x');
    await until(
      async () => fake.puts.at(-1)?.channels.length,
      (count) => count === 2,
    );
    abort.abort();
    await until(
      async () => fake.puts.at(-1)?.channels.join(),
      (channels) => channels === 'chat:2',
    );
    await assert.rejects(read(first));
  } finally {
    stop();
  }
});

test('a reconnect brings a new stream and the channels subscribe to it again', async () => {
  const fake = fakeService();
  const stop = watch(fake.hub);
  try {
    await fake.connected();
    const before = await fake.hub.channel('chat:1')('http://x');
    await until(
      async () => fake.puts.length,
      (count) => count > 0,
    );
    fake.drop();
    await assert.rejects(read(before), 'the channel ends with its connection');
    // The loop reconnects with jitter. The observer then opens its channel
    // again, and the new stream is told of it.
    await fake.connected(2);
    await fake.hub.channel('chat:1')('http://x');
    await until(
      async () => fake.puts.at(-1)?.streamId,
      (id) => id === 'stream-2',
    );
    assert.deepEqual(fake.puts.at(-1)?.channels, ['chat:1']);
  } finally {
    stop();
  }
});

test('a channel the service ended is subscribed again when it is reopened', async () => {
  const fake = fakeService();
  const stop = watch(fake.hub);
  try {
    await fake.connected();
    const first = await fake.hub.channel('chat:1')('http://x');
    await until(
      async () => fake.puts.length,
      (count) => count === 1,
    );
    fake.end('chat:1');
    await drain(first);
    await fake.hub.channel('chat:1')('http://x');
    await until(
      async () => fake.puts.length,
      (count) => count === 2,
    );
    assert.deepEqual(fake.puts.at(-1)?.channels, ['chat:1']);

    // A failed channel errors its reader instead.
    const second = await fake.hub.channel('chat:1')('http://x');
    fake.end('chat:1', { error: 'The stream failed.' });
    await assert.rejects(drain(second), /The stream failed\./);
  } finally {
    stop();
  }
});

test('opening a channel that is already carried restarts it', async () => {
  const fake = fakeService();
  const stop = watch(fake.hub);
  try {
    await fake.connected();
    await fake.hub.channel('chat:1')('http://x');
    await fake.hub.channel('chat:2')('http://x');
    await until(
      async () => fake.puts.length,
      (count) => count === 1,
    );
    await fake.hub.channel('chat:1')('http://x');
    await until(
      async () => fake.puts.length,
      (count) => count === 3,
    );
    // Dropped for a moment so that the service starts it afresh, then back.
    assert.deepEqual(
      fake.puts.slice(1).map((put) => put.channels),
      [['chat:2'], ['chat:1', 'chat:2']],
    );
  } finally {
    stop();
  }
});

test('project heartbeats reach every channel as comments', async () => {
  const fake = fakeService();
  const stop = watch(fake.hub);
  try {
    await fake.connected();
    const response = await fake.hub.channel('chat:1')('http://x');
    fake.send('event: heartbeat\ndata: {}\n\n');
    assert.equal(await read(response), ': heartbeat\n\n');
  } finally {
    stop();
  }
});

test('observers follow a chat through the hub alone', async () => {
  const s = await workflowFixture();
  const conversation = await s.chat.createConversation('Hub', 'hub-1');
  const hub = new EventHub(new WorkflowClient(s.service.url));
  const stop = watch(hub);
  const views: ConversationSnapshot[] = [];
  const unwatch = new ChatClient(s.service.url).watch(
    conversation.id,
    (value) => void views.push(value),
    () => {},
    undefined,
    hub,
  );
  try {
    await until(
      async () => views.length,
      (count) => count > 0,
    );
    assert.equal(views[0].conversation.id, conversation.id);
    const seen = views.length;
    await s.chat.submit(conversation.id, 'hello', 'hub-submit');
    await until(
      async () => views.length,
      (count) => count > seen,
    );
  } finally {
    unwatch();
    stop();
    await s.close();
  }
});

test('after the project stream drops, an observed chat gets a fresh snapshot', async () => {
  const s = await workflowFixture();
  const conversation = await s.chat.createConversation('Drop', 'hub-drop');
  const live = new Set<AbortController>();
  const hub = new EventHub(
    new WorkflowClient(s.service.url, (input, init) => {
      const cut = new AbortController();
      live.add(cut);
      return fetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, cut.signal])
          : cut.signal,
      });
    }),
  );
  const stop = watch(hub);
  const types: string[] = [];
  const unwatch = new ChatClient(s.service.url).watch(
    conversation.id,
    (_value, frame) => void types.push(frame.type),
    () => {},
    undefined,
    hub,
  );
  try {
    await until(
      async () => types.length,
      (count) => count > 0,
    );
    for (const cut of live) cut.abort();
    await until(
      async () => types.filter((type) => type === 'snapshot').length,
      (count) => count === 2,
    );
  } finally {
    unwatch();
    stop();
    await s.close();
  }
});
