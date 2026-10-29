import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAgUi } from '../apps/server/src/ag-ui.js';
import {
  AgUiViewStream,
  ChatClient,
  conversationView,
  type ConversationSnapshot,
  type ConnectionState,
} from '../packages/shared/src/index.js';
const flush = async () => {
  for (let i = 0; i < 8; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};
const snapshot: ConversationSnapshot = {
  conversation: {
    id: '1',
    projectId: 'default',
    title: 'Test',
    role: 'planning',
    repository: { path: '', github: '' },
    createdAt: '',
    model: { provider: 'requesty', model: 'offline', reasoning: null },
  },
  entries: [],
  partial: '',
  tools: [],
  submissions: [],
  execution: 'idle',
};
/** One connection's worth of standard AG-UI events for a snapshot. */
const frames = (...values: ConversationSnapshot[]) => {
  const stream = new AgUiViewStream('1', 'stream');
  return values
    .map((value) => encodeAgUi(stream.encode(conversationView(value))))
    .join('');
};
const sse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });

test('stream client observes heartbeat traffic, times out silently lost streams, and reconnects from snapshots', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  let calls = 0;
  const fetcher = (async (_url, options) => {
    calls++;
    return sse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
          options?.signal?.addEventListener(
            'abort',
            () => controller.error(new Error('disconnected')),
            { once: true },
          );
        },
      }),
    );
  }) as typeof fetch;
  const client = new ChatClient('', fetcher);
  const states: ConnectionState[] = [];
  let received = 0;
  const stop = client.watch(
    '1',
    () => received++,
    (value) => states.push(value),
  );
  const push = async (value: string) => {
    controllers.at(-1)!.enqueue(new TextEncoder().encode(value));
    await flush();
  };
  try {
    await flush();
    const first = new AgUiViewStream('1', 'stream-1');
    await push(encodeAgUi(first.encode(conversationView(snapshot))));
    assert.equal(received, 1);
    t.mock.timers.tick(44000);
    await flush();
    await push(': heartbeat\n\n');
    t.mock.timers.tick(44000);
    await flush();
    assert.equal(calls, 1);
    t.mock.timers.tick(1001);
    await flush();
    assert.equal(states.at(-1), 'disconnected');
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(calls, 2);
    await push(frames(snapshot));
    assert.equal(received, 2);
    assert.equal(states.at(-1), 'connected');
    stop();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(calls, 2);
  } finally {
    stop();
    t.mock.timers.reset();
  }
});

test('a closed stream reconnects from a fresh snapshot; unsupported versions stop with an explicit error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0,
    versions = 0;
  const fetcher = (async () => {
    calls++;
    const view = conversationView(snapshot);
    const body =
      calls === 1
        ? frames(snapshot)
        : encodeAgUi(
            new AgUiViewStream('1', 'next').encode({
              ...view,
              state: {
                factory: { ...view.state.factory, apiVersion: 'v2' as 'v1' },
              },
            }),
          );
    return sse(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          if (calls === 1) controller.close();
        },
      }),
    );
  }) as typeof fetch;
  const client = new ChatClient('', fetcher);
  const stop = client.watch(
    '1',
    () => {},
    () => {},
    (error) => {
      if ('code' in error && error.code === 'UNSUPPORTED_VERSION') versions++;
    },
  );
  try {
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(calls, 2);
    assert.equal(versions, 1);
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(calls, 2);
  } finally {
    stop();
    t.mock.timers.reset();
  }
});

test('a stalled snapshot consumer is cancelled by the stream watchdog', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0,
    cancelled = 0;
  const fetcher = (async () => {
    calls++;
    return sse(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames(snapshot)));
        },
      }),
    );
  }) as typeof fetch;
  const client = new ChatClient('', fetcher);
  const stop = client.watch(
    '1',
    (_snapshot, info) =>
      new Promise<void>((_resolve, reject) => {
        info.signal.addEventListener(
          'abort',
          () => {
            cancelled++;
            reject(new Error('Cancelled backfill'));
          },
          { once: true },
        );
      }),
    () => {},
  );
  try {
    await flush();
    assert.equal(calls, 1);
    t.mock.timers.tick(45000);
    await flush();
    assert.equal(cancelled, 1);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(calls, 2);
  } finally {
    stop();
    await flush();
    t.mock.timers.reset();
  }
});
