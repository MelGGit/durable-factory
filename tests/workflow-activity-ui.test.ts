import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunActivityItem } from '../packages/shared/src/index.js';
import {
  groupWorkflowActivity,
  isWorkflowEvent,
  workflowEventText,
} from '../apps/web/src/workflow-activity.js';

const command = (id: string, attemptId = 'attempt'): RunActivityItem => ({
  id: `command:${id}`,
  actor: 'code',
  title: 'bun test',
  attemptId,
  command: { id, state: 'finished', exitCode: 0 },
});
const progress = (id: string): RunActivityItem => ({
  id,
  actor: 'code',
  title: id,
});

test('workflow activity groups progress without crossing messages, questions or command attempts', () => {
  const message: RunActivityItem = {
    id: 'message',
    actor: 'development',
    title: 'Developer',
    entry: { id: '1', kind: 'pi.assistant', text: 'Checking.', tools: [] },
  };
  const question = { ...progress('timeline:question-1') };
  const items = [
    progress('queued'),
    progress('started'),
    message,
    progress('checks'),
    question,
    progress('review'),
    command('a'),
    command('b'),
    command('c', 'retry'),
  ];
  const before = JSON.stringify(items);
  assert.deepEqual(
    groupWorkflowActivity(items).map((group) => group.map((item) => item.id)),
    [
      ['queued', 'started'],
      ['message'],
      ['checks'],
      ['timeline:question-1'],
      ['review'],
      ['command:a', 'command:b'],
      ['command:c'],
    ],
  );
  assert.equal(JSON.stringify(items), before);
});

test('only a loaded tool output artifact replaces its duplicate process record', () => {
  const items = [
    command('run-attempt-tool-42'),
    command('check-42'),
    command('run-attempt-tool-43'),
  ];
  const tools = [
    {
      id: 'call',
      name: 'worktree_command',
      status: 'completed' as const,
      artifact: 'task-42',
    },
  ];
  assert.deepEqual(
    groupWorkflowActivity(items, tools)
      .flat()
      .map((item) => item.command!.id),
    ['check-42', 'run-attempt-tool-43'],
  );
  assert.equal(
    groupWorkflowActivity(items).flat().length,
    3,
    'An unloaded call must not hide the command or its output',
  );
  assert.equal(
    groupWorkflowActivity(items, [
      { ...tools[0], artifact: undefined, inputArtifact: 'task-42' },
    ]).flat().length,
    3,
    'An input artifact cannot replace the command output',
  );
});

test('factory workflow details remain inspectable and interrupted entries retain their original presentation', () => {
  const item: RunActivityItem = {
    ...progress('workflow:1'),
    entry: {
      id: '1',
      kind: 'factory.workflow',
      text: 'Development passed\n\nFull report',
      tools: [],
    },
  };
  assert.equal(isWorkflowEvent(item), true);
  assert.deepEqual(workflowEventText(item), {
    title: 'Development passed',
    detail: 'Development passed\n\nFull report',
  });
  assert.equal(
    isWorkflowEvent({ ...item, entry: { ...item.entry!, interrupted: true } }),
    false,
  );
});
