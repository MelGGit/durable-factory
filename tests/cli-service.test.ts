import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient, WorkflowClient } from '../packages/shared/src/index.js';
import { simulationAdapter } from '../apps/server/src/workflow.js';
import { EXIT, run, type Deps } from '../apps/cli/src/cli.js';
import { NONE } from '../apps/cli/src/environment.js';
import { workflowFixture } from './fixtures/workflow.js';
import { until } from './fixtures/chat.js';

test(
  'the CLI waits for a question, answers it and follows the run to a pull request',
  { timeout: 30000 },
  async () => {
    const adapter = simulationAdapter();
    const execute = adapter.execute;
    let asked = false;
    adapter.execute = async (item, attempt, signal) => {
      if (attempt.stage === 'developer' && !asked) {
        asked = true;
        return {
          outcome: 'needs_input',
          message: 'Which behavior should be implemented?',
        };
      }
      return execute(item, attempt, signal);
    };
    const s = await workflowFixture(adapter);
    try {
      const started = await s.client.startRun(await s.issue(), 'cli-live');
      const out: string[] = [];
      const err: string[] = [];
      const deps: Deps = {
        workflow: new WorkflowClient(s.service.url),
        chat: new ChatClient(s.service.url),
        env: NONE,
        command: 'factory',
        io: { out: (text) => out.push(text), err: (text) => err.push(text) },
      };
      const cli = async (...argv: string[]) => {
        out.length = 0;
        const code = await run([...argv, '--json'], deps);
        return { code, json: out[0] ? JSON.parse(out[0]) : undefined };
      };

      const waiting = await cli('wait', started.id, '--timeout', '20');
      assert.equal(waiting.code, EXIT.ok, err.join('\n'));
      assert.equal(waiting.json.status, 'needs_input');
      assert.equal(waiting.json.worktreeBusy, false);
      assert.match(waiting.json.question.text, /Which behavior/);

      const listed = await cli('runs');
      assert.equal(listed.json[0].id, started.id);

      const answered = await cli('answer', started.id, 'Keep it small');
      assert.equal(answered.code, EXIT.ok, err.join('\n'));

      const done = await cli(
        'wait',
        started.id,
        '--for',
        'pr_ready,paused',
        '--timeout',
        '20',
      );
      assert.equal(done.code, EXIT.ok, err.join('\n'));
      assert.equal(done.json.status, 'pr_ready');

      const missing = await cli('show', 'nope');
      assert.equal(missing.code, EXIT.usage);
    } finally {
      await s.close();
    }
  },
);

test(
  'plan: the CLI opens a conversation, gets a ticket proposal, approves it and starts a run from it',
  { timeout: 30000 },
  async () => {
    const s = await workflowFixture();
    try {
      const out: string[] = [];
      const err: string[] = [];
      const deps: Deps = {
        workflow: new WorkflowClient(s.service.url),
        chat: new ChatClient(s.service.url),
        env: NONE,
        command: 'factory',
        io: { out: (text) => out.push(text), err: (text) => err.push(text) },
      };
      const cli = async (...argv: string[]) => {
        out.length = 0;
        const code = await run([...argv, '--json'], deps);
        return { code, json: out[0] ? JSON.parse(out[0]) : undefined };
      };

      const created = await cli('plan', 'new', 'Add', 'a', 'thing');
      assert.equal(created.code, EXIT.ok, err.join('\n'));
      const id = created.json.id as string;

      const early = await cli('plan', 'approve', id);
      assert.equal(early.code, EXIT.usage);
      assert.match(err.at(-1)!, /not proposed/);

      const proposed = await cli('plan', 'send', id, 'plan');
      assert.equal(proposed.code, EXIT.ok, err.join('\n'));
      assert.equal(proposed.json.awaitingApproval, true);
      assert.ok(proposed.json.ticket.title);

      const approved = await cli('plan', 'approve', id);
      assert.equal(approved.code, EXIT.ok, err.join('\n'));
      assert.equal(approved.json.awaitingApproval, false);
      assert.ok(approved.json.issue.number > 0);

      const listed = await cli('plan', 'list');
      assert.equal(listed.json[0].id, id);

      const started = await cli('start', '--conversation', id);
      assert.equal(started.code, EXIT.ok, err.join('\n'));
      assert.equal(started.json.issue, approved.json.issue.number);
    } finally {
      await s.close();
    }
  },
);

test(
  'plan chat: lines typed by a person reach the planner and the view follows to the issue and a run',
  { timeout: 30000 },
  async () => {
    const s = await workflowFixture();
    try {
      const out: string[] = [];
      const err: string[] = [];
      const chat = new ChatClient(s.service.url);
      const created = await chat.createConversation('Add a thing', 'chat-1');
      const seen = (pattern: RegExp) =>
        until(
          async () => out.join(''),
          (text) => pattern.test(text),
        );
      async function* typed() {
        yield '/ticket';
        yield '/approve';
        yield 'plan';
        await seen(/Ready to create the GitHub issue/);
        yield '/start';
        yield '/approve';
        await seen(/Issue #\d+ created/);
        yield '/start';
        await seen(/Started run/);
      }
      const deps: Deps = {
        workflow: new WorkflowClient(s.service.url),
        chat,
        env: NONE,
        command: 'factory',
        input: typed(),
        write: (text) => out.push(text),
        io: {
          out: (text) => out.push(`${text}\n`),
          err: (text) => err.push(text),
        },
      };
      assert.equal(
        await run(['plan', 'chat', created.id], deps),
        EXIT.ok,
        err.join('\n'),
      );
      const text = out.join('');
      assert.match(text, /Planning · Add a thing/);
      assert.match(text, /No ticket yet/);
      assert.match(text, /has not proposed an issue yet/);
      assert.match(text, /Ticket r1 · Add search/);
      assert.match(text, /Create the issue first/);
      assert.match(text, /Issue #\d+ created/);
      assert.match(text, /Started run/);
      assert.equal(
        (text.match(/> create it/g) ?? []).length,
        0,
        'the text /approve sends is not echoed',
      );
      assert.deepEqual(err, []);
    } finally {
      await s.close();
    }
  },
);
