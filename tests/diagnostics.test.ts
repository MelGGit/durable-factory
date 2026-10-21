import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDiagnostic } from '../apps/server/src/diagnostics.js';
import { ApiError } from '../packages/shared/src/index.js';

test('real checks require an explicit model and stored credentials without ambient fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-diagnostic-'));
  const previous = process.env.DURABLE_FACTORY_DATA_DIR;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.DURABLE_FACTORY_DATA_DIR = directory;
  process.env.OPENAI_API_KEY = 'ambient-fixture-never-used';
  try {
    await assert.rejects(
      runDiagnostic(['check', 'openai']),
      (error) => error instanceof ApiError && error.code === 'INVALID_INPUT',
    );
    for (const provider of ['requesty', 'openai', 'anthropic']) {
      await assert.rejects(
        runDiagnostic(['check', provider, 'explicit-model']),
        (error) => error instanceof ApiError && error.code === 'AUTHENTICATION',
      );
    }
    const result = await readFile(
      join(directory, 'provider-checks.json'),
      'utf8',
    );
    assert.ok(!result.includes('ambient-fixture'));
    const records = JSON.parse(result);
    for (const provider of ['requesty', 'openai', 'anthropic'])
      assert.equal(records[`${provider}:check`].status, 'blocked');
  } finally {
    if (previous === undefined) delete process.env.DURABLE_FACTORY_DATA_DIR;
    else process.env.DURABLE_FACTORY_DATA_DIR = previous;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider-owned refresh persists ordinary renewed tokens and preserves credentials on failure or cancellation', async () => {
  const { PrivateCredentials } = await import(
    '../apps/server/src/credentials.js'
  );
  const { createFactoryModels, refreshProviderCredentials } = await import(
    '../apps/server/src/providers.js'
  );
  const directory = await mkdtemp(join(tmpdir(), 'factory-refresh-'));
  try {
    const credentials = new PrivateCredentials(directory);
    await credentials.init();
    for (const providerId of ['openai', 'anthropic']) {
      const original = {
        type: 'oauth' as const,
        access: 'original-access',
        refresh: 'original-refresh',
        expires: Date.now() + 3600000,
      };
      await credentials.modify(providerId, async () => original);
      const models = createFactoryModels(credentials);
      const oauth = models.getProvider(providerId)!.auth.oauth!;
      let refreshes = 0;
      oauth.refresh = async (current, signal) => {
        assert.equal(signal.aborted, false);
        refreshes++;
        return {
          ...current,
          access: 'renewed-access',
          refresh: 'renewed-refresh',
          expires: Date.now() + 3600000,
        };
      };
      oauth.toAuth = async (current) => ({ apiKey: current.access });
      await refreshProviderCredentials(
        models,
        credentials,
        providerId,
        new AbortController().signal,
      );
      assert.equal(refreshes, 1);
      assert.equal(
        (await models.getAuth(providerId))?.auth.apiKey,
        'renewed-access',
      );
      const renewed = await credentials.read(providerId);
      assert.equal(
        renewed?.type === 'oauth' && renewed.refresh,
        'renewed-refresh',
      );
      oauth.refresh = async () => {
        throw new Error('simulated outage');
      };
      await assert.rejects(
        refreshProviderCredentials(
          models,
          credentials,
          providerId,
          new AbortController().signal,
        ),
        /simulated outage/,
      );
      assert.deepEqual(await credentials.read(providerId), renewed);
      const cancellation = new AbortController();
      oauth.refresh = async (current) => {
        cancellation.abort();
        return { ...current, refresh: 'rotated-during-cancellation' };
      };
      await assert.rejects(
        refreshProviderCredentials(
          models,
          credentials,
          providerId,
          cancellation.signal,
        ),
      );
      const retained = await credentials.read(providerId);
      assert.equal(
        retained?.type === 'oauth' && retained.refresh,
        'rotated-during-cancellation',
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
