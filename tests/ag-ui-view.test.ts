import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeAgUi } from '../apps/server/src/ag-ui.js';
import { EventSchema } from '@ag-ui/core/schemas';
import {
  AgUiMessageStream,
  AgUiViewStream,
  conversationFromAgUi,
  conversationView,
  diffState,
  observeAgUi,
} from '../packages/shared/src/ag-ui-view.js';
import type {
  ConversationSnapshot,
  TranscriptEntry,
} from '../packages/shared/src/chat.js';

const conversation = {
  id: '7',
  projectId: 'p',
  title: 'Chat',
  role: 'planning',
  repository: { path: '/r', github: 'o/r' },
  createdAt: '2026-01-01T00:00:00.000Z',
  model: { provider: null, model: '', reasoning: null },
} as unknown as ConversationSnapshot['conversation'];
const snapshot = (
  patch: Partial<ConversationSnapshot> = {},
): ConversationSnapshot => ({
  conversation,
  entries: [],
  partial: '',
  tools: [],
  submissions: [],
  execution: 'idle',
  ...patch,
});
const user: TranscriptEntry = {
  id: '1',
  kind: 'pi.user',
  text: 'Hello',
  at: 10,
  tools: [],
  messageId: 'client-message',
};
const call: TranscriptEntry = {
  id: '2',
  kind: 'pi.assistant',
  text: 'Let me look.',
  at: 11,
  tools: [
    {
      id: 'call_1',
      name: 'read',
      arguments: '{"path":"a"}',
      status: 'pending',
    },
  ],
};
const result: TranscriptEntry = {
  id: '3',
  kind: 'pi.tool-result',
  text: '',
  at: 12,
  tools: [
    {
      id: 'call_1',
      name: 'read',
      output: 'file body',
      status: 'completed',
      artifact: 'entry-3',
      truncated: true,
    },
  ],
};
const answer: TranscriptEntry = {
  id: '4',
  kind: 'pi.assistant',
  text: 'Done reading.',
  at: 13,
  interrupted: true,
  tools: [],
};

test('conversation views round trip through messages and state', () => {
  const original = snapshot({
    entries: [user, call, result, answer],
    partial: 'Thinking',
    tools: [{ id: 'live_1', name: 'bash', status: 'running', output: 'x' }],
    olderCursor: 'abc',
  });
  const view = conversationView(original);
  assert.deepEqual(
    conversationFromAgUi(view.messages, view.state),
    JSON.parse(JSON.stringify(original)),
  );
});

test('the message stream sends appends and token growth as standard deltas, otherwise snapshots', () => {
  const stream = new AgUiMessageStream();
  const view = (s: Partial<ConversationSnapshot>) =>
    conversationView(snapshot(s)).messages;
  const kinds = (events: { type: string }[]) => events.map((e) => e.type);
  assert.deepEqual(kinds(stream.update(view({ entries: [user] }))), [
    'MESSAGES_SNAPSHOT',
  ]);
  assert.deepEqual(
    kinds(stream.update(view({ entries: [user], partial: 'Hi' }))),
    ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT'],
  );
  assert.deepEqual(
    kinds(stream.update(view({ entries: [user], partial: 'Hi there' }))),
    ['TEXT_MESSAGE_CONTENT'],
  );
  // The generation commits: its live slot closes and the snapshot replaces it.
  assert.deepEqual(
    kinds(stream.update(view({ entries: [user, { ...answer, id: '2' }] }))),
    ['TEXT_MESSAGE_END', 'MESSAGES_SNAPSHOT'],
  );
  assert.deepEqual(
    kinds(
      stream.update(view({ entries: [user, { ...answer, id: '2' }, call] })),
    ),
    [
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
    ],
  );
  assert.deepEqual(
    stream.update(view({ entries: [user, { ...answer, id: '2' }, call] })),
    [],
  );
});

test('state deltas are valid JSON patches', () => {
  assert.deepEqual(
    diffState(
      { a: 1, b: { c: [1], d: 'x' }, gone: true },
      { a: 1, b: { c: [1, 2], d: 'x' }, added: { 'k/ey': 1 } },
    ),
    [
      { op: 'remove', path: '/gone' },
      { op: 'replace', path: '/b/c', value: [1, 2] },
      { op: 'add', path: '/added', value: { 'k/ey': 1 } },
    ],
  );
});

test('an SDK observer rebuilds each snapshot from a valid standard event stream', async () => {
  const frames: ConversationSnapshot[] = [
    snapshot({ entries: [user] }),
    snapshot({ entries: [user], partial: 'Let', execution: 'running' }),
    snapshot({
      entries: [user],
      partial: 'Let me look.',
      execution: 'running',
    }),
    snapshot({
      entries: [user, call],
      tools: [
        {
          id: 'call_1',
          name: 'read',
          arguments: '{"path":"a"}',
          status: 'running',
        },
      ],
      execution: 'running',
    }),
    snapshot({ entries: [user, call, result], execution: 'running' }),
    snapshot({ entries: [user, call, result, answer] }),
  ];
  const server = createServer((req, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const stream = new AgUiViewStream('7', 'run');
    for (const frame of frames) {
      const events = stream.encode(conversationView(frame));
      // Every event must satisfy the official schemas.
      for (const event of events) EventSchema.parse(event);
      res.write(encodeAgUi(events));
    }
    res.write(': heartbeat\n\n');
    setTimeout(() => res.end(), 200);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const seen: { type: string; view: ConversationSnapshot }[] = [];
  const stop = observeAgUi({
    url: `http://127.0.0.1:${port}/events`,
    threadId: '7',
    fetcher: fetch,
    project: conversationFromAgUi,
    onView: (view, frame) => void seen.push({ type: frame.type, view }),
    onConnection: () => {},
    onError: (error) => assert.fail(error.message),
  });
  try {
    for (let i = 0; i < 100 && seen.length < frames.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      seen.map((item) => item.type),
      ['snapshot', ...frames.slice(1).map(() => 'update')],
    );
    assert.deepEqual(
      seen.map((item) => item.view),
      frames.map((frame) => JSON.parse(JSON.stringify(frame))),
    );
  } finally {
    stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
