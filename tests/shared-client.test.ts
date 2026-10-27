import { test } from 'node:test';
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startService } from '../apps/server/src/service.js';
import {
  ApiError,
  FactoryClient,
  WorkflowClient,
  withToken,
  type WorkflowSnapshot,
} from '../packages/shared/src/index.js';

const token = 'factory-test-token-0123456789abcdef0123456789';

const reply = (status: number, body: string) => async () =>
  new Response(body, { status });

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection.');
}

test('withToken adds a bearer header and keeps the caller headers', async () => {
  const seen: Headers[] = [];
  const fetcher = withToken('secret', async (_input, init) => {
    seen.push(new Headers(init?.headers));
    return new Response('{}');
  });
  await fetcher('http://example.test/a', { headers: { 'X-One': '1' } });
  await fetcher('http://example.test/b');
  assert.equal(seen[0].get('Authorization'), 'Bearer secret');
  assert.equal(seen[0].get('X-One'), '1');
  assert.equal(seen[1].get('Authorization'), 'Bearer secret');
});

test('error responses that are not JSON still become API errors', async () => {
  const proxy = await rejection(
    new FactoryClient('', reply(502, 'Bad Gateway')).settings(),
  );
  assert.ok(proxy instanceof ApiError);
  assert.equal(proxy.code, 'INTERNAL');
  assert.equal(proxy.status, 502);
  const unauthorized = await rejection(
    new FactoryClient('', reply(401, 'Unauthorized')).settings(),
  );
  assert.ok(unauthorized instanceof ApiError);
  assert.equal(unauthorized.code, 'AUTHENTICATION');
  const html = await rejection(
    new FactoryClient('', reply(200, '<html>login</html>')).settings(),
  );
  assert.ok(html instanceof ApiError);
  assert.equal(html.code, 'INTERNAL');
  const known = await rejection(
    new FactoryClient(
      '',
      reply(
        409,
        JSON.stringify({ error: { code: 'CONFLICT', message: 'Changed.' } }),
      ),
    ).settings(),
  );
  assert.ok(known instanceof ApiError);
  assert.equal(known.code, 'CONFLICT');
  assert.equal(known.message, 'Changed.');
});

function frame(streamId: string, revision: number) {
  return {
    apiVersion: 'v1',
    streamId,
    sequence: 1,
    type: 'snapshot',
    snapshot: { revision, runs: [] },
  };
}
function send(res: ServerResponse, id: number, streamId: string) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`id: ${id}\ndata: ${JSON.stringify(frame(streamId, id))}\n\n`);
}

test('watchRuns streams in Node with a token, and a reconnect says which state it holds', async () => {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers);
    if (requests.length === 1) {
      send(res, 1, 'first');
      res.end();
    } else send(res, 2, 'second');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const snapshots: number[] = [];
  const connection: boolean[] = [];
  const client = new WorkflowClient(
    `http://127.0.0.1:${port}`,
    withToken(token),
  );
  const stop = client.watchRuns(
    (snapshot) => snapshots.push(snapshot.revision),
    (connected) => connection.push(connected),
  );
  try {
    const deadline = Date.now() + 5000;
    while (snapshots.length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(snapshots, [1, 2]);
    assert.deepEqual(connection, [true, false, true]);
    assert.equal(requests[0].authorization, `Bearer ${token}`);
    assert.equal(requests[0]['last-event-id'], undefined);
    assert.equal(requests[1].authorization, `Bearer ${token}`);
    assert.equal(requests[1]['last-event-id'], '1');
  } finally {
    stop();
    server.closeAllConnections();
    server.close();
  }
});

test('watchRuns reports a rejected token once and does not keep retrying', async () => {
  let count = 0;
  const server = createServer((_req, res) => {
    count++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'AUTHENTICATION',
          message: 'A valid API token is required.',
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const errors: ApiError[] = [];
  const stop = new WorkflowClient(`http://127.0.0.1:${port}`).watchRuns(
    () => undefined,
    () => undefined,
    (error) => errors.push(error as ApiError),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(count, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'AUTHENTICATION');
  } finally {
    stop();
    server.close();
  }
});

async function withTokenService(
  run: (service: Awaited<ReturnType<typeof startService>>) => Promise<void>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-client-'));
  const service = await startService({ dataDir, port: 0, authToken: token });
  try {
    await run(service);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('clients work against a token-protected service, including writes and the run stream', async () => {
  await withTokenService(async (service) => {
    const client = new WorkflowClient(service.url, withToken(token));
    const current = await client.settings();
    // A write needs no CSRF header once the bearer token is accepted.
    const saved = await client.saveSettings({
      expectedRevision: current.revision,
      settings: current.settings,
    });
    assert.equal(saved.revision, current.revision + 1);
    const seen = await new Promise<WorkflowSnapshot>((resolve) => {
      const stop = client.watchRuns(
        (snapshot) => {
          stop();
          resolve(snapshot);
        },
        () => undefined,
      );
    });
    assert.ok(Array.isArray(seen.runs));
    const refused = await rejection(new WorkflowClient(service.url).workflow());
    assert.ok(refused instanceof ApiError);
    assert.equal(refused.code, 'AUTHENTICATION');
  });
});

test('the built package runs in plain Node', async () => {
  const output = await mkdtemp(join(process.cwd(), 'packages/shared/.built-'));
  try {
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/typescript/bin/tsc'),
        '-p',
        join(process.cwd(), 'packages/shared/tsconfig.build.json'),
        '--outDir',
        output,
      ],
      { stdio: 'pipe' },
    );
    await access(join(output, 'index.d.ts'));
    const built = await import(pathToFileURL(join(output, 'index.js')).href);
    await withTokenService(async (service) => {
      const client = new built.WorkflowClient(
        service.url,
        built.withToken(token),
      );
      assert.equal((await client.settings()).revision, 0);
      assert.deepEqual((await client.workflow()).runs, []);
    });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
