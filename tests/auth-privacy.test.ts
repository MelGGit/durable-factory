import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrivateCredentials, startService } from './helpers/credentials.js';
import { createFactoryModels } from '../apps/server/src/providers.js';
import { ChatClient } from '../packages/shared/src/index.js';

test('provider token-response bodies never reach durable errors, transcripts, API responses or logs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-privacy-'));
  const credentials = new PrivateCredentials(directory);
  await credentials.init();
  const access = 'privacy-sentinel-access',
    refresh = 'privacy-sentinel-refresh';
  await credentials.replace('openai', {
    type: 'oauth',
    access,
    refresh,
    expires: 1,
    clientId: 'fake-issued-client',
  });
  const localFetch = globalThis.fetch;
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  // Every provider request is intercepted; only the separately captured fetch reaches local fixtures.
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', debug: { access, refresh } }),
        { status: 400 },
      ),
  );
  const models = createFactoryModels(credentials);
  const service = await startService({
    dataDir: directory,
    port: 0,
    chat: { models, tools: [] },
  });
  try {
    const client = new ChatClient(service.url, localFetch);
    const saved = await client.settings();
    saved.settings.roles.planning = {
      provider: 'openai',
      model: models.getModels('openai')[0].id,
      reasoning: null,
    };
    await client.saveSettings({
      expectedRevision: saved.revision,
      settings: saved.settings,
    });
    const conversation = await client.createConversation(
      'Privacy fixture',
      'create-privacy',
    );
    await client.submit(conversation.id, 'Reply briefly', 'privacy-request');
    let settled = false;
    for (let i = 0; i < 200; i++) {
      const value = await client.submission(conversation.id, 'privacy-request');
      if (value.status === 'failed') {
        settled = true;
        break;
      }
      await delay(20);
    }
    assert.ok(settled, 'failed auth must settle the durable submission');
    const publicData = JSON.stringify([
      await client.settings(),
      await client.history(conversation.id),
      logs,
    ]);
    assert.doesNotMatch(publicData, /privacy-sentinel/);
    await service.close();
    for (const filename of await readdir(directory)) {
      if (!filename.startsWith('factory.sqlite')) continue;
      assert.equal(
        (await readFile(join(directory, filename))).includes(
          Buffer.from('privacy-sentinel'),
        ),
        false,
        'durable storage must not record token response bodies',
      );
    }
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
