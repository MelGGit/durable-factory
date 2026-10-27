import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../apps/server/src/service.js';

const token = 'factory-test-token-0123456789abcdef0123456789';

function call(
  service: { port: number },
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const payload =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      {
        host: '127.0.0.1',
        port: service.port,
        path,
        method: options.method ?? 'GET',
        headers: {
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
              }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function withService(
  options: Parameters<typeof startService>[0],
  run: (service: Awaited<ReturnType<typeof startService>>) => Promise<void>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-auth-'));
  const service = await startService({ dataDir, port: 0, ...options });
  try {
    await run(service);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('listening beyond loopback requires a token of at least 32 characters', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-auth-'));
  try {
    await assert.rejects(
      startService({ dataDir, port: 0, host: '0.0.0.0' }),
      /requires an API token/,
    );
    await assert.rejects(
      startService({ dataDir, port: 0, authToken: 'too-short' }),
      /at least 32 characters/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('API requests need the bearer token while health and readiness stay open', async () => {
  await withService({ authToken: token }, async (service) => {
    assert.equal((await call(service, '/health')).status, 200);
    assert.equal((await call(service, '/ready')).status, 200);
    const missing = await call(service, '/api/v1/settings');
    assert.equal(missing.status, 401);
    assert.equal(
      missing.headers['www-authenticate'],
      'Bearer realm="durable-factory"',
    );
    assert.equal(JSON.parse(missing.body).error.code, 'AUTHENTICATION');
    const rejected: Record<string, string>[] = [
      { Authorization: `Bearer ${token.slice(0, -1)}x` },
      { Authorization: `Bearer ${token}x` },
      { Authorization: `Basic ${token}` },
      { 'X-Factory-Token': 'wrong' },
    ];
    for (const headers of rejected)
      assert.equal(
        (await call(service, '/api/v1/settings', { headers })).status,
        401,
      );
    assert.equal(
      (
        await call(service, '/api/v1/settings', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(service, '/api/v1/settings', {
          headers: { 'X-Factory-Token': token },
        })
      ).status,
      200,
    );
  });
});

test('a valid token needs no CSRF header, and a missing token cannot reach a write', async () => {
  await withService({ authToken: token }, async (service) => {
    const headers = { Authorization: `Bearer ${token}` };
    const current = JSON.parse(
      (await call(service, '/api/v1/settings', { headers })).body,
    );
    const body = {
      expectedRevision: current.revision,
      settings: current.settings,
    };
    const unauthenticated = await call(service, '/api/v1/settings', {
      method: 'PUT',
      body,
    });
    assert.equal(unauthenticated.status, 401);
    const saved = await call(service, '/api/v1/settings', {
      method: 'PUT',
      headers,
      body,
    });
    assert.equal(saved.status, 200);
  });
});

test('without a token the loopback CSRF boundary is unchanged', async () => {
  await withService({}, async (service) => {
    assert.equal((await call(service, '/api/v1/settings')).status, 200);
    const write = await call(service, '/api/v1/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: {},
    });
    assert.equal(write.status, 403);
  });
});

test('configured hosts and https origins are accepted, others are not', async () => {
  await withService(
    {
      authToken: token,
      allowedHosts: ['factory.example.com'],
      allowedOrigins: ['https://factory.example.com'],
    },
    async (service) => {
      const headers = {
        Authorization: `Bearer ${token}`,
        Host: 'factory.example.com',
      };
      assert.equal(
        (await call(service, '/api/v1/settings', { headers })).status,
        200,
      );
      assert.equal(
        (
          await call(service, '/api/v1/settings', {
            headers: { ...headers, Origin: 'https://factory.example.com' },
          })
        ).status,
        200,
      );
      const refused: Record<string, string>[] = [
        { Origin: 'https://evil.example' },
        { Origin: 'http://factory.example.com' },
        { Host: 'evil.example' },
      ];
      for (const extra of refused)
        assert.equal(
          (
            await call(service, '/api/v1/settings', {
              headers: { ...headers, ...extra },
            })
          ).status,
          403,
        );
    },
  );
});

test('a server bound beyond loopback serves authenticated requests', async () => {
  await withService({ authToken: token, host: '0.0.0.0' }, async (service) => {
    assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(
      (
        await call(service, '/api/v1/settings', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      200,
    );
    assert.equal((await call(service, '/api/v1/settings')).status, 401);
  });
});

test('settings and credentials can only be changed from the server itself', async () => {
  await withService(
    { authToken: token, allowedHosts: ['factory.example.com'] },
    async (service) => {
      const local = { Authorization: `Bearer ${token}` };
      const current = JSON.parse(
        (await call(service, '/api/v1/settings', { headers: local })).body,
      );
      const settings = {
        expectedRevision: current.revision,
        settings: current.settings,
      };
      const changes = [
        { method: 'PUT', path: '/api/v1/settings', body: settings },
        {
          method: 'PUT',
          path: '/api/v1/credentials/github',
          body: { value: 'secret-fixture-github' },
        },
        { method: 'DELETE', path: '/api/v1/credentials/github', body: {} },
        { method: 'POST', path: '/api/v1/github/validate', body: {} },
      ];
      // A proxy on this machine connects from loopback, as would a client
      // that renames itself, so neither is treated as the server itself.
      const remote: Record<string, string>[] = [
        { ...local, Host: 'factory.example.com' },
        { ...local, 'X-Forwarded-For': '203.0.113.9' },
        { ...local, Forwarded: 'for=203.0.113.9' },
        { ...local, 'X-Real-IP': '203.0.113.9' },
      ];
      for (const headers of remote)
        for (const change of changes) {
          const refused = await call(service, change.path, {
            method: change.method,
            headers,
            body: change.body,
          });
          assert.equal(refused.status, 403, `${change.method} ${change.path}`);
          assert.equal(JSON.parse(refused.body).error.code, 'FORBIDDEN');
        }
      assert.ok(
        !JSON.stringify(
          JSON.parse(
            (await call(service, '/api/v1/settings', { headers: local })).body,
          ).credentials,
        ).includes('true'),
        'no refused request changed a credential',
      );
      // Remote clients keep read access and can still run workflows.
      for (const headers of remote)
        for (const path of ['/api/v1/settings', '/api/v1/providers'])
          assert.equal((await call(service, path, { headers })).status, 200);
      // The same requests succeed from the server itself.
      assert.equal(
        (
          await call(service, '/api/v1/credentials/github', {
            method: 'PUT',
            headers: local,
            body: { value: 'secret-fixture-github' },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(service, '/api/v1/settings', {
            method: 'PUT',
            headers: local,
            body: settings,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(service, '/api/v1/credentials/github', {
            method: 'DELETE',
            headers: local,
            body: {},
          })
        ).status,
        200,
      );
      // A missing token is still rejected before the local check.
      assert.equal(
        (
          await call(service, '/api/v1/settings', {
            method: 'PUT',
            body: settings,
          })
        ).status,
        401,
      );
    },
  );
});
