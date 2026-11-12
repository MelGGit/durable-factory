import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatClient,
  WorkflowClient,
  WorkflowRun,
  WorkflowSnapshot,
} from '../packages/shared/src/index.js';
import { EXIT, parse, run, type Deps } from '../apps/cli/src/cli.js';
import {
  NONE,
  detectEnvironment,
  type Environment,
  type TerminalRequest,
} from '../apps/cli/src/environment.js';
import { orcaEnvironment, syncRun } from '../apps/cli/src/orca.js';
import { summarize, type RunSummary } from '../apps/cli/src/summary.js';

const fixture = (patch: Partial<WorkflowRun> = {}) =>
  ({
    id: 'run_abc123',
    revision: 4,
    status: 'running',
    stage: 'developer',
    issue: { number: 12, url: 'https://github.com/o/r/issues/12' },
    repairCount: 0,
    repairLimit: 3,
    interventions: [],
    developerConversationId: '77',
    repository: { id: 'r', path: '/repo', github: 'o/r', baseBranch: 'main' },
    workspace: {
      path: '/data/worktrees/run_abc123',
      branch: 'factory/run_abc123',
      base: 'deadbeef',
      includedIgnored: [],
    },
    ...patch,
  }) as WorkflowRun;

interface Options {
  frames?: WorkflowRun[][];
  /** End the run stream with an error after the frames, as a dropped connection would. */
  endStream?: boolean;
  env?: Environment;
}

function harness(runs: WorkflowRun[], options: Options = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const commands: unknown[] = [];
  const submitted: unknown[][] = [];
  const opened: TerminalRequest[] = [];
  const statuses: [RunSummary, boolean][] = [];
  const names: string[] = [];
  const snapshot = (list: WorkflowRun[]) =>
    ({ runs: list, revision: 1 }) as unknown as WorkflowSnapshot;
  const workflow = {
    workflow: async () => snapshot(runs),
    startIssue: async (issue: number) =>
      fixture({ issue: { number: issue, url: '' } }),
    command: async (id: string, command: unknown) => {
      commands.push({ id, command });
      return fixture();
    },
    watchRuns: (
      on: (value: WorkflowSnapshot) => void,
      _connected: unknown,
      fail?: (error: Error) => void,
    ) => {
      queueMicrotask(() => {
        on(snapshot(runs));
        for (const frame of options.frames ?? []) on(snapshot(frame));
        if (options.endStream) fail?.(new Error('stream ended'));
      });
      return () => {};
    },
  } as unknown as WorkflowClient;
  const chat = {
    submit: async (...args: unknown[]) => {
      submitted.push(args);
      return { status: 'queued', content: args[1] };
    },
  } as unknown as ChatClient;
  const env: Environment = options.env ?? {
    name: 'fake',
    openTerminal: async (request) => {
      opened.push(request);
      return { cwd: request.cwd, terminal: 'term_1' };
    },
    setStatus: async (row, unread) => {
      statuses.push([row, unread]);
      return true;
    },
    nameTerminal: async (title) => {
      names.push(title);
    },
  };
  const deps: Deps = {
    workflow,
    chat,
    env,
    command: 'factory',
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
  };
  return { deps, out, err, commands, submitted, opened, statuses, names };
}

test('parse separates words from flags and requires values for value flags', () => {
  const parsed = parse(['wait', 'run_1', '--for', 'pr_ready', '--json']);
  assert.deepEqual(parsed.words, ['wait', 'run_1']);
  assert.equal(parsed.flags.get('for'), 'pr_ready');
  assert.equal(parsed.flags.get('json'), true);
  assert.equal(parse(['runs', '--env', 'none']).flags.get('env'), 'none');
  assert.throws(() => parse(['wait', '--timeout']), /needs a value/);
});

test('runs prints JSON summaries that say whether the worktree is busy', async () => {
  const { deps, out } = harness([
    fixture(),
    fixture({ id: 'run_paused', status: 'paused' }),
  ]);
  assert.equal(await run(['runs', '--json'], deps), EXIT.ok);
  const rows = JSON.parse(out[0]);
  assert.deepEqual(
    rows.map((row: { id: string; worktreeBusy: boolean }) => [
      row.id,
      row.worktreeBusy,
    ]),
    [
      ['run_abc123', true],
      ['run_paused', false],
    ],
  );
});

test('runs resolve a unique id prefix and reject an ambiguous one', async () => {
  const { deps, out, err } = harness([
    fixture(),
    fixture({ id: 'run_abd999' }),
  ]);
  assert.equal(await run(['show', 'run_abc', '--json'], deps), EXIT.ok);
  assert.equal(JSON.parse(out[0]).id, 'run_abc123');
  assert.equal(await run(['show', 'run_ab'], deps), EXIT.usage);
  assert.match(err[0], /matches 2 runs/);
});

test('pause sends the run revision it saw so a stale view is refused by the service', async () => {
  const { deps, commands } = harness([fixture()]);
  assert.equal(await run(['pause', 'run_abc123', '--json'], deps), EXIT.ok);
  const sent = commands[0] as {
    id: string;
    command: { action: string; expectedRevision: number; operationId: string };
  };
  assert.equal(sent.id, 'run_abc123');
  assert.equal(sent.command.action, 'pause');
  assert.equal(sent.command.expectedRevision, 4);
  assert.ok(sent.command.operationId);
});

test('answer targets the pending question and refuses blockers that need a control', async () => {
  const pending = (reason: string) => ({
    id: 'q1',
    revision: 2,
    state: 'pending' as const,
    reason,
    question: 'Touch src/a.ts?',
    conversationId: '77',
  });
  const open = harness([
    fixture({ status: 'needs_input', interventions: [pending('scope')] }),
  ]);
  assert.equal(
    await run(['answer', 'run_abc123', 'yes', 'please'], open.deps),
    EXIT.ok,
  );
  assert.deepEqual((open.commands[0] as { command: object }).command, {
    ...(open.commands[0] as { command: object }).command,
    action: 'answer',
    interventionId: 'q1',
    interventionRevision: 2,
    answer: 'yes please',
  });
  const blocker = harness([
    fixture({
      status: 'needs_input',
      interventions: [pending('repair_exhausted')],
    }),
  ]);
  assert.equal(
    await run(['answer', 'run_abc123', 'ok'], blocker.deps),
    EXIT.usage,
  );
  assert.match(blocker.err[0], /factory resume/);
  assert.equal(blocker.commands.length, 0);
});

test('send submits to the developer conversation and steer switches the mode', async () => {
  const { deps, submitted } = harness([fixture()]);
  await run(['send', 'run_abc123', 'use', 'the', 'helper', '--steer'], deps);
  assert.equal(submitted[0][0], '77');
  assert.equal(submitted[0][1], 'use the helper');
  assert.equal(submitted[0][3], 'steer');
});

test('wait resolves when the run reaches a requested status and times out otherwise', async () => {
  const done = harness([fixture()], {
    frames: [[fixture({ status: 'pr_ready' })]],
  });
  assert.equal(
    await run(['wait', 'run_abc123', '--for', 'pr_ready', '--json'], done.deps),
    EXIT.ok,
  );
  assert.equal(JSON.parse(done.out[0]).status, 'pr_ready');
  const stuck = harness([fixture()]);
  assert.equal(
    await run(
      ['wait', 'run_abc123', '--for', 'pr_ready', '--timeout', '0.05'],
      stuck.deps,
    ),
    EXIT.timeout,
  );
});

test('start rejects anything but an issue number', async () => {
  const { deps, err } = harness([]);
  assert.equal(await run(['start', 'abc'], deps), EXIT.usage);
  assert.match(err[0], /issue number/);
});

test('open asks the environment for a terminal in the worktree and warns when the run is busy', async () => {
  const { deps, out, err, opened, statuses } = harness([fixture()]);
  assert.equal(await run(['open', 'run_abc123', '--json'], deps), EXIT.ok);
  assert.deepEqual(opened, [
    {
      cwd: '/data/worktrees/run_abc123',
      repository: '/repo',
      command: 'factory watch run_abc123',
      title: 'factory run_abc123',
    },
  ]);
  assert.equal(JSON.parse(out[0]).opened, true);
  assert.match(err[0], /may be writing/);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0][1], false);
});

test('open does not warn about a paused run', async () => {
  const { deps, err } = harness([fixture({ status: 'paused' })]);
  assert.equal(await run(['open', 'run_abc123'], deps), EXIT.ok);
  assert.deepEqual(err, []);
});

test('open refuses a run that has no worktree yet', async () => {
  const { deps, err } = harness([fixture({ workspace: undefined })]);
  assert.equal(await run(['open', 'run_abc123'], deps), EXIT.failed);
  assert.match(err[0], /no worktree yet/);
});

test('in a plain terminal open says what to run instead of failing', async () => {
  const { deps, out } = harness([fixture({ status: 'paused' })], { env: NONE });
  assert.equal(await run(['open', 'run_abc123'], deps), EXIT.ok);
  assert.match(out[0], /cd \/data\/worktrees\/run_abc123/);
  assert.match(out[0], /factory watch run_abc123/);
  out.length = 0;
  await run(['open', 'run_abc123', '--json'], deps);
  const json = JSON.parse(out[0]);
  assert.equal(json.opened, false);
  assert.equal(json.cwd, '/data/worktrees/run_abc123');
});

test('watch mirrors each change into the environment, and --no-env stops that', async () => {
  const frames = [[fixture({ status: 'pr_ready', stage: 'publishing' })]];
  const mirrored = harness([fixture()], { frames, endStream: true });
  assert.equal(await run(['watch', '--json'], mirrored.deps), EXIT.failed);
  assert.equal(mirrored.out.length, 2, 'one line per change');
  assert.deepEqual(
    mirrored.statuses.map(([row, unread]) => [row.status, unread]),
    [
      ['running', false],
      ['pr_ready', true],
    ],
  );
  const quiet = harness([fixture()], { frames, endStream: true });
  await run(['watch', '--no-env'], quiet.deps);
  assert.equal(quiet.statuses.length, 0);
  const plain = harness([fixture()], { endStream: true, env: NONE });
  await run(['watch'], plain.deps);
  assert.equal(plain.out.length, 1);
});

test('plan commands without an id fail and point to plan list', async () => {
  const { deps, err } = harness([]);
  for (const sub of ['open', 'show', 'chat', 'approve', 'send']) {
    err.length = 0;
    assert.equal(await run(['plan', sub], deps), EXIT.usage);
    assert.match(err[0], /factory plan list/);
  }
});

function planChat(onSnapshot: unknown) {
  return {
    watch: (_id: string, on: (snapshot: unknown) => void) => {
      queueMicrotask(() => on(onSnapshot));
      return () => {};
    },
  } as unknown as ChatClient;
}
const planSnapshot = {
  conversation: {
    id: '5',
    title: 'Add search',
    repository: { path: '/repo', github: 'o/r' },
  },
  entries: [],
  partial: '',
  tools: [],
  execution: 'idle',
};

test('plan chat names the terminal after the conversation and leaves when input ends', async () => {
  const { deps, names, out } = harness([]);
  deps.chat = planChat(planSnapshot);
  deps.input = (async function* () {})();
  assert.equal(await run(['plan', 'chat', '5'], deps), EXIT.ok);
  assert.deepEqual(names, ['plan: Add search']);
  assert.match(out.join('\n'), /Durable Factory/);
});

test('plan chat still works when the environment cannot name the terminal', async () => {
  const { deps } = harness([], { env: NONE });
  deps.chat = planChat(planSnapshot);
  deps.input = (async function* () {})();
  assert.equal(await run(['plan', 'chat', '5'], deps), EXIT.ok);
  const failing = harness([], {
    env: {
      name: 'broken',
      nameTerminal: async () => {
        throw new Error('rename failed');
      },
    },
  });
  failing.deps.chat = planChat(planSnapshot);
  failing.deps.input = (async function* () {})();
  assert.equal(await run(['plan', 'chat', '5'], failing.deps), EXIT.ok);
});

test('plan open still opens the planning chat in a terminal on the repository', async () => {
  const { deps, opened, out } = harness([]);
  deps.chat = planChat(planSnapshot);
  assert.equal(await run(['plan', 'open', '5', '--json'], deps), EXIT.ok);
  assert.equal(opened[0].cwd, '/repo');
  assert.equal(opened[0].command, 'factory plan chat 5');
  assert.equal(JSON.parse(out[0]).opened, true);
});

test('the environment is picked from the flag, FACTORY_ENV, then the terminal', () => {
  const exec = async () => ({ ok: true, result: {} });
  assert.equal(detectEnvironment({}, exec).name, 'none');
  assert.equal(detectEnvironment({ TERM_PROGRAM: 'Orca' }, exec).name, 'orca');
  assert.equal(
    detectEnvironment({ ORCA_TERMINAL_HANDLE: 'term_1' }, exec).name,
    'orca',
  );
  assert.equal(
    detectEnvironment({ TERM_PROGRAM: 'vscode' }, exec).name,
    'none',
  );
  // The innermost choice wins over what the terminal says.
  assert.equal(
    detectEnvironment({ TERM_PROGRAM: 'Orca', FACTORY_ENV: 'none' }, exec).name,
    'none',
  );
  assert.equal(detectEnvironment({ FACTORY_ENV: 'orca' }, exec).name, 'orca');
  assert.equal(
    detectEnvironment({ FACTORY_ENV: 'none' }, exec, 'ORCA').name,
    'orca',
    'the flag beats the variable, whatever its case',
  );
  assert.throws(
    () => detectEnvironment({}, exec, 'emacs'),
    /Unknown environment "emacs".*orca, none/,
  );
  assert.equal(NONE.openTerminal, undefined);
});

test('Orca opens a terminal in the worktree, registers a missing repository and resolves symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-cli-'));
  const real = join(dir, 'real');
  await mkdir(real);
  const link = join(dir, 'link');
  await symlink(real, link);
  const calls: string[][] = [];
  const env = orcaEnvironment(async (args) => {
    calls.push(args);
    if (args[1] === 'list') return { ok: true, result: { repos: [] } };
    return { ok: true, result: { handle: 'term_9' } };
  });
  const result = await env.openTerminal!({
    cwd: link,
    repository: '/repo',
    command: 'factory watch run_abc123',
    title: 'factory run_abc123',
  });
  // Orca compares paths exactly, so the symlink must be resolved.
  assert.equal(result.cwd, await realpath(real));
  assert.equal(result.terminal, 'term_9');
  assert.deepEqual(calls[1].slice(0, 2), ['repo', 'add']);
  assert.ok(calls[2].includes(`path:${await realpath(real)}`));
  assert.ok(calls[2].includes('factory watch run_abc123'));
});

test('Orca skips registering a repository it already knows', async () => {
  const calls: string[][] = [];
  const env = orcaEnvironment(async (args) => {
    calls.push(args);
    if (args[1] === 'list')
      return { ok: true, result: { repos: [{ path: '/repo' }] } };
    return { ok: true, result: { handle: 't' } };
  });
  await env.openTerminal!({
    cwd: '/repo',
    repository: '/repo',
    command: 'x',
    title: 'y',
  });
  assert.equal(calls.filter((call) => call[1] === 'add').length, 0);
});

test('Orca renames the terminal it runs in, and does nothing outside one', async () => {
  const calls: string[][] = [];
  const exec = async (args: string[]) => (
    calls.push(args),
    { ok: true, result: {} }
  );
  await orcaEnvironment(exec, { ORCA_TERMINAL_HANDLE: 'term_7' }).nameTerminal!(
    'plan: Add search',
  );
  assert.deepEqual(calls[0].slice(0, 5), [
    'terminal',
    'rename',
    '--terminal',
    'term_7',
    '--title',
  ]);
  calls.length = 0;
  await orcaEnvironment(exec, {}).nameTerminal!('x');
  assert.equal(calls.length, 0);
});

test('syncRun marks attention, and tolerates a worktree Orca no longer lists', async () => {
  const calls: string[][] = [];
  const ready = summarize(fixture({ status: 'pr_ready' }));
  assert.equal(
    await syncRun(
      async (args) => (calls.push(args), { ok: true, result: {} }),
      ready,
    ),
    true,
  );
  assert.ok(calls[0].includes('--unread'));
  assert.ok(calls[0].includes('in-review'));
  assert.equal(
    await syncRun(
      async () => ({
        ok: false,
        error: { code: 'selector_not_found', message: 'selector_not_found' },
      }),
      ready,
    ),
    false,
  );
});
