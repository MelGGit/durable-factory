import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../apps/server/src/service.js';
import { FactoryClient, ApiError } from '../packages/shared/src/index.js';
import { PrivateCredentials } from '../apps/server/src/credentials.js';
import {
  openConfiguration,
  Configuration,
  context,
} from '../apps/server/src/storage.js';

test('brand icons are served with browser image types and their original bytes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-icons-'));
  const webDir = join(process.cwd(), 'apps/web/public');
  const service = await startService({ dataDir, port: 0, webDir });
  try {
    for (const [filename, mime] of [
      ['durable-factory-icon-32.png', 'image/png'],
      ['durable-factory-logo.png', 'image/png'],
      ['favicon.ico', 'image/x-icon'],
    ]) {
      const response = await fetch(`${service.url}/${filename}?v=2`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), mime);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        await readFile(join(webDir, filename)),
      );
    }
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('settings persist, revisions reject stale updates, credentials stay private, HTTP boundaries hold', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-api-'));
  let service = await startService({ dataDir, port: 0 });
  try {
    const client = new FactoryClient(service.url);
    await client.connect();
    const initial = await client.settings();
    assert.equal(initial.revision, 0);
    assert.deepEqual(initial.credentials, {
      requesty: false,
      openai: false,
      anthropic: false,
      github: false,
    });
    assert.equal((await fetch(`${service.url}/health`)).status, 200);
    assert.equal((await fetch(`${service.url}/ready`)).status, 200);
    const settings = structuredClone(initial.settings);
    settings.requiredChecks = ['echo do-not-execute'];
    settings.timeouts.check = 123;
    const saved = await client.saveSettings({ expectedRevision: 0, settings });
    assert.equal(saved.revision, 1);
    await assert.rejects(
      client.saveSettings({ expectedRevision: 0, settings }),
      (error) => error instanceof ApiError && error.code === 'CONFLICT',
    );
    const invalid = structuredClone(settings);
    invalid.timeouts.check = -1;
    await assert.rejects(
      client.saveSettings({ expectedRevision: 1, settings: invalid }),
      (error) => error instanceof ApiError && error.code === 'INVALID_INPUT',
    );
    await client.saveCredential('requesty', 'secret-fixture-requesty');
    await client.saveCredential('github', 'secret-fixture-github');
    const publicSettings = await client.settings();
    assert.equal(publicSettings.credentials.requesty, true);
    assert.ok(!JSON.stringify(publicSettings).includes('secret-fixture'));
    assert.ok(
      !JSON.stringify(await client.providers()).includes('secret-fixture'),
    );
    assert.equal(
      (await stat(join(dataDir, 'credentials/requesty.json'))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await stat(join(dataDir, 'credentials'))).mode & 0o777,
      0o700,
    );
    assert.equal(
      (
        await fetch(`${service.url}/api/v1/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: 1, settings }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${service.url}/api/v1/session`, {
          headers: { origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    assert.equal(
      await new Promise<number>((resolve) => {
        const req = request(
          `${service.url}/api/v1/session`,
          { headers: { host: 'evil.example' } },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        req.end();
      }),
      403,
    );
    assert.equal((await fetch(`${service.url}/api/v2/settings`)).status, 400);
    const duplicate = await startService({ dataDir, port: 0 });
    assert.equal((await fetch(`${duplicate.url}/ready`)).status, 503);
    assert.equal((await fetch(`${duplicate.url}/health`)).status, 200);
    await duplicate.close();
    await service.close();
    service = await startService({ dataDir, port: 0 });
    const restoredClient = new FactoryClient(service.url);
    await restoredClient.connect();
    const restored = await restoredClient.settings();
    assert.equal(restored.revision, 1);
    assert.deepEqual(restored.settings, settings);
    assert.equal(restored.credentials.github, true);
    await restoredClient.deleteCredential('requesty');
    assert.equal((await restoredClient.settings()).credentials.requesty, false);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('newer application schema blocks readiness and writes without replacing data', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-schema-'));
  try {
    const storage = await openConfiguration(dataDir);
    await storage.harness.commit(async (tx) => {
      const value = await tx.doc(Configuration);
      value.schemaVersion = 99;
    }, context);
    await storage.close();
    const before = await readFile(join(dataDir, 'factory.sqlite'));
    const service = await startService({ dataDir, port: 0 });
    try {
      const response = await fetch(`${service.url}/ready`);
      assert.equal(response.status, 503);
      assert.match(
        JSON.stringify(await response.json()),
        /compatible app version/,
      );
      assert.equal(
        (await fetch(`${service.url}/api/v1/settings`, { method: 'PUT' }))
          .status,
        503,
      );
    } finally {
      await service.close();
    }
    const after = await readFile(join(dataDir, 'factory.sqlite'));
    assert.deepEqual(after, before);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('concurrent credential modifications serialize and do not lose rotated tokens', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-credentials-'));
  try {
    const store = new PrivateCredentials(dataDir);
    await store.init();
    await store.modify('openai', async () => ({
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 1,
      generation: 0,
    }));
    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.modify('openai', async (current) => {
          assert.equal(current?.type, 'oauth');
          if (current?.type !== 'oauth') throw new Error();
          return { ...current, generation: Number(current.generation) + 1 };
        }),
      ),
    );
    const credential = await store.read('openai');
    assert.equal(credential?.type === 'oauth' && credential.generation, 5);
    assert.deepEqual(await store.list(), [
      { providerId: 'openai', type: 'oauth' },
    ]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('credential damage stays isolated while settings remain editable and connections can be repaired', async () => {
  const { writeFile } = await import('node:fs/promises');
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-damaged-credential-'));
  const service = await startService({ dataDir, port: 0 });
  try {
    const client = new FactoryClient(service.url);
    await client.connect();
    await client.saveCredential('requesty', 'healthy-requesty-fixture');
    await writeFile(
      join(dataDir, 'credentials/openai.json'),
      '{"access":"broken-secret-fixture",',
      { mode: 0o600 },
    );
    await writeFile(join(dataDir, 'credentials/github.json'), 'null', {
      mode: 0o600,
    });
    const snapshot = await client.settings();
    assert.equal(snapshot.credentials.requesty, true);
    assert.equal(snapshot.credentials.openai, false);
    assert.ok(snapshot.credentialErrors.openai);
    assert.ok(snapshot.credentialErrors.github);
    const openai = snapshot.providers.find(
      (provider) => provider.id === 'openai',
    )!;
    assert.equal(openai.status, 'error');
    assert.ok(openai.models.length > 0);
    assert.ok(!JSON.stringify(snapshot).includes('broken-secret-fixture'));
    const settings = structuredClone(snapshot.settings);
    const model = openai.models.find((model) =>
      model.reasoning.includes('high'),
    )!;
    settings.roles.planning = {
      provider: 'openai',
      model: model.id,
      reasoning: 'high',
    };
    const saved = await client.saveSettings({
      expectedRevision: snapshot.revision,
      settings,
    });
    assert.equal(saved.revision, 1);
    assert.ok(saved.credentialErrors.openai);
    assert.equal((await fetch(`${service.url}/ready`)).status, 200);
    await client.saveCredential('github', 'replacement-github-fixture');
    assert.equal((await client.settings()).credentials.github, true);
    assert.equal((await client.settings()).credentialErrors.github, undefined);
    await client.deleteCredential('openai');
    const repaired = await client.settings();
    assert.equal(repaired.credentialErrors.openai, undefined);
    assert.equal(
      repaired.providers.find((provider) => provider.id === 'openai')!.status,
      'not_configured',
    );
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
