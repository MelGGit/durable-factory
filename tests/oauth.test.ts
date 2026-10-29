import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrivateCredentials, startService } from './helpers/credentials.js';
import { OAuthSessions, type OAuthLogin } from '../apps/server/src/oauth.js';
import { selectionAnswer } from '../apps/server/src/diagnostics.js';
import { safeAuthFailure } from '../apps/server/src/auth-errors.js';
import {
  FactoryClient,
  type OAuthSession,
  type OAuthProvider,
} from '../packages/shared/src/index.js';

const credential = {
  type: 'oauth' as const,
  access: 'sentinel-access',
  refresh: 'sentinel-refresh',
  expires: Date.now() + 3600000,
  clientId: 'issued-client',
};
async function until<T>(
  read: () => T | Promise<T>,
  ready: (value: T) => boolean,
) {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (ready(value)) return value;
    await delay(5);
  }
  throw new Error('Timed out waiting for fixture');
}
export const fakeLogin: OAuthLogin = async (
  provider,
  store,
  interaction,
  options,
) => {
  assert.match(options.getDeviceId!(), /^[a-f0-9-]{36}$/);
  const method = await interaction.prompt({
    type: 'select',
    message: 'Choose',
    options: [
      { id: 'browser', label: 'Browser login (default)' },
      { id: 'copy_code', label: 'Copy code login' },
    ],
  });
  assert.ok(['browser', 'copy_code'].includes(method));
  interaction.notify({
    type: 'auth_url',
    url:
      provider === 'anthropic'
        ? 'https://claude.ai/oauth/authorize?state=fake'
        : 'https://auth.openai.com/authorize?state=fake',
  });
  const code = await interaction.prompt({
    type: 'manual_code',
    message: 'Paste code',
  });
  assert.equal(code, 'fixture-code');
  await store.modify(provider, async () => credential);
};

test('terminal selections accept default, numbers and IDs without accepting invalid input', () => {
  const prompt = {
    id: 'prompt',
    type: 'select' as const,
    message: '',
    options: [
      { id: 'browser', label: 'Default' },
      { id: 'copy_code', label: 'Copy code' },
    ],
  };
  assert.equal(selectionAnswer(prompt, ''), 'browser');
  assert.equal(selectionAnswer(prompt, ' 2 '), 'copy_code');
  assert.equal(selectionAnswer(prompt, 'browser'), 'browser');
  assert.equal(selectionAnswer(prompt, '2oops'), undefined);
  assert.equal(selectionAnswer(prompt, '3'), undefined);
});

test('installed Pi Anthropic copy-code flow exchanges a fixture grant and stores it through the vault adapter', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'oauth-pi-copy-code-'));
  const credentials = new PrivateCredentials(directory);
  await credentials.init();
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: unknown, init?: RequestInit) => {
      assert.equal(String(input), 'https://platform.claude.com/v1/oauth/token');
      requests.push(String(init?.body));
      return Response.json({
        access_token: 'fake-pi-access',
        refresh_token: 'fake-pi-refresh',
        expires_in: 3600,
      });
    },
  );
  const sessions = new OAuthSessions(credentials, directory);
  try {
    const first = await sessions.start('anthropic');
    const select = (await until(
      () => sessions.status('anthropic'),
      (value) => value?.prompt?.type === 'select',
    ))!;
    sessions.answer('anthropic', first.id, {
      promptId: select.prompt!.id,
      answer: 'copy_code',
    });
    const manual = (await until(
      () => sessions.status('anthropic'),
      (value) => value?.prompt?.type === 'manual_code',
    ))!;
    const state = new URL(manual.authUrl!).searchParams.get('state');
    sessions.answer('anthropic', first.id, {
      promptId: manual.prompt!.id,
      answer: `fake-authorization-code#${state}`,
    });
    await until(
      () => sessions.status('anthropic'),
      (value) => value?.state === 'completed',
    );
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0]).code, 'fake-authorization-code');
    const saved = await credentials.read('anthropic');
    assert.equal(saved?.type === 'oauth' && saved.refresh, 'fake-pi-refresh');
    assert.doesNotMatch(
      JSON.stringify(sessions.status('anthropic')),
      /fake-pi-|authUrl|prompt/,
    );
  } finally {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent starts after completion reserve one new session, and callback cancellation only dismisses its manual prompt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oauth-callback-race-'));
  const credentials = new PrivateCredentials(directory);
  await credentials.init();
  let callback!: () => void;
  const login: OAuthLogin = async (provider, store, interaction) => {
    const abort = new AbortController();
    const manual = interaction
      .prompt({ type: 'manual_code', message: 'Code', signal: abort.signal })
      .catch(() => {});
    await new Promise<void>((resolve) => {
      callback = resolve;
    });
    abort.abort();
    await manual;
    await store.modify(provider, async () => credential);
  };
  const sessions = new OAuthSessions(credentials, directory, login);
  try {
    await sessions.start('openai');
    await until(
      () => sessions.status('openai'),
      (value) => Boolean(value?.prompt),
    );
    callback();
    await until(
      () => sessions.status('openai'),
      (value) => value?.state === 'completed',
    );
    const [a, b] = await Promise.all([
      sessions.start('anthropic'),
      sessions.start('anthropic'),
    ]);
    assert.equal(a.id, b.id);
    await until(
      () => sessions.status('anthropic'),
      (value) => Boolean(value?.prompt),
    );
    callback();
    await until(
      () => sessions.status('anthropic'),
      (value) => value?.state === 'completed',
    );
  } finally {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('sessions drive Pi prompts, reject stale answers, clear interactive data, and keep credentials server-side', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oauth-session-'));
  const credentials = new PrivateCredentials(directory);
  await credentials.init();
  const sessions = new OAuthSessions(credentials, directory, fakeLogin);
  try {
    const initial = await sessions.start('anthropic');
    const duplicate = await sessions.start('anthropic');
    assert.equal(initial.id, duplicate.id);
    await assert.rejects(sessions.start('openai'), /other provider/);
    const first = (await until(
      () => sessions.status('anthropic'),
      (value) => Boolean(value?.prompt),
    ))!;
    assert.throws(
      () =>
        sessions.answer('anthropic', first.id, {
          promptId: first.prompt!.id,
          answer: '1',
        }),
      /valid answer/,
    );
    sessions.answer('anthropic', first.id, {
      promptId: first.prompt!.id,
      answer: 'browser',
    });
    assert.throws(
      () =>
        sessions.answer('anthropic', first.id, {
          promptId: first.prompt!.id,
          answer: 'browser',
        }),
      /no longer active/,
    );
    const second = (await until(
      () => sessions.status('anthropic'),
      (value) => value?.prompt?.type === 'manual_code',
    ))!;
    assert.ok(second.authUrl);
    sessions.answer('anthropic', second.id, {
      promptId: second.prompt!.id,
      answer: 'fixture-code',
    });
    const completed = await until(
      () => sessions.status('anthropic'),
      (value) => value?.state === 'completed',
    );
    assert.doesNotMatch(
      JSON.stringify(completed),
      /sentinel|fixture-code|authUrl|prompt/,
    );
    assert.deepEqual(await credentials.read('anthropic'), credential);
  } finally {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancel and disconnect drain late logins without saving them; failed reconnect preserves credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oauth-late-'));
  const credentials = new PrivateCredentials(directory);
  await credentials.init();
  await credentials.replace('openai', credential);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const late: OAuthLogin = async (provider, store) => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await store.modify(provider, async () => ({
      ...credential,
      refresh: 'late-refresh',
    }));
  };
  const sessions = new OAuthSessions(credentials, directory, late);
  try {
    await sessions.start('openai');
    await started;
    const disconnect = sessions.disconnect('openai');
    await assert.rejects(
      sessions.start('openai'),
      /disconnect before signing in/,
    );
    release();
    await disconnect;
    assert.equal(await credentials.read('openai'), undefined);
    assert.equal(sessions.status('openai')?.state, 'cancelled');
    await credentials.replace('openai', credential);
    const failing = new OAuthSessions(credentials, directory, async () => {
      throw new Error('token exchange body sentinel-refresh');
    });
    await failing.start('openai');
    const failed = await until(
      () => failing.status('openai'),
      (value) => value?.state === 'failed',
    );
    assert.doesNotMatch(JSON.stringify(failed), /sentinel/);
    assert.deepEqual(await credentials.read('openai'), credential);
    await failing.close();
  } finally {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('expiry aborts prompts, retires sessions, and shutdown drains them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oauth-expire-'));
  const credentials = new PrivateCredentials(directory);
  await credentials.init();
  const sessions = new OAuthSessions(
    credentials,
    directory,
    async (_provider, _store, interaction) => {
      await interaction.prompt({ type: 'manual_code', message: 'Code' });
    },
    25,
    25,
  );
  try {
    await sessions.start('openai');
    await until(
      () => sessions.status('openai'),
      (value) => value?.state === 'expired',
    );
    assert.equal(await credentials.read('openai'), undefined);
    await until(
      () => sessions.status('openai'),
      (value) => value === null,
    );
    await sessions.start('anthropic');
    await sessions.close();
    assert.equal(sessions.status('anthropic')?.state, 'cancelled');
    await assert.rejects(sessions.start('openai'), /stopping/);
  } finally {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('OAuth HTTP endpoints enforce local-only reads, CSRF, sanitized failures, and safe stored metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oauth-http-'));
  const service = await startService({
    dataDir: directory,
    port: 0,
    oauthLogin: fakeLogin,
  });
  const client = new FactoryClient(service.url);
  try {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${service.url}/api/v1/auth/openai/login`, {
        method,
        headers: { 'X-Forwarded-For': '192.0.2.1' },
      });
      assert.equal(response.status, 403);
    }
    assert.equal(
      (
        await fetch(`${service.url}/api/v1/auth/openai/login`, {
          method: 'POST',
        })
      ).status,
      403,
    );
    const start = await client.startLogin('openai');
    const first = await until(
      () => client.loginStatus('openai'),
      (value) => Boolean(value.session?.prompt),
    );
    await client.answerLogin(
      'openai',
      start.session.id,
      first.session!.prompt!.id,
      'browser',
    );
    const second = await until(
      () => client.loginStatus('openai'),
      (value) => value.session?.prompt?.type === 'manual_code',
    );
    await client.answerLogin(
      'openai',
      start.session.id,
      second.session!.prompt!.id,
      'fixture-code',
    );
    await until(
      () => client.loginStatus('openai'),
      (value) => value.session?.state === 'completed',
    );
    const settings = await client.settings();
    assert.equal(settings.credentials.openai, true);
    assert.equal(settings.credentialStorage.status, 'ready');
    assert.doesNotMatch(JSON.stringify(settings), /sentinel/);
    await client.deleteCredential('openai');
    assert.equal((await client.settings()).credentials.openai, false);
    assert.equal(
      safeAuthFailure(new Error('raw body: sentinel-access')).message.includes(
        'sentinel',
      ),
      false,
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
