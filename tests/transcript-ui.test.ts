import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationItems, agentLabel } from '../apps/web/src/transcript.js';
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
