import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpAgent, type BaseEvent } from '@ag-ui/client';
import { EventSchema } from '@ag-ui/core/schemas';
import { startService } from './helpers/credentials.js';
import {
  ChatClient,
  agUiMessages,
  AgUiViewStream,
  conversationView,
  type ConversationSnapshot,
  type TranscriptEntry,
} from '../packages/shared/src/index.js';
import { fixture, configure, until } from './fixtures/chat.js';
import { fauxAssistantMessage } from '../apps/server/src/chat-fixtures.js';
import { context } from '../apps/server/src/storage.js';

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-ag-ui-regression-'));
  const deps = fixture();
  const service = await startService({ dataDir, port: 0, chat: deps });
  const client = new ChatClient(service.url);
  await configure(client);
  const conversation = await client.createConversation(
    'AG-UI regressions',
    'create',
  );
  const session = await (await fetch(`${service.url}/api/v1/session`)).json();
  const headers = {
    'Content-Type': 'application/json',
    'X-Factory-CSRF': session.csrfToken,
  };
  return {
    deps,
    service,
    client,
    conversation,
    headers,
    async agent(content: string, messageId: string) {
      const entries: TranscriptEntry[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.chat!.history(conversation.id, cursor, 100);
        entries.unshift(...page.entries);
        cursor = page.cursor;
      } while (cursor);
      return new HttpAgent({
        url: `${service.url}/api/v1/ag-ui/run`,
        threadId: conversation.id,
        headers,
        initialMessages: [
          ...agUiMessages(conversation.id, entries),
          { id: messageId, role: 'user', content },
        ],
      });
    },
    async close() {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('completion after snapshot capture still delivers the final reply before RUN_FINISHED', async (t) => {
  const f = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.deps.faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage('The complete final reply');
    },
  ]);
  const lookup = f.service.chat!.lookup.bind(f.service.chat!);
  let calls = 0;
  t.mock.method(
    f.service.chat!,
    'lookup',
    async (id: string, requestId: string) => {
      if (++calls === 3) {
        release();
        await until(
          () => lookup(id, requestId),
          (value) => value.status === 'completed',
        );
      }
      return lookup(id, requestId);
    },
  );
  try {
    const agent = await f.agent('Reply please', 'race-message');
    const events: BaseEvent[] = [];
    await agent.runAgent(
      { runId: 'race-run' },
      {
        onEvent: ({ event }) => {
          EventSchema.parse(event);
          events.push(event);
        },
      },
    );
    assert.equal(events.at(-1)?.type, 'RUN_FINISHED');
    assert.ok(
      agent.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content === 'The complete final reply',
      ),
    );
    assert.ok(
      events
        .slice(0, -1)
        .some(
          (event) =>
            event.type === 'TEXT_MESSAGE_CONTENT' &&
            'delta' in event &&
            event.delta === 'The complete final reply',
        ),
    );
  } finally {
    release();
    await f.close();
  }
});

test('a standard client retains history beyond the fifty-entry observation window', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 55; i++) {
      await f.client.submit(f.conversation.id, `Turn ${i}`, `turn-${i}`);
      await until(
        () => f.client.submission(f.conversation.id, `turn-${i}`),
        (value) => value.status === 'completed',
      );
    }
    const agent = await f.agent('Latest turn', 'latest-message');
    const originals = [...agent.messages];
    assert.ok(originals.length > 100);
    await agent.runAgent({ runId: 'latest-run' });
    for (const message of originals)
      assert.ok(
        agent.messages.some(
          (current) =>
            current.id === message.id && current.content === message.content,
        ),
        `Lost message ${message.id}`,
      );
    assert.ok(
      agent.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content === 'Offline reply: Latest turn',
      ),
    );
  } finally {
    await f.close();
  }
});

test('new exchanges hydrate prior text and tools without replaying generation callbacks', async () => {
  const f = await setup();
  try {
    await f.client.submit(f.conversation.id, 'use tool', 'old-turn');
    await until(
      () => f.client.submission(f.conversation.id, 'old-turn'),
      (value) => value.status === 'completed',
    );
    const agent = await f.agent('A new turn', 'new-message');
    const events: BaseEvent[] = [];
    await agent.runAgent(
      { runId: 'new-run' },
      {
        onEvent: ({ event }) => {
          EventSchema.parse(event);
          events.push(event);
        },
      },
    );
    assert.ok(agent.messages.some((message) => message.role === 'tool'));
    assert.ok(
      agent.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content === 'Offline reply: use tool',
      ),
    );
    assert.ok(
      !events.some((event) => event.type.startsWith('TOOL_CALL_')),
      'Replayed a completed historical tool',
    );
    const deltas = events
      .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => ('delta' in event ? event.delta : ''));
    assert.equal(deltas.join(''), 'Offline reply: A new turn');
  } finally {
    await f.close();
  }
});

test('byte-bounded observation windows cannot truncate a large standard-client transcript', async () => {
  const f = await setup();
  try {
    const text = '😀'.repeat(16000);
    await f.service.workflow['harness'].commit(async (tx) => {
      for (let i = 0; i < 20; i++)
        await tx.appendEntry(Number(f.conversation.id) as never, {
          kind: 'factory.workflow',
          data: { text: `${i}:${text}` },
        });
    }, context);
    const agent = await f.agent('After large history', 'large-history-message');
    const originals = [...agent.messages];
    assert.ok(Buffer.byteLength(JSON.stringify(originals)) > 1024 * 1024);
    await agent.runAgent({ runId: 'large-history-run' });
    for (const message of originals)
      assert.ok(
        agent.messages.some(
          (current) =>
            current.id === message.id && current.content === message.content,
        ),
        `Lost or corrupted ${message.id}`,
      );
    assert.ok(
      agent.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content === 'Offline reply: After large history',
      ),
    );
  } finally {
    await f.close();
  }
});

test('live text streams once and its committed replacement preserves earlier messages', () => {
  const history: TranscriptEntry[] = [
    { id: '1', kind: 'pi.assistant', text: 'Earlier reply', tools: [] },
  ];
  const snapshot: ConversationSnapshot = {
    conversation: {
      id: '1',
      projectId: 'default',
      title: 'Streaming',
      role: 'planning',
      repository: { path: '', github: '' },
      createdAt: '',
      model: { provider: 'requesty', model: 'offline', reasoning: null },
    },
    entries: history,
    tools: [],
    partial: 'New',
    submissions: [],
    execution: 'running',
  };
  const stream = new AgUiViewStream('1', 'live-run', { frames: false });
  const update = (value: typeof snapshot) =>
    stream.encode(conversationView(value));
  const first = update(snapshot);
  const next = update({ ...snapshot, partial: 'New reply' });
  assert.ok(
    !next.some((event) => event.type === 'MESSAGES_SNAPSHOT'),
    'Token deltas should not resend the full transcript',
  );
  const final = update({
    ...snapshot,
    partial: '',
    execution: 'idle',
    entries: [
      ...history,
      { id: '2', kind: 'pi.assistant', text: 'New reply finished', tools: [] },
    ],
  });
  const events = [...first, ...next, ...final];
  for (const event of events) EventSchema.parse(event);
  assert.equal(
    events
      .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => ('delta' in event ? event.delta : ''))
      .join(''),
    'New reply',
    'The live message streams once as deltas',
  );
  // The committed reply replaces its live slot through a snapshot, so clients
  // never keep twins and earlier messages are retained.
  const replacement = final.find(
    (event) => event.type === 'MESSAGES_SNAPSHOT',
  ) as BaseEvent & { messages: { id: string; content: string }[] };
  assert.deepEqual(
    replacement.messages.map((message) => message.content),
    ['Earlier reply', 'New reply finished'],
  );
  assert.ok(
    !replacement.messages.some((message) => message.id.endsWith(':live')),
  );
});

test('completion catches up entries committed beyond the live observation window', async (t) => {
  const f = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.deps.faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage('Caught up final reply');
    },
  ]);
  const lookup = f.service.chat!.lookup.bind(f.service.chat!);
  let calls = 0;
  t.mock.method(
    f.service.chat!,
    'lookup',
    async (id: string, requestId: string) => {
      if (++calls === 3) {
        await f.service.workflow['harness'].commit(async (tx) => {
          for (let i = 0; i < 70; i++)
            await tx.appendEntry(Number(id) as never, {
              kind: 'factory.workflow',
              data: { text: `Background event ${i}` },
            });
        }, context);
        release();
        await until(
          () => lookup(id, requestId),
          (value) => value.status === 'completed',
        );
      }
      return lookup(id, requestId);
    },
  );
  try {
    const agent = await f.agent('Catch up', 'catch-up-message');
    await agent.runAgent({ runId: 'catch-up-run' });
    for (let i = 0; i < 70; i++)
      assert.ok(
        agent.messages.some(
          (message) => message.content === `Background event ${i}`,
        ),
        `Lost event ${i}`,
      );
    assert.ok(
      agent.messages.some(
        (message) => message.content === 'Caught up final reply',
      ),
    );
  } finally {
    release();
    await f.close();
  }
});
