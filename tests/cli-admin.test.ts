import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient, WorkflowClient } from '../packages/shared/src/index.js';
import { applyEdits } from '../apps/cli/src/admin.js';
import { EXIT, run, type Deps } from '../apps/cli/src/cli.js';
import { NONE } from '../apps/cli/src/environment.js';
import { workflowFixture } from './fixtures/workflow.js';

test('the CLI manages projects, settings, runners and credentials like the web app', async () => {
  const s = await workflowFixture();
  try {
    const out: string[] = [];
    const err: string[] = [];
    const answers: string[] = [];
    const deps: Deps = {
      workflow: new WorkflowClient(s.service.url),
      chat: new ChatClient(s.service.url),
      env: NONE,
      command: 'factory',
      io: { out: (text) => out.push(text), err: (text) => err.push(text) },
      ask: async () => answers.shift() ?? '',
    };
    const cli = async (...argv: string[]) => {
      out.length = 0;
      err.length = 0;
      const code = await run([...argv, '--json'], deps);
      return { code, json: out[0] ? JSON.parse(out[0]) : undefined };
    };

    const listed = await cli('project', 'list');
    assert.equal(listed.code, EXIT.ok, err.join('\n'));
    assert.equal(listed.json.length, 1);

    const added = await cli('project', 'add', 'Second project');
    assert.equal(added.code, EXIT.ok, err.join('\n'));
    assert.equal(added.json.name, 'Second project');
    const renamed = await cli('project', 'rename', 'Second', 'Renamed');
    assert.equal(renamed.code, EXIT.usage); // "Second" is not a name or id
    const byName = await cli('project', 'rename', 'Second project', 'Renamed');
    assert.equal(byName.json.name, 'Renamed', err.join('\n'));

    // --project scopes settings to that project.
    const shown = await cli('settings', 'show', '--project', 'Renamed');
    assert.equal(shown.json.projectId, added.json.id);
    const saved = await cli(
      'settings',
      'set',
      'commitIdentity.name=Ada',
      'timeouts.tool=99',
      'setupCommands=one',
      'setupCommands=two',
      '--project',
      added.json.id,
    );
    assert.equal(saved.code, EXIT.ok, err.join('\n'));
    assert.equal(saved.json.settings.commitIdentity.name, 'Ada');
    assert.equal(saved.json.settings.timeouts.tool, 99);
    assert.deepEqual(saved.json.settings.setupCommands, ['one', 'two']);
    const other = await cli('settings', 'show');
    assert.notEqual(other.json.settings.commitIdentity.name, 'Ada');

    assert.equal((await cli('settings', 'set', 'nope.key=1')).code, EXIT.usage);

    assert.equal((await cli('runners', '3')).json.runners, 3);
    assert.equal((await cli('runners')).json.runners, 3);
    assert.equal((await cli('runners', '0')).code, EXIT.usage);

    assert.equal((await cli('titles')).json.selection, null);
    assert.equal((await cli('providers')).code, EXIT.ok);

    answers.push('ghp_secret');
    assert.equal((await cli('credential', 'set', 'github')).code, EXIT.ok);
    assert.equal((await cli('settings', 'show')).json.credentials.github, true);
    assert.equal((await cli('credential', 'rm', 'github')).code, EXIT.ok);
    assert.equal(
      (await cli('settings', 'show')).json.credentials.github,
      false,
    );
    assert.equal((await cli('credential', 'set', 'openai')).code, EXIT.usage);

    assert.equal((await cli('issues')).code, EXIT.ok, err.join('\n'));
    assert.equal((await cli('deletions')).code, EXIT.ok);

    // Removing needs --yes.
    assert.equal(
      (await cli('project', 'remove', added.json.id)).code,
      EXIT.usage,
    );
    assert.equal(
      (await cli('project', 'remove', added.json.id, '--yes')).code,
      EXIT.ok,
      err.join('\n'),
    );
    assert.equal((await cli('project', 'list')).json.length, 1);
  } finally {
    await s.close();
  }
});

test('login prints the address, answers prompts and reports the outcome', async () => {
  const states = [
    {
      state: 'pending',
      prompt: { id: 'p1', type: 'manual_code', message: 'Code?' },
    },
    { state: 'pending' },
    { state: 'completed' },
  ];
  const calls: unknown[] = [];
  const base = {
    id: 's1',
    provider: 'openai',
    expiresAt: 0,
    authUrl: 'https://example.com/auth',
  };
  const workflow = {
    projectId: undefined,
    startLogin: async () => ({ session: { ...base, ...states[0] } }),
    answerLogin: async (...args: unknown[]) => {
      calls.push(args);
      return { session: { ...base, ...states[1] } };
    },
    loginStatus: async () => ({ session: { ...base, ...states[2] } }),
  } as unknown as WorkflowClient;
  const out: string[] = [];
  const deps: Deps = {
    workflow,
    chat: {} as ChatClient,
    env: NONE,
    command: 'factory',
    pollMs: 1,
    ask: async () => '123',
    io: { out: (t) => out.push(t), err: () => {} },
  };
  assert.equal(await run(['login', 'openai'], deps), EXIT.ok);
  assert.match(out.join('\n'), /example\.com\/auth/);
  assert.deepEqual(calls, [['openai', 's1', 'p1', '123']]);
  assert.equal(await run(['login', 'nobody'], deps), EXIT.usage);
});

test('settings edits reject unknown paths and clear lists and model fields', () => {
  const base = {
    repository: { path: '', github: '', baseBranch: 'main' },
    setupCommands: ['x'],
    timeouts: { tool: 1 },
    roles: { review: { provider: 'openai', model: 'm', reasoning: 'high' } },
  } as never;
  const next = applyEdits(base, [
    'setupCommands=',
    'roles.review.reasoning=none',
    'repository.baseBranch=dev',
  ]) as unknown as Record<string, any>;
  assert.deepEqual(next.setupCommands, []);
  assert.equal(next.roles.review.reasoning, null);
  assert.equal(next.repository.baseBranch, 'dev');
  assert.throws(() => applyEdits(base, ['timeouts.tool=x']), /number/);
  assert.throws(() => applyEdits(base, ['roles.review=x']), /single/);
  assert.throws(() => applyEdits(base, ['bad']), /path=value/);
});
