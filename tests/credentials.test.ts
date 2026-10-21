import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PrivateCredentials } from '../apps/server/src/credentials.js';
import { createFactoryModels } from '../apps/server/src/providers.js';

test('Pi automatically refreshes expired credentials and preserves rotated tokens across failure and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-auto-refresh-'));
  try {
    const credentials = new PrivateCredentials(directory);
    await credentials.init();
    for (const providerId of ['openai', 'anthropic']) {
      await credentials.replace(providerId, {
        type: 'oauth',
        access: 'original-access',
        refresh: 'original-refresh',
        expires: 1,
      });
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
      assert.equal(
        (await models.getAuth(providerId))?.auth.apiKey,
        'renewed-access',
      );
      assert.equal(refreshes, 1);
      await credentials.modify(providerId, async (current) => ({
        ...current!,
        expires: 1,
      }));
      const beforeFailure = await credentials.read(providerId);
      oauth.refresh = async () => {
        throw new Error('simulated outage');
      };
      await assert.rejects(models.getAuth(providerId), /OAuth refresh failed/);
      assert.deepEqual(await credentials.read(providerId), beforeFailure);
      const cancellation = new AbortController();
      oauth.refresh = async (current) => {
        cancellation.abort();
        return {
          ...current,
          refresh: 'rotated-during-cancellation',
          expires: Date.now() + 3600000,
        };
      };
      await assert.rejects(
        models.getAuth(providerId, { signal: cancellation.signal }),
      );
      // Pi lets an in-flight token rotation commit after the caller stops waiting.
      let retained = await credentials.read(providerId);
      for (
        let attempt = 0;
        attempt < 100 &&
        !(
          retained?.type === 'oauth' &&
          retained.refresh === 'rotated-during-cancellation'
        );
        attempt++
      ) {
        await delay(10);
        retained = await credentials.read(providerId);
      }
      assert.equal(
        retained?.type === 'oauth' && retained.refresh,
        'rotated-during-cancellation',
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
