import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateCredentials } from './helpers/credentials.js';
import { createGitHub, GitHubFailure } from '../apps/server/src/github.js';

test('GitHub adapter validates access without claiming write capability and uses private token on each request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-github-'));
  const credentials = new PrivateCredentials(directory);
  await credentials.init();
  try {
    await credentials.replace('github', {
      type: 'api_key',
      key: 'private-token',
    });
    const requests: { url: string; init: RequestInit }[] = [];
    const github = createGitHub(credentials, (async (url, init) => {
      requests.push({ url: String(url), init: init! });
      if (String(url).endsWith('/example/project'))
        return Response.json({ has_issues: true, archived: false });
      if (init?.method === 'POST')
        return Response.json({
          number: 12,
          html_url: 'https://github.com/example/project/issues/12',
        });
      return Response.json(
        [
          {
            number: 4,
            html_url: 'https://github.com/example/project/issues/4',
            body: 'Marker',
            pull_request: {},
          },
        ],
        {
          headers: {
            Link: '<https://api.github.com/repos/example/project/issues?page=2>; rel="next"',
          },
        },
      );
    }) as typeof fetch);
    const result = await github.validate('example/project');
    assert.equal(result.writeAccess, 'unverified');
    assert.equal(result.accessible, true);
    assert.ok(!JSON.stringify(result).includes('private-token'));
    const page = await github.list('example/project', 1);
    assert.equal(page.hasNext, true);
    assert.equal(page.issues[0].pullRequest, true);
    await credentials.replace('github', {
      type: 'api_key',
      key: 'rotated-token',
    });
    await github.create('example/project', 'A ticket', 'Its body');
    assert.equal(
      (requests.at(-1)!.init.headers as Record<string, string>).Authorization,
      'Bearer rotated-token',
    );
    assert.equal(
      JSON.parse(String(requests.at(-1)!.init.body)).title,
      'A ticket',
    );
    assert.equal(requests.at(-1)!.init.redirect, 'error');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub adapter distinguishes definitive rejections from timeouts, server errors and invalid responses without leaking bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-github-errors-'));
  const credentials = new PrivateCredentials(directory);
  await credentials.init();
  try {
    await credentials.replace('github', {
      type: 'api_key',
      key: 'private-token',
    });
    for (const status of [401, 403, 404, 410, 422, 429, 500, 503]) {
      const github = createGitHub(
        credentials,
        (async () =>
          new Response('sensitive response private-token', {
            status,
          })) as typeof fetch,
      );
      await assert.rejects(
        github.create('example/project', 'title', 'body'),
        (error: unknown) =>
          error instanceof GitHubFailure &&
          error.definitive === status < 500 &&
          !error.message.includes('private-token'),
      );
    }
    for (const fetcher of [
      async () => {
        throw new Error('private-token transport details');
      },
      async () => new Response('not JSON'),
      async () =>
        Response.json({ number: 0, html_url: 'https://evil.example/' }),
    ]) {
      await assert.rejects(
        createGitHub(credentials, fetcher as typeof fetch).create(
          'example/project',
          'title',
          'body',
        ),
        (error: unknown) =>
          error instanceof GitHubFailure &&
          !error.definitive &&
          !error.message.includes('private-token'),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub cancellation before dispatch sends nothing, while an aborted in-flight POST remains uncertain', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'factory-github-cancellation-'),
  );
  const credentials = new PrivateCredentials(directory);
  await credentials.init();
  try {
    await credentials.replace('github', {
      type: 'api_key',
      key: 'private-token',
    });
    let requests = 0;
    const controller = new AbortController();
    const originalRead = credentials.read.bind(credentials);
    credentials.read = async (...args) => {
      const value = await originalRead(...args);
      controller.abort();
      return value;
    };
    const beforeDispatch = createGitHub(credentials, (async () => {
      requests++;
      return Response.json({});
    }) as typeof fetch);
    await assert.rejects(
      beforeDispatch.create(
        'example/project',
        'Title',
        'Body',
        controller.signal,
      ),
      (error: unknown) => error instanceof GitHubFailure && error.definitive,
    );
    assert.equal(requests, 0);
    credentials.read = originalRead;
    const inflight = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const afterDispatch = createGitHub(credentials, (async (_url, options) => {
      requests++;
      const signal = options!.signal!;
      assert.ok(!signal.aborted);
      entered();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    }) as typeof fetch);
    const pending = afterDispatch.create(
      'example/project',
      'Title',
      'Body',
      inflight.signal,
    );
    const rejected = assert.rejects(
      pending,
      (error: unknown) => error instanceof GitHubFailure && !error.definitive,
    );
    await started;
    inflight.abort();
    await rejected;
    assert.equal(requests, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('real workflow GitHub endpoints capture issues, exclude PR label hits, encode refs, create non-draft PRs and expose rate-limit backoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-github-workflow-')),
    credentials = new PrivateCredentials(directory);
  await credentials.init();
  await credentials.replace('github', {
    type: 'api_key',
    key: 'offline-token',
  });
  const requests: { url: string; init: RequestInit }[] = [],
    sha = 'a'.repeat(40);
  const issue = {
    number: 7,
    html_url: 'https://github.com/example/project/issues/7',
    title: 'Implement',
    body: 'Requirements',
    updated_at: '2026-10-22T00:00:00Z',
    state: 'open',
  };
  const pull = {
    number: 9,
    html_url: 'https://github.com/example/project/pull/9',
    body: 'operation marker',
    head: {
      sha,
      ref: 'durable-factory/branch',
      repo: { full_name: 'example/project' },
    },
    base: { ref: 'main', repo: { full_name: 'example/project' } },
    state: 'open',
    draft: false,
  };
  const github = createGitHub(credentials, (async (url, init) => {
    const address = String(url);
    requests.push({ url: address, init: init! });
    if (address.includes('/git/ref/'))
      return Response.json({ object: { sha } });
    if (address.endsWith('/pulls/9'))
      return Response.json({ ...pull, merged: true, state: 'closed' });
    if (address.includes('/pulls'))
      return Response.json(init?.method === 'POST' ? pull : [pull]);
    if (address.endsWith('/issues/7')) return Response.json(issue);
    return Response.json([issue, { ...issue, number: 8, pull_request: {} }]);
  }) as typeof fetch);
  try {
    assert.equal(
      (await github.getIssue!('example/project', 7)).updatedAt,
      issue.updated_at,
    );
    assert.equal((await github.getIssue!('example/project', 7)).state, 'open');
    assert.equal((await github.getPull!('example/project', 9)).merged, true);
    assert.equal(
      (await github.readyIssues!('example/project', 1)).issues.length,
      1,
    );
    assert.equal(await github.baseSha!('example/project', 'feature/base'), sha);
    const listedPull = (
      await github.pulls!('example/project', 'durable-factory/branch', 1)
    ).pulls[0];
    assert.equal(listedPull.head, sha);
    assert.equal(listedPull.headRepository, 'example/project');
    assert.equal(listedPull.headBranch, 'durable-factory/branch');
    assert.equal(listedPull.baseRepository, 'example/project');
    assert.equal(listedPull.baseBranch, 'main');
    await github.createPull!('example/project', {
      title: 'Implement',
      body: 'operation marker',
      head: 'durable-factory/branch',
      base: 'main',
    });
    assert.equal(JSON.parse(String(requests.at(-1)!.init.body)).draft, false);
    assert.ok(requests.some((r) => r.url.includes('heads/feature%2Fbase')));
    assert.ok(
      requests.some((r) =>
        r.url.includes('head=example%3Adurable-factory%2Fbranch'),
      ),
    );
    const limited = createGitHub(
      credentials,
      (async () =>
        new Response('', {
          status: 429,
          headers: { 'retry-after': '120' },
        })) as typeof fetch,
    );
    await assert.rejects(
      limited.readyIssues!('example/project', 1),
      (error) => error instanceof GitHubFailure && error.retryAfterMs >= 120000,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Home issue listing excludes PRs and closed issues, and updates only the selected issue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-github-issues-'));
  const credentials = new PrivateCredentials(directory);
  await credentials.init();
  try {
    await credentials.replace('github', {
      type: 'api_key',
      key: 'fixture-token',
    });
    const requests: { url: string; init?: RequestInit }[] = [];
    const issue = {
      number: 4,
      html_url: 'https://github.com/example/project/issues/4',
      title: 'Existing issue',
      body: 'Issue context',
      updated_at: '2026-01-01T00:00:00Z',
      state: 'open',
    };
    const github = createGitHub(credentials, (async (url, init) => {
      requests.push({ url: String(url), init });
      if (init?.method === 'PATCH')
        return Response.json({ ...issue, ...JSON.parse(String(init.body)) });
      return Response.json(
        [
          issue,
          { ...issue, number: 5, pull_request: {} },
          { ...issue, number: 6, state: 'closed' },
        ],
        {
          headers: {
            Link: '<https://api.github.com/repos/example/project/issues?page=2>; rel="next"',
          },
        },
      );
    }) as typeof fetch);
    const page = await github.openIssues!('example/project', 1);
    assert.deepEqual(
      page.issues.map((issue) => issue.number),
      [4],
    );
    assert.equal(page.hasNext, true);
    assert.match(requests[0].url, /state=open.*page=1/);
    const updated = await github.updateIssue!(
      'example/project',
      4,
      'Approved revision',
      'Approved body',
    );
    assert.equal(updated.number, 4);
    assert.equal(updated.title, 'Approved revision');
    assert.ok(requests[1].url.endsWith('/issues/4'));
    assert.equal(requests[1].init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
      title: 'Approved revision',
      body: 'Approved body',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
