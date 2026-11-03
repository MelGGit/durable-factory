import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '../apps/server/src/chat-fixtures.js';
const fauxThinking = (thinking: string) => ({
  type: 'thinking' as const,
  thinking,
});
type EntryRecord = Parameters<typeof transcript>[0];
import { transcript } from '../apps/server/src/chat.js';
import { conversationItems } from '../apps/web/src/transcript.js';
import {
  activityView,
  activityFromAgUi,
  conversationView,
  conversationFromAgUi,
  historyView,
  historyFromAgUi,
  ChatClient,
  type RunActivityPage,
} from '../packages/shared/src/index.js';
import { fixture, configure, until } from './fixtures/chat.js';
import { startService } from './helpers/credentials.js';
import { context } from '../apps/server/src/storage.js';

const entry = (content: Parameters<typeof fauxAssistantMessage>[0]) =>
  ({
    id: 5,
    byTaskId: 12,
    conversationId: '1',
    kind: 'pi.assistant',
    model: [fauxAssistantMessage(content)],
  }) as unknown as EntryRecord;

test('typed thinking stays out of prose, preserves tool order, and omits redactions and signatures', () => {
  const raw = entry([
    {
      type: 'thinking',
      thinking: 'Checking validation coverage',
      thinkingSignature: 'private signature',
    },
    { type: 'text', text: 'I will check the tests.' },
    fauxToolCall('read', { path: 'test.ts' }, { id: 'call' }),
    fauxThinking('One more check'),
    { type: 'text', text: 'The answer.' },
    {
      type: 'thinking',
      thinking: 'opaque payload',
      redacted: true,
      thinkingSignature: 'secret',
    },
  ]);
  const projected = transcript(raw);
  assert.equal(projected.text, 'I will check the tests.\nThe answer.');
  assert.deepEqual(
    projected.parts?.map((part) => part.type),
    ['thinking', 'text', 'tool', 'thinking', 'text'],
  );
  assert.doesNotMatch(
    JSON.stringify(projected),
    /private signature|opaque payload|secret/,
  );
  assert.deepEqual(
    conversationItems([projected]).map((item) =>
      item.kind === 'tool' ? 'tool' : item.entry.parts?.[0].type,
    ),
    ['thinking', 'text', 'tool', 'thinking', 'text'],
  );
  assert.equal(
    conversationItems([transcript(entry(fauxThinking('Checking only')))])
      .length,
    1,
  );
});

test('long thinking is bounded and has an artifact separate from the normal response', () => {
  const projected = transcript(
    entry([fauxThinking('考'.repeat(40000)), { type: 'text', text: 'Done.' }]),
  );
  const thinking = projected.parts?.[0];
  assert.equal(thinking?.type, 'thinking');
  if (thinking?.type !== 'thinking') assert.fail('Missing thinking');
  assert.ok(Buffer.byteLength(thinking.text) <= 32768);
  assert.ok(thinking.artifact?.startsWith('entry-5-part-0-'));
  assert.ok(!thinking.text.includes('\ufffd'));
  assert.equal(projected.text, 'Done.');
  assert.equal(projected.textArtifact, undefined);
});

test('typed content round trips through conversation, history, and multi-agent activity as native reasoning messages', () => {
  const projected = transcript(
    entry([fauxThinking('Check coverage'), { type: 'text', text: 'Done.' }]),
  );
  const conversation = { id: '1' } as Parameters<
    typeof conversationView
  >[0]['conversation'];
  const snapshot = {
    conversation,
    entries: [projected],
    partial: '',
    tools: [],
    submissions: [],
    execution: 'running' as const,
    liveParts: [
      { id: 'live-thought', type: 'thinking' as const, text: 'Checking more' },
    ],
  };
  const view = conversationView(snapshot);
  assert.equal(
    view.messages.filter((message) => message.role === 'reasoning').length,
    2,
  );
  assert.doesNotMatch(
    JSON.stringify(view.state),
    /Check coverage|Checking more/,
  );
  assert.deepEqual(conversationFromAgUi(view.messages, view.state), snapshot);
  const history = historyView('1', [projected], 'older');
  assert.deepEqual(historyFromAgUi(history.messages, history.state), {
    entries: [projected],
    cursor: 'older',
  });
  const activity: RunActivityPage = {
    items: [
      {
        id: 'entry:1:5',
        actor: 'development',
        title: 'Developer agent',
        conversationId: '1',
        entry: projected,
      },
    ],
    live: [
      {
        conversationId: '1',
        role: 'development',
        partial: '',
        tools: [],
        liveParts: snapshot.liveParts,
      },
      {
        conversationId: '2',
        role: 'review',
        partial: '',
        tools: [],
        liveParts: [
          { id: 'review-thinking', type: 'thinking', text: 'Reviewing' },
        ],
      },
    ],
  };
  const run = activityView(activity);
  assert.deepEqual(activityFromAgUi(run.messages, run.state), activity);
});

test(
  'live thinking commits with stable identity and channel-specific full artifacts remain pageable',
  { timeout: 20000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-thinking-'));
    const deps = fixture(1000);
    deps.faux.setResponses([
      fauxAssistantMessage([
        fauxThinking('Checking validation coverage. '.repeat(20)),
        { type: 'text', text: 'Validation is covered.' },
      ]),
    ]);
    const service = await startService({ dataDir, port: 0, chat: deps });
    let stop: (() => void) | undefined;
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'Thinking projection',
        'thinking',
      );
      const liveIds = new Set<string>();
      stop = client.watch(
        conversation.id,
        (snapshot) => {
          for (const part of snapshot.liveParts ?? [])
            if (part.type === 'thinking') liveIds.add(part.id);
          assert.doesNotMatch(snapshot.partial, /Checking validation/);
        },
        () => {},
      );
      await client.submit(conversation.id, 'Check coverage', 'check');
      const saved = await until(
        () => client.history(conversation.id),
        (value) => value.entries.some((entry) => entry.kind === 'pi.assistant'),
      );
      const answer = saved.entries.find(
        (entry) => entry.kind === 'pi.assistant',
      )!;
      assert.equal(answer.text, 'Validation is covered.');
      assert.ok(
        liveIds.has(answer.parts![0].id),
        `Live identities ${[...liveIds]} should contain ${answer.parts![0].id}`,
      );
      const fullThinking = await client.artifact(
        conversation.id,
        `entry-${answer.id}-part-0-0`,
      );
      assert.match(fullThinking.text, /Checking validation coverage/);
      assert.equal(
        (await client.artifact(conversation.id, `entry-${answer.id}-text`))
          .text,
        'Validation is covered.',
      );
      assert.doesNotMatch(
        (await client.artifact(conversation.id, `entry-${answer.id}`)).text,
        /Checking validation/,
      );
      const full = '考'.repeat(50000);
      const longEntry = await service.chat!['harness'].commit(
        (tx) =>
          tx.appendEntry(Number(conversation.id) as never, {
            kind: 'pi.assistant',
            model: [
              fauxAssistantMessage([
                fauxThinking(full),
                { type: 'text', text: 'A separate answer.' },
                {
                  type: 'thinking',
                  thinking: 'redacted',
                  redacted: true,
                  thinkingSignature: 'encrypted',
                },
              ]),
            ],
          }),
        context,
      );
      const history = await client.history(conversation.id);
      const long = history.entries.find(
        (entry) => entry.id === String(longEntry.id),
      )!;
      const part = long.parts![0];
      if (part.type !== 'thinking') assert.fail('Missing thinking');
      let output = '';
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const page = await client.artifact(
          conversation.id,
          part.artifact!,
          offset,
        );
        output += page.text;
        offset = page.nextOffset;
      }
      assert.equal(output, full);
      assert.equal(long.text, 'A separate answer.');
      await assert.rejects(
        client.artifact(conversation.id, `entry-${longEntry.id}-part-0-2`),
      );
    } finally {
      stop?.();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
