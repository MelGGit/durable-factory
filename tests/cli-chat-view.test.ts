import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ConversationSnapshot,
  TranscriptEntry,
} from '../packages/shared/src/index.js';
import {
  ChatView,
  Markdown,
  describeTool,
  styles,
  visible,
} from '../apps/cli/src/chat-view.js';

const entry = (
  id: string,
  kind: 'pi.user' | 'pi.assistant',
  text: string,
): TranscriptEntry => ({ id, kind, text, tools: [] });

const snap = (
  patch: Partial<ConversationSnapshot> = {},
): ConversationSnapshot => ({
  conversation: {
    id: '5',
    projectId: 'default',
    title: 'Add search',
    role: 'planning',
    repository: { path: '/repo', github: 'o/r' },
    createdAt: '',
    model: { provider: 'requesty', model: 'm', reasoning: null },
  },
  entries: [],
  partial: '',
  tools: [],
  submissions: [],
  execution: 'idle',
  ...patch,
});

const ticket = {
  revision: 1,
  title: 'Add search',
  goal: 'Find saved work',
  scope: 'Current project',
  acceptanceCriteria: 'AC-1: Results link to files',
  validation: 'Run the tests',
};
const repository = {
  id: 'r',
  path: '/repo',
  github: 'o/r',
  baseBranch: 'main',
};

test('markdown styles bold, code, headings, bullets and fences line by line', () => {
  const md = new Markdown(styles(false));
  assert.equal(md.line('## Plan'), 'Plan');
  assert.equal(md.line('- use **this** and `that`'), '• use this and that');
  assert.equal(md.line('```ts'), '┄');
  assert.equal(md.line('const a = 1'), '│ const a = 1');
  assert.equal(md.line('```'), '┄');
  assert.equal(md.line('plain'), 'plain');
  assert.match(new Markdown(styles(true)).line('**x**'), /\x1b\[1mx\x1b\[0m/);
});

test('tools are named the way Claude Code names its own', () => {
  assert.equal(
    describeTool({ name: 'read_repository', arguments: '{"path":"src/a.ts"}' }),
    'Read(src/a.ts)',
  );
  assert.equal(
    describeTool({
      name: 'search_repository',
      arguments: '{"pattern":"Issues"}',
    }),
    'Search("Issues")',
  );
  assert.equal(
    describeTool({ name: 'save_ticket', arguments: '' }),
    'Save ticket',
  );
  assert.equal(
    describeTool({ name: 'odd_tool', arguments: '{"pa' }),
    'odd tool',
  );
});

test('opening shows a welcome box with every line the same width, then the last few messages', () => {
  const entries = Array.from({ length: 10 }, (_, i) =>
    entry(String(i), i % 2 ? 'pi.assistant' : 'pi.user', `message ${i}`),
  );
  const text = new ChatView(false).update(snap({ entries }));
  const box = text.split('\n').filter((line) => /^[╭│╰]/.test(line));
  assert.equal(box.length, 6);
  assert.equal(new Set(box.map((line) => visible(line).length)).size, 1);
  assert.match(text, /Durable Factory/);
  assert.match(text, /Planning · Add search/);
  assert.match(text, /#5 · o\/r/);
  assert.match(text, /4 earlier messages/);
  assert.doesNotMatch(text, /message 3\b/);
  assert.match(text, /> message 8/);
  assert.match(text, /● message 9/);
});

test('the person is echoed with > and the planner speaks with one bullet per reply', () => {
  const view = new ChatView(false);
  view.update(snap());
  const text = view.update(
    snap({
      entries: [
        entry('1', 'pi.user', 'add a search box'),
        entry('2', 'pi.assistant', 'First line\nSecond line\n- a point'),
      ],
    }),
  );
  assert.match(text, /> add a search box/);
  assert.equal((text.match(/●/g) ?? []).length, 1);
  assert.match(text, /● First line\n {2}Second line\n {2}• a point/);
  assert.equal(view.echo('x\ny'), '\n> x\n  y');
  assert.equal(view.note('done'), '  ⎿  done');
});

test('a reply streams line by line and is not repeated when it is committed', () => {
  const view = new ChatView(false);
  view.update(snap());
  const first = view.update(
    snap({ execution: 'running', partial: 'Hello th' }),
  );
  assert.doesNotMatch(first, /Hello/);
  assert.equal(view.working, true);
  const second = view.update(
    snap({ execution: 'running', partial: 'Hello there\nSecond li' }),
  );
  assert.match(second, /● Hello there/);
  assert.doesNotMatch(second, /Second/);
  const done = view.update(
    snap({
      execution: 'idle',
      entries: [entry('1', 'pi.assistant', 'Hello there\nSecond line')],
    }),
  );
  assert.match(done, /Second line/);
  assert.doesNotMatch(done, /Hello there|●/);
  assert.equal(view.idle, true);
  assert.equal(view.working, false);
});

test('tool activity is announced once, then the ticket panel and approval banner appear once', () => {
  const view = new ChatView(false);
  view.update(snap());
  const tool = { id: 't1', name: 'save_ticket', status: 'running' as const };
  const working = view.update(snap({ execution: 'running', tools: [tool] }));
  assert.match(working, /● Save ticket/);
  assert.equal(view.working, true);
  assert.doesNotMatch(
    view.update(snap({ execution: 'running', tools: [tool] })),
    /Save ticket/,
  );
  const planning = { repository, ticket, proposal: { id: 'p', revision: 1 } };
  const proposed = view.update(snap({ execution: 'idle', planning }));
  assert.match(proposed, /Ticket r1 · Add search/);
  assert.match(proposed, /Acceptance criteria/);
  assert.match(proposed, /Ready to create the GitHub issue/);
  assert.match(proposed, /\/approve/);
  const again = view.update(snap({ execution: 'idle', planning }));
  assert.doesNotMatch(again, /Ticket r1|Ready to create/);
});

test('the issue and run are announced when they appear', () => {
  const view = new ChatView(false);
  view.update(snap());
  const planning = {
    repository,
    ticket,
    operation: {
      state: 'created',
      issue: { number: 12, url: 'https://github.com/o/r/issues/12' },
    },
  } as ConversationSnapshot['planning'];
  const created = view.update(snap({ planning }));
  assert.match(created, /Issue #12 created/);
  assert.match(created, /\/start/);
  const started = view.update(
    snap({ planning: { ...planning!, runId: 'run_9' } }),
  );
  assert.match(started, /Run run_9 started/);
});

test('text a command sent for the person is not echoed a second time', () => {
  const view = new ChatView(false);
  view.update(snap());
  view.mute('create it');
  const text = view.update(
    snap({ entries: [entry('1', 'pi.user', 'create it')] }),
  );
  assert.doesNotMatch(text, /create it/);
  const later = view.update(
    snap({
      entries: [
        entry('1', 'pi.user', 'create it'),
        entry('2', 'pi.user', 'create it'),
      ],
    }),
  );
  assert.match(later, /> create it/);
});

test('help lists every command, and commands are highlighted when colour is on', () => {
  const plain = new ChatView(false).help();
  for (const name of ['/ticket', '/approve', '/start', '/help', '/quit'])
    assert.match(plain, new RegExp(name));
  assert.match(plain, /● Commands/);
  assert.match(new ChatView(true).help(), /\x1b\[1m\x1b\[36m\/ticket/);
});
