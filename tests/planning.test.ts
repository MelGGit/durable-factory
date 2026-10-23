import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  realpath,
  mkdtemp,
  rm,
  writeFile,
  symlink,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startService } from '../apps/server/src/service.js';
import { ChatClient } from '../packages/shared/src/index.js';
import { configure, until } from './fixtures/chat.js';
import { FakeGitHub, planningFixture, ticket } from './fixtures/planning.js';
import { RepositoryReader } from '../apps/server/src/repository.js';
import { ticketBody } from '../apps/server/src/planning.js';

async function setup(github = new FakeGitHub()) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-planning-'));
  const dataDir = join(directory, 'data'),
    repo = join(directory, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  const service = await startService({
    dataDir,
    port: 0,
    chat: planningFixture(),
    github,
  });
  const client = new ChatClient(service.url);
  await configure(client);
  const saved = await client.settings();
  saved.settings.repository = {
    path: repo,
    github: 'example/project',
    baseBranch: 'main',
  };
  await client.saveSettings({
    expectedRevision: saved.revision,
    settings: saved.settings,
  });
  const conversation = await client.createConversation(
    'Planning',
    'planning-create',
  );
  return { service, client, conversation, directory, dataDir, repo, github };
}
async function send(
  client: ChatClient,
  id: string,
  content: string,
  requestId: string,
) {
  const submission = await client.submit(id, content, requestId);
  await until(
    () => client.submission(id, requestId),
    (s) => ['completed', 'failed'].includes(s.status),
  );
  return submission;
}

test('saved tickets and proposals remain serializable after commits, replays, and later changes', async () => {
  const s = await setup();
  try {
    const id = s.conversation.id;
    const saved = await s.service.planning.save(id, ticket, 'save');
    const expected = (await s.service.planning.read(id))!.ticket!;
    const responses: unknown[] = [];
    const serialized: string[] = [];
    const remember = (value: unknown) => {
      const json = JSON.stringify(value);
      responses.push(value);
      serialized.push(json);
      return JSON.parse(json);
    };
    assert.deepEqual(remember(saved), expected);
    assert.deepEqual(
      remember(await s.service.planning.save(id, ticket, 'save')),
      expected,
    );
    assert.deepEqual(
      remember(await s.service.planning.save(id, ticket, 'unchanged-save')),
      expected,
    );
    const proposal = remember(await s.service.planning.propose(id));
    assert.deepEqual(proposal.ticket, expected);
    assert.equal(proposal.issueBody, ticketBody(expected));
    assert.deepEqual(remember(await s.service.planning.propose(id)), proposal);
    await s.service.planning.save(
      id,
      { ...ticket, goal: 'A changed goal' },
      'changed-save',
    );
    assert.equal((await s.service.planning.read(id))!.ticket!.revision, 2);
    responses.forEach((value, index) => {
      assert.equal(JSON.stringify(value), serialized[index]);
    });
    assert.equal(s.github.calls, 0);
  } finally {
    await s.service.close();
    await rm(s.directory, { recursive: true, force: true });
  }
});

test('planner tools save and propose, explicit chat approval creates one issue and snapshots restore', async () => {
  const s = await setup();
  let stop: (() => void) | undefined;
  try {
    let planning: any;
    stop = s.client.watch(
      s.conversation.id,
      (snapshot) => {
        planning = snapshot.planning;
      },
      () => {},
    );
    await send(s.client, s.conversation.id, 'plan', 'plan-1');
    await until(
      async () => planning,
      (p) => Boolean(p?.proposal),
    );
    assert.equal(planning.ticket.title, ticket.title);
    const results = (await s.client.history(s.conversation.id)).entries
      .flatMap((entry) => entry.tools)
      .filter((tool) => tool.output !== undefined);
    assert.deepEqual(
      results.map((tool) => [tool.name, tool.status]),
      [
        ['save_ticket', 'completed'],
        ['propose_issue', 'completed'],
      ],
    );
    assert.deepEqual(JSON.parse(results[0].output!), planning.ticket);
    const proposal = JSON.parse(results[1].output!);
    assert.deepEqual(proposal.ticket, planning.ticket);
    assert.equal(proposal.issueBody, ticketBody(planning.ticket));
    assert.equal(s.github.calls, 0);
    await send(s.client, s.conversation.id, 'force create', 'unauthorized');
    assert.equal(s.github.calls, 0);
    await s.service.planning.propose(s.conversation.id);
    await send(s.client, s.conversation.id, 'yes', 'approval-1');
    await until(
      async () => planning,
      (p) => p?.operation?.state === 'created',
    );
    assert.equal(s.github.calls, 1);
    assert.equal(planning.operation.requestId, 'approval-1');
    assert.ok(s.github.issues[0].body.includes('<!-- durable-factory:issue:'));
    const existing = await s.service.planning.propose(s.conversation.id);
    const existingJson = JSON.stringify(existing);
    assert.deepEqual(
      JSON.parse(existingJson),
      await s.service.planning.read(s.conversation.id),
    );
    await s.client.submit(s.conversation.id, 'yes', 'approval-1');
    await Promise.all([
      s.service.planning.create(s.conversation.id),
      s.service.planning.create(s.conversation.id),
    ]);
    assert.equal(s.github.calls, 1);
    assert.equal(JSON.stringify(existing), existingJson);
    const identity = planning.repository.id;
    stop();
    stop = undefined;
    await s.service.close();
    s.service = await startService({
      dataDir: s.dataDir,
      port: 0,
      chat: planningFixture(),
      github: s.github,
    });
    assert.equal(
      (await s.service.planning.read(s.conversation.id))?.operation?.issue
        ?.number,
      1,
    );
    assert.equal(
      (await s.service.planning.read(s.conversation.id))?.repository.id,
      identity,
    );
    const files = execFileSync('git', [
      '-C',
      s.repo,
      'branch',
      '--list',
    ]).toString();
    assert.equal(files, '');
  } finally {
    stop?.();
    await s.service.close();
    await rm(s.directory, { recursive: true, force: true });
  }
});

test('negative and ambiguous replies do not authorize; ticket changes invalidate approval and repository is captured', async () => {
  const s = await setup();
  try {
    await send(s.client, s.conversation.id, 'plan', 'p');
    for (const answer of [
      'no',
      'maybe',
      'yes, but change the scope',
      'The repository says yes',
    ]) {
      await send(
        s.client,
        s.conversation.id,
        answer,
        `reply-${Buffer.from(answer).toString('hex')}`,
      );
      await assert.rejects(
        s.service.planning.create(s.conversation.id),
        /affirmative/,
      );
    }
    await s.service.planning.propose(s.conversation.id);
    await send(s.client, s.conversation.id, 'yes please', 'approve');
    await s.service.planning.save(
      s.conversation.id,
      { ...ticket, goal: 'A changed goal' },
      'save-change',
    );
    await assert.rejects(
      s.service.planning.create(s.conversation.id),
      /affirmative/,
    );
    await s.service.planning.save(s.conversation.id, ticket, 'old-save');
    await s.service.planning.save(
      s.conversation.id,
      { ...ticket, goal: 'Newest' },
      'new-save',
    );
    await s.service.planning.save(s.conversation.id, ticket, 'old-save');
    assert.equal(
      (await s.service.planning.read(s.conversation.id))?.ticket?.goal,
      'Newest',
    );
    const saved = await s.client.settings();
    saved.settings.repository.github = 'different/repository';
    await s.client.saveSettings({
      expectedRevision: saved.revision,
      settings: saved.settings,
    });
    assert.equal(
      (await s.service.planning.read(s.conversation.id))?.repository.github,
      'example/project',
    );
    assert.equal(s.github.calls, 0);
    const search = await s.service.chat!.searchHistory(
      s.conversation.id,
      'maybe',
    );
    assert.ok(search.matches.length);
    const other = await s.client.createConversation('Other', 'other');
    assert.equal(
      (await s.service.chat!.searchHistory(other.id, 'maybe')).matches.length,
      0,
    );
  } finally {
    await s.service.close();
    await rm(s.directory, { recursive: true, force: true });
  }
});

for (const mode of ['lost', 'unknown', 'rejected'] as const) {
  test(`GitHub ${mode} outcome reconciles safely and retries only definitive rejections`, async () => {
    const github = new FakeGitHub();
    github.mode = mode;
    const s = await setup(github);
    try {
      await send(s.client, s.conversation.id, 'plan', 'p');
      await send(s.client, s.conversation.id, 'yes', 'y');
      assert.equal(github.calls, 1);
      github.mode = 'success';
      const result = await s.client.retryIssue(s.conversation.id);
      assert.equal(github.calls, mode === 'rejected' ? 2 : 1);
      assert.equal(
        result.operation?.state,
        mode === 'unknown' ? 'uncertain' : 'created',
      );
      await s.service.close();
      s.service = await startService({
        dataDir: s.dataDir,
        port: 0,
        chat: planningFixture(),
        github,
      });
      assert.equal(github.calls, mode === 'rejected' ? 2 : 1);
    } finally {
      await s.service.close();
      await rm(s.directory, { recursive: true, force: true });
    }
  });
}

test('reconciliation scans all pages, ignores pull requests, and blocks duplicate markers', async () => {
  const github = new FakeGitHub();
  github.mode = 'unknown';
  const s = await setup(github);
  try {
    await send(s.client, s.conversation.id, 'plan', 'p');
    await send(s.client, s.conversation.id, 'yes', 'y');
    const op = (await s.service.planning.read(s.conversation.id))!.operation!;
    const marker = `<!-- durable-factory:issue:${op.id} -->`;
    github.issues = Array.from({ length: 4 }, (_, i) => ({
      number: i + 1,
      url: `https://github.com/example/project/issues/${i + 1}`,
      body: i === 0 || i === 3 ? marker : '',
      ...(i === 0 ? { pullRequest: true } : {}),
    }));
    const result = await s.client.retryIssue(s.conversation.id);
    assert.equal(result.operation?.issue?.number, 4);
    assert.ok(github.pages.includes(2));
    // A separate uncertain operation with two issue matches must stop for inspection.
    const other = await s.client.createConversation('Another issue', 'other');
    await send(s.client, other.id, 'plan', 'p');
    await send(s.client, other.id, 'yes', 'y');
    const op2 = (await s.service.planning.read(other.id))!.operation!;
    github.issues.push(
      ...[5, 6].map((number) => ({
        number,
        url: `https://github.com/example/project/issues/${number}`,
        body: `<!-- durable-factory:issue:${op2.id} -->`,
      })),
    );
    assert.equal(
      (await s.client.retryIssue(other.id)).operation?.state,
      'blocked',
    );
    github.issues = github.issues.filter((issue) => issue.number !== 6);
    assert.equal(
      (await s.client.retryIssue(other.id)).operation?.issue?.number,
      5,
    );
    assert.equal(github.calls, 2);
  } finally {
    await s.service.close();
    await rm(s.directory, { recursive: true, force: true });
  }
});

test('repository tools inspect current files and reject ignored files, traversal, symlinks and binary data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-reader-'));
  const repo = join(directory, 'repo');
  try {
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(repo, 'ignored.txt'), 'secret');
    await writeFile(join(directory, 'outside.txt'), 'secret');
    await writeFile(
      join(repo, 'current.txt'),
      'uncommitted searchable content',
    );
    await writeFile(join(repo, 'binary'), Buffer.from([0, 1, 2]));
    await writeFile(join(repo, 'large.txt'), 'x'.repeat(70000));
    await symlink(join(directory, 'outside.txt'), join(repo, 'escape'));
    await symlink(directory, join(repo, 'linked'));
    const reader = new RepositoryReader(await realpath(repo));
    assert.equal(
      (await reader.read('current.txt')).text,
      'uncommitted searchable content',
    );
    assert.equal((await reader.read('large.txt')).truncated, true);
    assert.equal((await reader.search('searchable')).matches.length, 1);
    for (const path of [
      'ignored.txt',
      '../outside.txt',
      'escape',
      'linked/outside.txt',
      '.git/config',
      resolve(directory, 'outside.txt'),
      'binary',
    ])
      await assert.rejects(reader.read(path));
    assert.ok(!(await reader.list()).files.includes('escape'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'SIGKILL after GitHub creates an issue restores the original operation and approving submission',
  { timeout: 30000 },
  async () => {
    const { fork } = await import('node:child_process');
    const { readFile } = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'factory-issue-crash-'));
    const repo = join(directory, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    const dataDir = join(directory, 'data');
    const worker = (mode: string) =>
      fork(
        resolve('scripts/planning-recovery-worker.ts'),
        [dataDir, repo, mode],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
    function message(
      child: ReturnType<typeof worker>,
      phase: string,
    ): Promise<any> {
      return new Promise((resolveMessage, reject) => {
        let errors = '';
        child.stderr?.on('data', (chunk) => {
          errors += chunk;
        });
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`No ${phase}: ${errors}`));
        }, 15000);
        const onExit = () => {
          cleanup();
          reject(new Error(`Worker exited before ${phase}: ${errors}`));
        };
        const onMessage = (value: any) => {
          if (value.phase === phase) {
            cleanup();
            resolveMessage(value);
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          child.off('message', onMessage);
          child.off('exit', onExit);
        };
        child.on('message', onMessage);
        child.on('exit', onExit);
      });
    }
    let child = worker('crash');
    try {
      await message(child, 'effect');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      child = worker('recover');
      const done = await message(child, 'done');
      assert.equal(done.planning.operation.state, 'created');
      assert.equal(done.planning.operation.issue.number, 42);
      assert.equal(done.planning.operation.requestId, 'approve-issue');
      assert.equal(done.submission.status, 'completed');
      assert.equal(
        await readFile(join(dataDir, 'create-calls.txt'), 'utf8'),
        'POST\n',
      );
      if (child.exitCode === null) await once(child, 'exit');
    } finally {
      child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('queued or withdrawn approval cannot authorize creation before consumption', async () => {
  const { fixture } = await import('./fixtures/chat.js');
  const s = await setup();
  try {
    await send(s.client, s.conversation.id, 'plan', 'plan');
    // A slow independent conversation exercises native Pi queued input admission.
    await s.service.close();
    s.service = await startService({
      dataDir: s.dataDir,
      port: 0,
      chat: fixture(15),
      github: s.github,
    });
    const client = new ChatClient(s.service.url);
    await client.submit(
      s.conversation.id,
      'Keep planning for a long time. '.repeat(20),
      'busy',
    );
    await s.service.planning.propose(s.conversation.id);
    const approval = await client.submit(
      s.conversation.id,
      'yes',
      'queued-approval',
    );
    assert.equal(approval.status, 'queued');
    await assert.rejects(
      s.service.planning.create(s.conversation.id),
      /not been consumed/,
    );
    await client.withdraw(s.conversation.id, approval.id);
    await assert.rejects(
      s.service.planning.create(s.conversation.id),
      /not been consumed/,
    );
    assert.equal(s.github.calls, 0);
    await client.interrupt(s.conversation.id);
  } finally {
    await s.service.close();
    await rm(s.directory, { recursive: true, force: true });
  }
});

test('repository changes show working edits and deletions while ignored tracked files stay excluded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-changes-'));
  try {
    execFileSync('git', ['init', '-q', directory]);
    const reader = new RepositoryReader(await realpath(directory));
    assert.deepEqual((await reader.changes()).changes, []);
    await writeFile(join(directory, 'edited'), 'original\n');
    await writeFile(join(directory, 'deleted'), 'remove me\n');
    await writeFile(join(directory, 'secret'), 'excluded\n');
    execFileSync('git', ['-C', directory, 'add', '.']);
    execFileSync('git', [
      '-C',
      directory,
      '-c',
      'user.name=Offline',
      '-c',
      'user.email=offline@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'Baseline',
    ]);
    await writeFile(join(directory, 'edited'), 'new working content\n');
    await rm(join(directory, 'deleted'));
    await writeFile(join(directory, '.gitignore'), 'secret\n');
    await writeFile(join(directory, 'secret'), 'hidden changes\n');
    const changes = JSON.stringify(await reader.changes());
    assert.ok(changes.includes('new working content'));
    assert.ok(changes.includes('deleted file'));
    assert.ok(!changes.includes('hidden changes'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stage 3 conversations gain planning registration and tools without replacing history or model settings', async () => {
  const { openConfiguration } = await import('../apps/server/src/storage.js');
  const { ChatService } = await import('../apps/server/src/chat.js');
  const { fixture } = await import('./fixtures/chat.js');
  const { defaultSettings } = await import('../packages/shared/src/index.js');
  const directory = await mkdtemp(join(tmpdir(), 'factory-planning-upgrade-'));
  const dataDir = join(directory, 'data');
  await mkdir(dataDir);
  const deps = fixture();
  const { createRegistry } = await import(
    '../apps/server/src/chat-fixtures.js'
  );
  const store = await openConfiguration(dataDir, {
    models: deps.models,
    registry: createRegistry(),
  });
  let id: string;
  try {
    const settings = defaultSettings();
    settings.roles.planning = {
      provider: 'requesty',
      model: 'offline',
      reasoning: null,
    };
    settings.repository = {
      path: resolve('.'),
      github: 'example/original',
      baseBranch: 'develop',
    };
    await store.save(0, settings);
    const legacy = new ChatService(store.harness, dataDir, () => store.read(), {
      models: deps.models,
    });
    const conversation = await legacy.create({
      title: 'Legacy planning',
      requestId: 'legacy-create',
    });
    id = conversation.id;
    await legacy.submit(id, {
      content: 'Original decision',
      requestId: 'legacy-message',
    });
    store.harness.resume();
    await until(
      () => legacy.lookup(id, 'legacy-message'),
      (s) => s.status === 'completed',
    );
    await legacy.close();
  } finally {
    await store.close();
  }
  const service = await startService({
    dataDir,
    port: 0,
    chat: planningFixture(),
    github: new FakeGitHub(),
  });
  try {
    const planning = await service.planning.read(id!);
    assert.equal(planning?.repository.github, 'example/original');
    assert.equal(planning?.repository.baseBranch, 'develop');
    const client = new ChatClient(service.url);
    assert.equal(
      (await client.conversations()).conversations[0].model.model,
      'offline',
    );
    assert.ok(
      (await client.history(id!)).entries.some(
        (entry) => entry.text === 'Original decision',
      ),
    );
    await send(client, id!, 'plan', 'new-plan');
    assert.equal(
      (await service.planning.read(id!))?.ticket?.title,
      ticket.title,
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('read-only repository diffs never execute repository-defined clean or process filters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-filter-'));
  try {
    execFileSync('git', ['init', '-q', directory]);
    await writeFile(join(directory, 'file'), 'original\n');
    execFileSync('git', ['-C', directory, 'add', '.']);
    execFileSync('git', [
      '-C',
      directory,
      '-c',
      'user.name=Offline',
      '-c',
      'user.email=offline@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'Baseline',
    ]);
    await writeFile(
      join(directory, '.gitattributes'),
      'file filter=untrusted\n',
    );
    execFileSync('git', [
      '-C',
      directory,
      'config',
      'filter.untrusted.clean',
      'touch FILTER_EXECUTED; cat',
    ]);
    execFileSync('git', [
      '-C',
      directory,
      'config',
      'filter.untrusted.process',
      'touch FILTER_EXECUTED',
    ]);
    execFileSync('git', [
      '-C',
      directory,
      'config',
      'filter.untrusted.required',
      'true',
    ]);
    await writeFile(join(directory, 'file'), 'changed\n');
    const reader = new RepositoryReader(await realpath(directory));
    assert.ok(JSON.stringify(await reader.changes()).includes('changed'));
    const { stat } = await import('node:fs/promises');
    await assert.rejects(stat(join(directory, 'FILTER_EXECUTED')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Git inspection stays inside the registered root when core.worktree points elsewhere', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-worktree-boundary-'));
  try {
    const parent = await realpath(directory);
    const root = join(parent, 'repo'),
      outside = join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    execFileSync('git', ['init', '-q', root]);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    await writeFile(join(root, 'file'), 'baseline\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Offline',
      '-c',
      'user.email=offline@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'Baseline',
    );
    await writeFile(join(root, 'file'), 'registered root content\n');
    await writeFile(join(root, 'root-only'), 'local\n');
    await writeFile(join(outside, 'file'), 'OUTSIDE SECRET\n');
    await writeFile(join(outside, 'outside-only'), 'external\n');
    git('config', 'core.worktree', outside);
    const reader = new RepositoryReader(root);
    const list = await reader.list();
    assert.ok(list.files.includes('root-only'));
    assert.ok(!list.files.includes('outside-only'));
    assert.equal((await reader.read('file')).text, 'registered root content\n');
    const changes = JSON.stringify(await reader.changes());
    assert.ok(changes.includes('registered root content'));
    assert.ok(!changes.includes('OUTSIDE SECRET'));
    assert.equal(git('config', '--get', 'core.worktree').trim(), outside);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'interrupting a paused GitHub lookup prevents a subsequent POST and permits an explicit retry',
  { timeout: 20000 },
  async () => {
    const github = new FakeGitHub();
    let release!: () => void, entered!: () => void;
    let signal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    github.list = async (
      _repository: string,
      _page: number,
      requestSignal?: AbortSignal,
    ) => {
      signal = requestSignal;
      entered();
      // A deliberately uncooperative adapter also exercises the post-await gate.
      await gate;
      return { issues: [], hasNext: false };
    };
    const s = await setup(github);
    try {
      await send(s.client, s.conversation.id, 'plan', 'p');
      await s.client.submit(s.conversation.id, 'yes', 'approve');
      await started;
      const operationId = (await s.service.planning.read(s.conversation.id))!
        .operation!.id;
      await s.client.interrupt(s.conversation.id);
      await until(async () => signal?.aborted, Boolean);
      release();
      await until(
        () => s.client.submission(s.conversation.id, 'approve'),
        (value) => value.status === 'interrupted',
      );
      const planning = await s.service.planning.read(s.conversation.id);
      assert.equal(github.calls, 0);
      assert.equal(planning?.operation?.state, 'prepared');
      await s.service.close();
      s.service = await startService({
        dataDir: s.dataDir,
        port: 0,
        chat: planningFixture(),
        github,
      });
      assert.equal(github.calls, 0);
      const retried = await new ChatClient(s.service.url).retryIssue(
        s.conversation.id,
      );
      assert.equal(retried.operation?.state, 'created');
      assert.equal(retried.operation?.id, operationId);
      assert.equal(github.calls, 1);
    } finally {
      release();
      await s.service.close();
      await rm(s.directory, { recursive: true, force: true });
    }
  },
);

test(
  'interrupting an already-issued POST preserves its confirmed result without another creation',
  { timeout: 20000 },
  async () => {
    const github = new FakeGitHub();
    const originalCreate = github.create.bind(github);
    let release!: () => void, entered!: () => void;
    let signal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    github.create = async (
      repository: string,
      title: string,
      body: string,
      requestSignal?: AbortSignal,
    ) => {
      const issue = await originalCreate(repository, title, body);
      signal = requestSignal;
      entered();
      await gate;
      return issue;
    };
    const s = await setup(github);
    try {
      await send(s.client, s.conversation.id, 'plan', 'p');
      await s.client.submit(s.conversation.id, 'yes', 'approve');
      await started;
      await s.client.interrupt(s.conversation.id);
      await until(async () => signal?.aborted, Boolean);
      release();
      await until(
        () => s.client.submission(s.conversation.id, 'approve'),
        (value) => value.status === 'interrupted',
      );
      const planning = await s.service.planning.read(s.conversation.id);
      assert.equal(planning?.operation?.state, 'created');
      assert.equal(planning?.operation?.issue?.number, 1);
      assert.equal(
        (await s.client.retryIssue(s.conversation.id)).operation?.issue?.number,
        1,
      );
      assert.equal(github.calls, 1);
    } finally {
      release();
      await s.service.close();
      await rm(s.directory, { recursive: true, force: true });
    }
  },
);

test(
  'an interrupted POST with a lost response stays uncertain until reconciliation finds the created issue',
  { timeout: 20000 },
  async () => {
    const github = new FakeGitHub();
    const originalCreate = github.create.bind(github);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    github.create = async (
      repository: string,
      title: string,
      body: string,
      signal?: AbortSignal,
    ) => {
      await originalCreate(repository, title, body);
      assert.ok(signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('Response interrupted after creation')),
          { once: true },
        );
        entered();
      });
    };
    const s = await setup(github);
    try {
      await send(s.client, s.conversation.id, 'plan', 'p');
      await s.client.submit(s.conversation.id, 'yes', 'approve');
      await started;
      await s.client.interrupt(s.conversation.id);
      await until(
        () => s.client.submission(s.conversation.id, 'approve'),
        (value) => value.status === 'interrupted',
      );
      assert.equal(
        (await s.service.planning.read(s.conversation.id))?.operation?.state,
        'uncertain',
      );
      const result = await s.client.retryIssue(s.conversation.id);
      assert.equal(result.operation?.state, 'created');
      assert.equal(result.operation?.issue?.number, 1);
      assert.equal(github.calls, 1);
    } finally {
      await s.service.close();
      await rm(s.directory, { recursive: true, force: true });
    }
  },
);

test('oversized acceptance checklists are rejected before changing a proposed ticket', async () => {
  const s = await setup();
  try {
    await send(s.client, s.conversation.id, 'plan', 'criterion-limit-plan');
    const before = await s.service.planning.read(s.conversation.id);
    await assert.rejects(
      s.service.planning.save(
        s.conversation.id,
        {
          ...ticket,
          acceptanceCriteria: Array.from(
            { length: 101 },
            (_, i) => `AC-${i + 1}: Outcome ${i + 1}`,
          ).join('\n'),
        },
        'criterion-limit-save',
      ),
      /at most 100/,
    );
    const after = await s.service.planning.read(s.conversation.id);
    assert.deepEqual(after!.ticket, before!.ticket);
    assert.deepEqual(after!.proposal, before!.proposal);
    assert.equal(s.github.calls, 0);
  } finally {
    await s.service.close();
    await rm(s.directory, { recursive: true, force: true });
  }
});
