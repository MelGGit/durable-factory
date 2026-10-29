import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startService } from './helpers/credentials.js';
import {
  Configuration,
  context,
  openConfiguration,
} from '../apps/server/src/storage.js';
import {
  ApiError,
  ChatClient,
  DEFAULT_PROJECT_ID,
  projectLabel,
} from '../packages/shared/src/index.js';
import { configure } from './fixtures/chat.js';
import { planningFixture } from './fixtures/planning.js';

const rejects = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'factory-projects-'));
  const repo = async (name: string) => {
    const path = join(directory, name);
    await mkdir(path);
    execFileSync('git', ['init', '-q', path]);
    return path;
  };
  const service = await startService({
    port: 0,
    dataDir: join(directory, 'data'),
    chat: planningFixture(),
  });
  const client = new ChatClient(service.url);
  return {
    repo,
    service,
    client,
    close: async () => {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('settings written before projects become the default project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-legacy-'));
  try {
    const first = await openConfiguration(directory);
    await first.save(0, {
      ...(await first.read()).settings,
      requiredChecks: ['legacy check'],
    });
    await first.harness.commit(async (tx) => {
      const doc = (await tx.doc(Configuration)) as unknown as Record<
        string,
        unknown
      >;
      const project = (
        doc.projects as Record<string, { revision: number; settings: unknown }>
      )[DEFAULT_PROJECT_ID];
      doc.settings = project.settings;
      doc.revision = project.revision;
      delete doc.projects;
      delete doc.order;
    }, context);
    await first.close();
    const reopened = await openConfiguration(directory);
    try {
      const saved = await reopened.read();
      assert.equal(saved.revision, 1);
      assert.deepEqual(saved.settings.requiredChecks, ['legacy check']);
      assert.deepEqual(
        (await reopened.projects()).map((p) => p.id),
        [DEFAULT_PROJECT_ID],
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('projects keep their own settings and conversations', async () => {
  const f = await fixture();
  try {
    await configure(f.client);
    const created = await f.client.createProject('Second');
    // The first project has no name of its own, so the UI shows its folder.
    assert.deepEqual(
      (await f.client.projects()).projects.map((p) => p.name),
      ['', 'Second'],
    );
    const second = new ChatClient(f.service.url, undefined, created.id);
    // A new project inherits the agent models but not the repository.
    const inherited = await second.settings();
    assert.equal(inherited.projectId, created.id);
    assert.equal(inherited.settings.roles.planning.model, 'offline');
    assert.equal(inherited.settings.repository.path, '');

    const path = await f.repo('second');
    inherited.settings.repository = {
      path,
      github: 'example/second',
      baseBranch: 'main',
    };
    await second.saveSettings({
      expectedRevision: inherited.revision,
      settings: inherited.settings,
    });
    assert.equal((await f.client.settings()).settings.repository.path, '');

    await f.client.createConversation('In default', 'default-chat');
    const mine = await second.createConversation('In second', 'second-chat');
    assert.equal(mine.projectId, created.id);
    assert.equal(mine.repository.github, 'example/second');
    assert.deepEqual(
      (await f.client.conversations()).conversations.map((c) => c.title),
      ['In second', 'In default'],
    );
    assert.deepEqual(
      (
        await new ChatClient(
          f.service.url,
          undefined,
          DEFAULT_PROJECT_ID,
        ).conversations()
      ).conversations.map((c) => c.title),
      ['In default'],
    );
    assert.deepEqual(
      (await second.conversations()).conversations.map((c) => c.title),
      ['In second'],
    );
    await assert.rejects(
      new ChatClient(f.service.url, undefined, 'missing').settings(),
      rejects('NOT_FOUND'),
    );
  } finally {
    await f.close();
  }
});

test('project names, repositories and deletion are guarded', async () => {
  const f = await fixture();
  try {
    await configure(f.client);
    const a = await f.client.createProject('A');
    await assert.rejects(f.client.createProject('A'), rejects('CONFLICT'));
    await assert.rejects(
      f.client.createProject('  '),
      rejects('INVALID_INPUT'),
    );
    assert.equal(
      (await f.client.renameProject(a.id, 'Renamed')).name,
      'Renamed',
    );

    const path = await f.repo('shared');
    const save = async (client: ChatClient) => {
      const saved = await client.settings();
      saved.settings.repository = {
        path,
        github: 'example/shared',
        baseBranch: 'main',
      };
      return client.saveSettings({
        expectedRevision: saved.revision,
        settings: saved.settings,
      });
    };
    await save(new ChatClient(f.service.url, undefined, a.id));
    const b = await f.client.createProject('B');
    await assert.rejects(
      save(new ChatClient(f.service.url, undefined, b.id)),
      rejects('CONFLICT'),
    );

    const scoped = new ChatClient(f.service.url, undefined, a.id);
    await scoped.createConversation('Keeps the project', 'keep');
    await assert.rejects(f.client.deleteProject(a.id), rejects('CONFLICT'));
    await f.client.deleteProject(b.id);
    assert.deepEqual(
      (await f.client.projects()).projects.map((p) => p.id),
      [DEFAULT_PROJECT_ID, a.id],
    );
  } finally {
    await f.close();
  }
});

test('the last project cannot be removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-last-'));
  const storage = await openConfiguration(directory);
  try {
    await assert.rejects(
      storage.remove(DEFAULT_PROJECT_ID),
      rejects('CONFLICT'),
    );
  } finally {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a project is called by its name, else by its folder', () => {
  const at = (path: string) => ({ path });
  assert.equal(
    projectLabel({ name: 'Billing', repository: at('/a/b') }),
    'Billing',
  );
  assert.equal(
    projectLabel({ name: '', repository: at('/work/my-app/') }),
    'my-app',
  );
  assert.equal(
    projectLabel({ name: '  ', repository: at('C:\\code\\site') }),
    'site',
  );
  assert.equal(
    projectLabel({ name: '', repository: at('') }),
    'Untitled project',
  );
  // Older data stored this placeholder; it never was a name the user chose.
  assert.equal(
    projectLabel({ name: 'Default project', repository: at('/work/api') }),
    'api',
  );
});

test('the placeholder name from earlier versions is cleared on upgrade, and renaming to nothing resets it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-names-'));
  try {
    const first = await openConfiguration(directory);
    await first.harness.commit(async (tx) => {
      const doc = await tx.doc(Configuration);
      (doc.projects as Record<string, { name: string }>)[
        DEFAULT_PROJECT_ID
      ].name = 'Default project';
    }, context);
    await first.close();
    const storage = await openConfiguration(directory);
    try {
      assert.equal((await storage.read()).name, '');
      await storage.rename(DEFAULT_PROJECT_ID, 'Billing');
      assert.equal((await storage.read()).name, 'Billing');
      await storage.rename(DEFAULT_PROJECT_ID, '  ');
      assert.equal((await storage.read()).name, '');
    } finally {
      await storage.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
