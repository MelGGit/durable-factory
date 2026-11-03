import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationItems,
  agentLabel,
  groupToolActivity,
  toolLabel,
  toolGroupLabel,
  groupResponseFlow,
  type ResponsePartDescription,
  type ActivityCall,
} from '../apps/web/src/transcript.js';
import type {
  TranscriptEntry,
  ToolView,
} from '../packages/shared/src/index.js';

const call: ToolView = {
  id: 'call',
  name: 'read',
  arguments: '{"path":"README.md"}',
  status: 'pending',
};
const result: ToolView = {
  id: 'call',
  name: 'read',
  output: 'Finished',
  status: 'completed',
  artifact: 'task-1',
  truncated: true,
};

test('a response combines prose, tools and workflow updates until a speaker, attempt or user boundary', () => {
  const speaker = {
    conversationId: 'dev',
    attemptId: 'first',
    author: 'Developer agent',
  };
  const agent: ResponsePartDescription = { kind: 'agent', speaker, at: 100 };
  const parts: ResponsePartDescription[] = [
    { kind: 'workflow' },
    agent,
    { ...agent, at: 101 },
    { kind: 'workflow', attemptId: 'first' },
    agent,
    { kind: 'boundary' },
    agent,
    { ...agent, speaker: { ...speaker, attemptId: 'retry' } },
    {
      ...agent,
      speaker: { ...speaker, conversationId: 'review', author: 'Review agent' },
    },
  ];
  const before = JSON.stringify(parts);
  const groups = groupResponseFlow(parts, (part) => part);
  assert.deepEqual(
    groups.map((group) =>
      group.kind === 'response' ? group.items.length : 'standalone',
    ),
    ['standalone', 4, 'standalone', 1, 1, 1],
  );
  assert.equal(JSON.stringify(parts), before);
  assert.equal(groups[1].kind === 'response' && groups[1].at, 100);
});

test('questions close their response and workflow for another attempt remains separate', () => {
  const agent: ResponsePartDescription = {
    kind: 'agent',
    speaker: {
      conversationId: 'dev',
      attemptId: 'one',
      author: 'Developer agent',
    },
  };
  const groups = groupResponseFlow<ResponsePartDescription>(
    [
      agent,
      { ...agent, closes: true },
      { kind: 'workflow' },
      agent,
      { kind: 'workflow', attemptId: 'two' },
      agent,
      { kind: 'boundary' },
      agent,
    ],
    (part) => part,
  );
  assert.deepEqual(
    groups.map((group) =>
      group.kind === 'response' ? group.items.length : 'standalone',
    ),
    [2, 'standalone', 1, 'standalone', 1, 'standalone', 1],
  );
});
const entry = (
  id: string,
  kind: string,
  tools: ToolView[],
  text = '',
): TranscriptEntry => ({ id, kind, tools, text });

test('one tool card joins arguments, live output and authoritative durable result without changing history', () => {
  const entries = [
    entry('1', 'pi.assistant', [call], 'Reading.'),
    entry('2', 'pi.tool-result', [result]),
  ];
  const before = JSON.stringify(entries);
  const items = conversationItems(entries, [
    { ...call, status: 'running', output: 'Stale live output' },
  ]);
  assert.equal(JSON.stringify(entries), before);
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], {
    kind: 'tool',
    key: 'tool:call',
    tool: { ...call, ...result },
  });
});

test('live, failed, reconnected and paginated tool views retain a stable identity', () => {
  const live = conversationItems(
    [],
    [{ ...call, status: 'running', output: 'Reading…' }],
  );
  const orphan = conversationItems([
    entry('2', 'pi.tool-result', [{ ...result, status: 'failed' }]),
  ]);
  const paginated = conversationItems([
    entry('1', 'pi.assistant', [call]),
    entry('2', 'pi.tool-result', [{ ...result, status: 'failed' }]),
  ]);
  assert.equal(live[0].key, orphan[0].key);
  assert.equal(orphan[0].key, paginated[0].key);
  assert.equal(paginated.length, 1);
  assert.equal(
    paginated[0].kind === 'tool' && paginated[0].tool.status,
    'failed',
  );
  assert.equal(
    paginated[0].kind === 'tool' && paginated[0].tool.arguments,
    call.arguments,
  );
});

test('repeated live slots do not duplicate tools and unrelated events and artifacts remain readable', () => {
  const items = conversationItems(
    [
      entry('1', 'pi.user', [], 'Question'),
      {
        ...entry('2', 'pi.compaction', [], 'Summary'),
        textArtifact: 'entry-2',
      },
      entry('3', 'pi.assistant', [call]),
      entry('4', 'pi.tool-result', [result]),
    ],
    [call, call],
  );
  assert.deepEqual(
    items.map((item) => item.key),
    ['entry:1', 'entry:2', 'tool:call'],
  );
  assert.equal(agentLabel('development'), 'Development agent');
  assert.equal(agentLabel('review'), 'Review agent');
});

test('complete input and output artifacts retain their separate identities', () => {
  const [item] = conversationItems([
    entry('1', 'pi.assistant', [
      { ...call, artifact: 'entry-1', truncated: true },
    ]),
    entry('2', 'pi.tool-result', [result]),
  ]);
  assert.equal(item.kind, 'tool');
  if (item.kind !== 'tool') throw new Error('Missing tool');
  assert.equal(item.tool.inputArtifact, 'entry-1');
  assert.equal(item.tool.artifact, 'task-1');
  assert.equal(conversationItems([entry('3', 'pi.system', [])]).length, 0);
});

test('tool labels use known actions and safely handle incomplete or unknown inputs', () => {
  assert.equal(toolLabel({ ...call, status: 'completed' }), 'Read README.md');
  assert.equal(toolLabel({ ...call, status: 'running' }), 'Reading README.md');
  assert.equal(toolLabel({ ...call, arguments: '{"path":' }), 'Reading a file');
  for (const arguments_ of ['null', '[]', '42', '{"path":42}', ''])
    assert.equal(
      toolLabel({ ...call, arguments: arguments_ }),
      'Reading a file',
    );
  assert.equal(
    toolLabel({
      ...call,
      name: 'worktree_command',
      status: 'running',
      arguments: '{"command":"bun\\n test"}',
    }),
    'Running bun test',
  );
  assert.equal(
    toolLabel({
      ...call,
      name: 'search_repository',
      arguments: '{"query":"hello"}',
    }),
    'Searching repository hello',
  );
  assert.equal(
    toolLabel({ ...call, name: 'propose_issue', status: 'completed' }),
    'Proposed issue',
  );
  assert.equal(toolLabel({ ...call, name: 'custom_tool' }), 'custom_tool');
  assert.equal(toolLabel({ ...call, name: 'constructor' }), 'constructor');
});

test('group summaries count distinct file paths and command calls, and surface live actions and failures', () => {
  const read = { ...call, status: 'completed' as const };
  const command = {
    ...read,
    name: 'worktree_command',
    arguments: '{"command":"bun test"}',
  };
  assert.equal(
    toolGroupLabel([
      read,
      read,
      { ...read, arguments: '{"path":"app.ts"}' },
      command,
      command,
    ]),
    'Read 2 files, ran 2 commands',
  );
  assert.equal(
    toolGroupLabel([read, { ...read, arguments: 'partial' }]),
    'Read 2 files',
  );
  assert.equal(
    toolGroupLabel([read, { ...command, status: 'running' }]),
    'Running bun test · 2 calls',
  );
  assert.equal(
    toolGroupLabel([read, { ...command, status: 'failed' }]),
    '2 tool calls',
  );
  assert.equal(
    toolGroupLabel([
      { ...read, name: 'custom_tool' },
      { ...read, name: 'other' },
    ]),
    'Used 2 tools',
  );
});

test('grouping respects content, conversation, attempt and agent boundaries without changing inputs', () => {
  type Item = ActivityCall | string;
  const first: ActivityCall = { tool: call, conversationId: 'planning' };
  const second: ActivityCall = {
    tool: { ...call, id: 'second' },
    conversationId: 'planning',
  };
  const items: Item[] = [
    first,
    second,
    'message',
    first,
    { ...first, conversationId: 'other' },
    { ...first, conversationId: 'other', attemptId: 'retry' },
    {
      ...first,
      conversationId: 'other',
      attemptId: 'retry',
      agent: 'Review agent',
    },
  ];
  const before = JSON.stringify(items);
  const groups = groupToolActivity(items, (item) =>
    typeof item === 'string' ? undefined : item,
  );
  assert.deepEqual(
    groups.map((group) =>
      group.kind === 'tools' ? group.calls.length : group.item,
    ),
    [2, 'message', 1, 1, 1, 1],
  );
  assert.equal(JSON.stringify(items), before);
});

test('pairing removes duplicate result boundaries before grouping', () => {
  const items = conversationItems(
    [
      entry('1', 'pi.assistant', [call]),
      entry('2', 'pi.tool-result', [result]),
      entry('3', 'pi.assistant', [{ ...call, id: 'second' }]),
    ],
    [{ ...call, id: 'second', status: 'running' }],
  );
  const groups = groupToolActivity(items, (item) =>
    item.kind === 'tool'
      ? { tool: item.tool, conversationId: 'chat' }
      : undefined,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'tools');
  if (groups[0].kind === 'tools')
    assert.deepEqual(
      groups[0].calls.map(({ tool }) => [tool.id, tool.status]),
      [
        ['call', 'completed'],
        ['second', 'running'],
      ],
    );
});
