import { test } from 'node:test';
import { createServer, request } from 'node:http';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRedactor,
  redactResponse,
  type Redaction,
} from '../apps/server/src/redaction.js';
import { startService } from '../apps/server/src/service.js';

const redactions: Redaction[] = [
  ['/home/me/projects/app', '<repository>'],
  ['/home/me/data', '<data>'],
  ['/home/me', '~'],
];

function run(chunks: string[], rules = redactions) {
  const redactor = createRedactor(rules)!;
  return Buffer.concat([
    ...chunks.map((chunk) => redactor.push(Buffer.from(chunk))),
    redactor.flush(),
  ]).toString();
}

test('paths become labels, naming the longest match first', () => {
  assert.equal(
    run(['{"path":"/home/me/projects/app/src/a.ts","log":"/home/me/.cache"}']),
    '{"path":"<repository>/src/a.ts","log":"~/.cache"}',
  );
  assert.equal(run(['/home/me/data/worktrees/r1']), '<data>/worktrees/r1');
  assert.equal(run(['nothing to hide']), 'nothing to hide');
});

test('paths are matched in their JSON-escaped form too', () => {
  const rules: Redaction[] = [['/tmp/a"b', '<repository>']];
  assert.equal(
    run([JSON.stringify({ path: '/tmp/a"b/file' })], rules),
    '{"path":"<repository>/file"}',
  );
});

test('a path split across writes at any point is still replaced', () => {
  const text =
    'data: {"path":"/home/me/projects/app/src","at":"/home/me/data"}\n\n';
  const expected = run([text]);
  assert.equal(expected, 'data: {"path":"<repository>/src","at":"<data>"}\n\n');
  for (let cut = 1; cut < text.length; cut++)
    assert.equal(
      run([text.slice(0, cut), text.slice(cut)]),
      expected,
      `cut ${cut}`,
    );
  for (const size of [1, 2, 3, 7])
    assert.equal(
      run(text.match(new RegExp(`[^]{1,${size}}`, 'g'))!),
      expected,
      `size ${size}`,
    );
});

test('multi-byte text survives a split inside a character', () => {
  const rules: Redaction[] = [['/home/mü/app', '<repository>']];
  const text = Buffer.from('café /home/mü/app/ü ✓');
  const redactor = createRedactor(rules)!;
  for (let cut = 1; cut < text.length; cut++) {
    const out = Buffer.concat([
      redactor.push(text.subarray(0, cut)),
      redactor.push(text.subarray(cut)),
      redactor.flush(),
    ]);
    assert.equal(out.toString(), 'café <repository>/ü ✓', `cut ${cut}`);
  }
});

test('ordinary frames are not delayed and an unfinished prefix is released at the end', () => {
  const redactor = createRedactor([['/srv/factory/data', '<data>']])!;
  assert.equal(
    redactor.push(Buffer.from('event: heartbeat\ndata: {}\n\n')).toString(),
    'event: heartbeat\ndata: {}\n\n',
  );
  assert.equal(redactor.push(Buffer.from('see /srv/fac')).toString(), 'see ');
  assert.equal(redactor.flush().toString(), '/srv/fac');
});

test('only whole paths are replaced, not other names that start the same way', () => {
  const home: Redaction[] = [['/Users/mel', '~']];
  assert.equal(
    run(['/Users/melody/x /Users/mel/x /Users/mel. "/Users/mel"'], home),
    '/Users/melody/x ~/x ~. "~"',
  );
  assert.equal(
    run(['/rootfs/a /root /root/b'], [['/root', '~']]),
    '/rootfs/a ~ ~/b',
  );
  assert.equal(
    run(['/Users/mel-2 /Users/mel_x /Users/mel9'], home),
    '/Users/mel-2 /Users/mel_x /Users/mel9',
  );
  // The longer path still wins where it applies.
  assert.equal(
    run(
      ['/Users/mel/app/src /Users/mel/appx'],
      [
        ['/Users/mel/app', '<repository>'],
        ['/Users/mel', '~'],
      ],
    ),
    '<repository>/src ~/appx',
  );
});

test('a path that ends a chunk waits for the next chunk to show whether it ended', () => {
  const rules: Redaction[] = [['/srv/factory/data', '<data>']];
  const redactor = createRedactor(rules)!;
  assert.equal(
    redactor.push(Buffer.from('at /srv/factory/data')).toString(),
    'at ',
  );
  assert.equal(
    redactor.push(Buffer.from('x')).toString(),
    '/srv/factory/datax',
  );
  assert.equal(redactor.push(Buffer.from('/srv/factory/data')).toString(), '');
  assert.equal(redactor.push(Buffer.from('/f ')).toString(), '<data>/f ');
  assert.equal(
    run(['at /srv/factory/data'], rules),
    'at <data>',
    'end of text',
  );
  const text = 'a /srv/factory/datax b /srv/factory/data c /srv/factory/data/z';
  const expected = 'a /srv/factory/datax b <data> c <data>/z';
  assert.equal(run([text], rules), expected);
  for (let cut = 1; cut < text.length; cut++)
    assert.equal(
      run([text.slice(0, cut), text.slice(cut)], rules),
      expected,
      `cut ${cut}`,
    );
});

test('very short paths and no paths leave the response untouched', () => {
  assert.equal(createRedactor([]), undefined);
  assert.equal(createRedactor([['/', '~']]), undefined);
});

test('a response is rewritten across write and end forms', async () => {
  const server = createServer((req, res) => {
    redactResponse(res, redactions);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('a /home/me/proj');
    res.write(Buffer.from('ects/app/x '), () => undefined);
    res.write('/home/me/da', 'utf8');
    res.end('ta/y /home/me/pro');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = await new Promise<string>((resolve, reject) => {
      request(
        {
          host: '127.0.0.1',
          port: (server.address() as { port: number }).port,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve(text));
        },
      )
        .on('error', reject)
        .end();
    });
    // The unfinished tail is the home directory, so it is labelled at the end.
    assert.equal(body, 'a <repository>/x <data>/y ~/pro');
  } finally {
    server.close();
  }
});

const token = 'factory-test-token-0123456789abcdef0123456789';

function call(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    })
      .on('error', reject)
      .end();
  });
}

test('remote clients see labels instead of server paths, the server itself does not', async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'factory-redact-')),
  );
  const repo = join(directory, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  const service = await startService({
    dataDir: join(directory, 'data'),
    port: 0,
    authToken: token,
    allowedHosts: ['factory.example.com'],
  });
  try {
    const local = { Authorization: `Bearer ${token}` };
    const current = JSON.parse(
      (await call(service.port, '/api/v1/settings', local)).body,
    );
    for (const role of ['planning', 'development', 'review'])
      current.settings.roles[role] = {
        provider: 'requesty',
        model: 'offline',
        reasoning: null,
      };
    current.settings.repository = {
      path: repo,
      github: 'example/project',
      baseBranch: 'main',
    };
    current.settings.requiredChecks = ['fake test'];
    const saved = await new Promise<number>((resolve, reject) => {
      const payload = JSON.stringify({
        expectedRevision: current.revision,
        settings: current.settings,
      });
      request(
        {
          host: '127.0.0.1',
          port: service.port,
          path: '/api/v1/settings',
          method: 'PUT',
          headers: {
            ...local,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(payload)),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        },
      )
        .on('error', reject)
        .end(payload);
    });
    assert.equal(saved, 200);
    const here = await call(service.port, '/api/v1/settings', local);
    assert.ok(
      here.body.includes(JSON.stringify(repo).slice(1, -1)),
      'the server itself keeps the real path',
    );
    const remote = await call(service.port, '/api/v1/settings', {
      ...local,
      Host: 'factory.example.com',
    });
    assert.equal(remote.status, 200);
    assert.ok(
      !remote.body.includes(directory),
      'no server path reaches a remote client',
    );
    assert.equal(
      JSON.parse(remote.body).settings.repository.path,
      '<repository>',
    );
    const proxied = await call(service.port, '/api/v1/settings', {
      ...local,
      'X-Forwarded-For': '203.0.113.9',
    });
    assert.equal(
      JSON.parse(proxied.body).settings.repository.path,
      '<repository>',
    );
    assert.equal(
      JSON.parse(remote.body).settings.repository.github,
      'example/project',
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a repository chosen after remote clients connected is hidden from them at once', async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'factory-redact-')),
  );
  const [first, second] = [join(directory, 'one'), join(directory, 'two')];
  for (const repo of [first, second]) {
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
  }
  const service = await startService({
    dataDir: join(directory, 'data'),
    port: 0,
    authToken: token,
    allowedHosts: ['factory.example.com'],
  });
  const local = { Authorization: `Bearer ${token}` };
  const remote = { ...local, Host: 'factory.example.com' };
  const choose = async (repo: string) => {
    const current = JSON.parse(
      (await call(service.port, '/api/v1/settings', local)).body,
    );
    for (const role of ['planning', 'development', 'review'])
      current.settings.roles[role] = {
        provider: 'requesty',
        model: 'offline',
        reasoning: null,
      };
    current.settings.repository = {
      path: repo,
      github: 'example/project',
      baseBranch: 'main',
    };
    current.settings.requiredChecks = ['fake test'];
    const payload = JSON.stringify({
      expectedRevision: current.revision,
      settings: current.settings,
    });
    return new Promise<number>((resolve, reject) => {
      request(
        {
          host: '127.0.0.1',
          port: service.port,
          path: '/api/v1/settings',
          method: 'PUT',
          headers: {
            ...local,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(payload)),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        },
      )
        .on('error', reject)
        .end(payload);
    });
  };
  try {
    assert.equal(await choose(first), 200);
    // Several remote requests settle into a reused list of paths to hide.
    for (let i = 0; i < 3; i++) {
      const body = (await call(service.port, '/api/v1/settings', remote)).body;
      assert.ok(!body.includes(directory), 'first repository is hidden');
    }
    assert.equal(await choose(second), 200);
    const after = await call(service.port, '/api/v1/settings', remote);
    assert.ok(
      !after.body.includes(directory),
      'the new repository is hidden, not just the one chosen first',
    );
    assert.equal(
      JSON.parse(after.body).settings.repository.path,
      '<repository>',
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
