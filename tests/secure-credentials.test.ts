import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PrivateCredentials,
  type CredentialVault,
} from '../apps/server/src/credentials.js';

class MemoryVault implements CredentialVault {
  name = 'Memory test vault';
  entries = new Map<string, string>();
  unavailable = false;
  corruptWrites = false;
  reads = 0;
  async get(id: string) {
    this.reads++;
    if (this.unavailable) throw new Error('secret-native-error');
    return this.entries.get(id);
  }
  async set(id: string, value: string) {
    if (this.unavailable) throw new Error('secret-native-error');
    this.entries.set(id, this.corruptWrites ? 'wrong' : value);
  }
  async delete(id: string) {
    if (this.unavailable) throw new Error('secret-native-error');
    this.entries.delete(id);
  }
}
const oauth = {
  type: 'oauth' as const,
  access: 'fake-access',
  refresh: 'fake-refresh',
  expires: Date.now() + 3600_000,
  clientId: 'issued-client',
  scopes: ['scope'],
  additional: { retained: true },
};

for (const action of ['reconnect', 'disconnect'] as const) {
  test(`stale vault reads cannot overwrite ${action} status`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'vault-stale-read-'));
    const vault = new MemoryVault();
    const store = new PrivateCredentials(directory, vault);
    await store.init();
    await store.replace('openai', oauth);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayNextRead = true;
    const original = vault.get.bind(vault);
    t.mock.method(vault, 'get', async (id: string) => {
      const value = await original(id);
      if (delayNextRead && id.endsWith(':openai')) {
        delayNextRead = false;
        started();
        await gate;
        if (action === 'reconnect') throw new Error('Stale fake vault failure');
      }
      return value;
    });
    const stale = store.read('openai').then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await entered;
      if (action === 'reconnect') {
        const replacement = { ...oauth, refresh: 'fake-reconnected-refresh' };
        await store.replace('openai', replacement);
        release();
        assert.ok('error' in (await stale));
        const snapshot = await store.inspect();
        assert.equal(snapshot.configured.openai, true);
        assert.equal(snapshot.errors.openai, undefined);
        assert.deepEqual(await store.read('openai'), replacement);
      } else {
        await store.delete('openai');
        release();
        await stale;
        assert.equal((await store.inspect()).configured.openai, false);
        assert.deepEqual(await store.list(), []);
        assert.equal(await store.read('openai'), undefined);
      }
    } finally {
      release();
      await stale;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('migrates all credentials privately, preserves provider metadata, and leaves no plaintext credential files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vault-migration-'));
  const vault = new MemoryVault();
  try {
    await mkdir(join(directory, 'credentials'));
    for (const id of ['requesty', 'github', 'openai', 'anthropic'])
      await writeFile(
        join(directory, 'credentials', `${id}.json`),
        JSON.stringify(
          id === 'github' || id === 'requesty'
            ? { type: 'api_key', key: `fake-${id}` }
            : oauth,
        ),
      );
    const store = new PrivateCredentials(directory, vault);
    await store.init();
    assert.deepEqual(await readdir(join(directory, 'credentials')), [
      'write.lock',
    ]);
    assert.deepEqual(await store.read('openai'), oauth);
    const reads = vault.reads;
    assert.equal((await store.list()).length, 4);
    const status = await store.inspect();
    assert.equal(
      vault.reads,
      reads,
      'inspection and enumeration do not read secrets',
    );
    assert.equal(status.storage.status, 'ready');
    assert.doesNotMatch(JSON.stringify(status), /fake-|issued-client/);
    const reopened = new PrivateCredentials(directory, vault);
    await reopened.init();
    assert.deepEqual(await reopened.read('anthropic'), oauth);
    await reopened.delete('anthropic');
    assert.equal(await reopened.read('anthropic'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed migration keeps the old file, never falls back, and retries after unlocking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vault-unavailable-'));
  const vault = new MemoryVault();
  const path = join(directory, 'credentials', 'openai.json');
  try {
    await mkdir(join(directory, 'credentials'));
    await writeFile(path, JSON.stringify(oauth));
    vault.unavailable = true;
    const store = new PrivateCredentials(directory, vault);
    await store.init();
    assert.equal((await store.inspect()).storage.status, 'error');
    await assert.rejects(
      store.read('openai'),
      (error) =>
        error instanceof Error &&
        !error.message.includes('secret-native-error'),
    );
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(oauth));
    vault.unavailable = false;
    await store.retry();
    assert.deepEqual(await store.read('openai'), oauth);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unverified writes preserve legacy credentials; valid vault entries win on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vault-verification-'));
  const vault = new MemoryVault();
  try {
    await mkdir(join(directory, 'credentials'));
    const path = join(directory, 'credentials/openai.json');
    await writeFile(path, JSON.stringify(oauth));
    vault.corruptWrites = true;
    const store = new PrivateCredentials(directory, vault);
    await store.init();
    assert.ok((await store.inspect()).errors.openai);
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(oauth));
    vault.corruptWrites = false;
    await store.replace('openai', { ...oauth, refresh: 'rotated' });
    await writeFile(path, JSON.stringify(oauth)); // Simulate a crash leaving a stale legacy copy.
    const restarted = new PrivateCredentials(directory, vault);
    await restarted.init();
    assert.equal(
      ((await restarted.read('openai')) as typeof oauth).refresh,
      'rotated',
    );
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects symlinks and malformed entries, allows replacement, and isolates data-directory namespaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vault-isolation-'));
  const vault = new MemoryVault();
  try {
    const first = join(directory, 'first'),
      second = join(directory, 'second');
    await mkdir(join(first, 'credentials'), { recursive: true });
    const target = join(directory, 'untouched.json');
    await writeFile(target, JSON.stringify(oauth));
    await symlink(target, join(first, 'credentials/openai.json'));
    const a = new PrivateCredentials(first, vault),
      b = new PrivateCredentials(second, vault);
    await a.init();
    await b.init();
    assert.ok((await a.inspect()).errors.openai);
    await a.replace('openai', oauth);
    assert.equal(await readFile(target, 'utf8'), JSON.stringify(oauth));
    assert.deepEqual(await a.read('openai'), oauth);
    assert.equal(await b.read('openai'), undefined);
    await a.delete('openai');
    await a.retry();
    assert.equal(await a.read('openai'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
