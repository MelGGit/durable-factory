import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../apps/server/src/service.js';
import {
  ChatClient,
  ApiError,
  ChatReducer,
  mergeEntries,
  type ChatFrame,
  type ConversationSnapshot,
} from '../packages/shared/src/index.js';
import { fixture, configure, until } from './fixtures/chat.js';

test(
  'planning admission, queue, withdrawal, interruption, model capture and restart',
  { timeout: 20000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-chat-'));
    const deps = fixture(100);
    let service = await startService({ dataDir, port: 0, chat: deps });
    let stop: (() => void) | undefined;
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'A durable plan',
        'create-once',
      );
      assert.equal(
        (await client.createConversation('A durable plan', 'create-once')).id,
        conversation.id,
      );
      await assert.rejects(
        client.createConversation('Another title', 'create-once'),
        (e: unknown) => e instanceof ApiError && e.code === 'CONFLICT',
      );
      let snapshot: ConversationSnapshot | undefined;
      stop = client.watch(
        conversation.id,
        (value) => {
          snapshot = value;
        },
        () => {},
      );
      await until(async () => snapshot, Boolean);
      const first = await client.submit(
        conversation.id,
        'A long planning question. '.repeat(20),
        'input-1',
      );
      assert.equal(first.status, 'running');
      assert.equal(
        (await client.submit(conversation.id, first.content, 'input-1')).id,
        first.id,
      );
      await assert.rejects(
        client.submit(conversation.id, 'different', 'input-1'),
        (e: unknown) => e instanceof ApiError && e.code === 'CONFLICT',
      );
      await assert.rejects(
        client.submit(conversation.id, 'steer', 'bad-steer', 'steer'),
        (e: unknown) => e instanceof ApiError && e.code === 'FORBIDDEN',
      );
      const queued = await client.submit(
        conversation.id,
        'Queued question',
        'input-2',
      );
      assert.equal(queued.status, 'queued');
      assert.equal(
        (await client.withdraw(conversation.id, queued.id)).status,
        'withdrawn',
      );
      assert.equal(
        (await client.withdraw(conversation.id, queued.id)).status,
        'withdrawn',
      );
      await assert.rejects(
        client.withdraw(conversation.id, first.id),
        (e: unknown) => e instanceof ApiError && e.code === 'CONFLICT',
      );
      await until(
        async () => snapshot?.partial,
        (value) => Boolean(value),
      );
      await client.interrupt(conversation.id);
      await until(
        async () => snapshot?.execution,
        (value) => value === 'idle',
      );
      assert.equal(
        (await client.submission(conversation.id, 'input-1')).status,
        'interrupted',
      );
      assert.ok(
        (await client.history(conversation.id)).entries.some(
          (entry) => entry.interrupted && entry.text,
        ),
      );
      stop();
      stop = undefined;
      const port = service.port;
      await service.close();
      service = await startService({ dataDir, port, chat: fixture() });
      assert.equal(
        (await client.conversations()).conversations[0].title,
        'A durable plan',
      );
      // Same client refreshes a stale CSRF token after restart.
      await client.submit(conversation.id, 'After restart', 'input-3');
      await until(
        () => client.submission(conversation.id, 'input-3'),
        (value) => value.status === 'completed',
      );
      const saved = await client.settings();
      saved.settings.roles.planning.model = 'changed';
      await client.saveSettings({
        expectedRevision: saved.revision,
        settings: saved.settings,
      });
      assert.equal(
        (await client.conversations()).conversations[0].model.model,
        'offline',
      );
      const page = await client.history(conversation.id);
      assert.equal(
        new Set(page.entries.map((entry) => entry.id)).size,
        page.entries.length,
      );
      assert.equal(
        page.entries.filter((entry) => entry.kind === 'pi.user').length,
        2,
      );
      const response = await fetch(
        `${service.url}/api/v1/conversations/${conversation.id}/history?limit=1`,
      );
      const small = await response.json();
      assert.equal(small.entries.length, 1);
      assert.ok(small.cursor);
      const previous = await client.history(conversation.id, small.cursor);
      assert.ok(previous.entries.length);
      assert.ok(
        !previous.entries.some((entry) => entry.id === small.entries[0].id),
      );
      assert.equal(
        (
          await fetch(
            `${service.url}/api/v1/conversations/${conversation.id}/history?cursor=broken`,
          )
        ).status,
        400,
      );
    } finally {
      stop?.();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test('tools stream details and full artifacts, reviewer is inspection-only, developer delivery requires authorization', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-tools-'));
  const deps = fixture();
  let developerAuthorized = false;
  const service = await startService({
    dataDir,
    port: 0,
    chat: { ...deps, authorizeDeveloper: () => developerAuthorized },
  });
  let stop: (() => void) | undefined;
  try {
    const client = new ChatClient(service.url);
    await configure(client);
    const conversation = await client.createConversation(
      'Tool transcript',
      'tools',
    );
    const snapshots: ConversationSnapshot[] = [];
    stop = client.watch(
      conversation.id,
      (snapshot) => snapshots.push(snapshot),
      () => {},
    );
    await client.submit(conversation.id, 'use tool', 'tool-input');
    await until(
      () => client.submission(conversation.id, 'tool-input'),
      (value) => value.status === 'completed',
    );
    await until(
      async () => snapshots,
      (values) =>
        values.some((value) =>
          value.tools.some((tool) => tool.output?.includes('Running')),
        ),
    );
    const history = await client.history(conversation.id);
    const tool = history.entries
      .flatMap((entry) => entry.tools)
      .find((tool) => tool.artifact)!;
    assert.ok(tool);
    assert.match(
      (await client.artifact(conversation.id, tool.artifact!)).text,
      /Running controlled fixture/,
    );
    const reviewer = await service.chat!.create(
      { title: 'Review fixture', requestId: 'review' },
      'review',
    );
    await assert.rejects(
      client.submit(reviewer.id, 'edit', 'review-input'),
      (e: unknown) => e instanceof ApiError && e.code === 'FORBIDDEN',
    );
    const developer = await service.chat!.create(
      { title: 'Developer fixture', requestId: 'developer' },
      'development',
    );
    await assert.rejects(
      client.submit(developer.id, 'Blocked during validation', 'dev-blocked'),
      (error: unknown) =>
        error instanceof ApiError && error.code === 'FORBIDDEN',
    );
    developerAuthorized = true;
    await client.submit(developer.id, 'use tool', 'dev-1');
    const steer = await client.submit(
      developer.id,
      'Guidance at tool boundary',
      'dev-steer',
      'steer',
    );
    assert.equal(steer.status, 'queued');
    await until(
      () => client.submission(developer.id, 'dev-steer'),
      (value) => value.status === 'completed',
    );
    stop();
    stop = undefined;
    // Server shutdown must close active streams, even when clients stay attached.
    const response = await fetch(
      `${service.url}/api/v1/conversations/${conversation.id}/events`,
    );
    const reader = response.body!.getReader();
    await reader.read();
    await service.close();
    while (!(await reader.read()).done) {
      /* drain */
    }
  } finally {
    stop?.();
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('shared reducer rejects gaps and unknown streams, deduplicates updates, and merges history', () => {
  const reducer = new ChatReducer();
  const frame = {
    apiVersion: 'v1',
    streamId: 'one',
    sequence: 1,
    type: 'snapshot',
    snapshot: {},
  } as ChatFrame;
  assert.equal(reducer.apply(frame), true);
  assert.equal(reducer.apply(frame), false);
  assert.throws(
    () => reducer.apply({ ...frame, type: 'update', sequence: 3 }),
    /missed/,
  );
  assert.throws(
    () =>
      reducer.apply({
        ...frame,
        type: 'update',
        streamId: 'other',
        sequence: 2,
      }),
    /snapshot/,
  );
  assert.equal(reducer.apply({ ...frame, type: 'update', sequence: 2 }), true);
  assert.equal(reducer.apply({ ...frame, type: 'update', sequence: 2 }), false);
  assert.throws(
    () => reducer.apply({ ...frame, apiVersion: 'v2' } as never),
    (e: unknown) => e instanceof ApiError && e.code === 'UNSUPPORTED_VERSION',
  );
  const entry = { id: '2', kind: 'pi.user', text: 'original', tools: [] };
  assert.deepEqual(
    mergeEntries(
      [{ ...entry, id: '1' }, entry],
      [{ ...entry, text: 'updated' }],
    ).map((item) => item.text),
    ['original', 'updated'],
  );
});

test('large tool output remains fully pageable while wire previews and slow-client buffers are bounded', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-chat-output-'));
  const deps = fixture();
  const output = 'complete output 🌿\n'.repeat(20000);
  const service = await startService({
    dataDir,
    port: 0,
    chat: {
      ...deps,
      tools: [
        {
          ...deps.tools[0],
          async execute(_args, api) {
            api.output(output);
            return { output: [{ type: 'text', text: 'Complete.' }] };
          },
        },
      ],
    },
  });
  try {
    const client = new ChatClient(service.url);
    await configure(client);
    const conversation = await client.createConversation(
      'Output limits',
      'output',
    );
    await client.submit(conversation.id, 'use tool', 'large-output');
    await until(
      () => client.submission(conversation.id, 'large-output'),
      (value) => value.status === 'completed',
    );
    const tool = (await client.history(conversation.id)).entries
      .flatMap((entry) => entry.tools)
      .find((tool) => tool.artifact)!;
    let text = '',
      offset: number | undefined = 0;
    do {
      const page = await client.artifact(
        conversation.id,
        tool.artifact!,
        offset,
      );
      assert.ok(Buffer.byteLength(page.text) <= 65536);
      text += page.text;
      offset = page.nextOffset;
    } while (offset !== undefined);
    assert.ok(text.startsWith(output));
    const { EventEmitter } = await import('node:events');
    class SlowResponse extends EventEmitter {
      writableLength = 1024 * 1024;
      ended = false;
      writes = 0;
      destroy() {}
      writeHead() {}
      write() {
        this.writes++;
        return false;
      }
      end() {
        this.ended = true;
        this.emit('close');
      }
    }
    const slow = new SlowResponse();
    await service.chat!.stream(conversation.id, slow as never);
    assert.equal(slow.ended, true);
    assert.equal(slow.writes, 0);
    await assert.rejects(
      client.artifact(conversation.id, 'task-invalid'),
      (e: unknown) => e instanceof ApiError && e.code === 'INVALID_INPUT',
    );
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('missing provider credentials fail the submission without blocking inspection or switching providers', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-chat-auth-'));
  const service = await startService({ dataDir, port: 0 });
  try {
    const client = new ChatClient(service.url);
    await configure(client);
    const conversation = await client.createConversation(
      'Missing connection',
      'no-auth',
    );
    await client.submit(
      conversation.id,
      'Offline credential check',
      'no-auth-input',
    );
    const result = await until(
      () => client.submission(conversation.id, 'no-auth-input'),
      (value) => value.status === 'failed',
    );
    assert.ok(result.reason);
    assert.equal(
      (await client.conversations()).conversations[0].model.provider,
      'requesty',
    );
    assert.equal((await fetch(`${service.url}/ready`)).status, 200);
    assert.equal((await client.settings()).credentials.requesty, false);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('history and reconnect snapshots preserve more than one page of messages', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-chat-pages-'));
  const service = await startService({ dataDir, port: 0, chat: fixture() });
  let stop: (() => void) | undefined;
  try {
    const client = new ChatClient(service.url);
    await configure(client);
    const conversation = await client.createConversation(
      'Long history',
      'history',
    );
    let latest: ConversationSnapshot | undefined;
    stop = client.watch(
      conversation.id,
      (value) => (latest = value),
      () => {},
    );
    for (let i = 0; i < 30; i++) {
      await client.submit(conversation.id, `Question ${i}`, `page-${i}`);
      await until(
        () => client.submission(conversation.id, `page-${i}`),
        (value) => value.status === 'completed',
      );
    }
    await until(
      async () => latest,
      (value) =>
        Boolean(
          value?.entries.some(
            (entry) => entry.text === 'Offline reply: Question 29',
          ),
        ),
    );
    assert.ok(latest!.entries.length <= 50);
    const first = await client.history(conversation.id);
    assert.equal(first.entries.length, 50);
    assert.ok(first.cursor);
    const second = await client.history(conversation.id, first.cursor);
    const all = mergeEntries(second.entries, first.entries);
    assert.equal(all.filter((entry) => entry.kind === 'pi.user').length, 30);
    assert.equal(
      all.filter((entry) => entry.kind === 'pi.assistant').length,
      30,
    );
    stop();
    latest = undefined;
    stop = client.watch(
      conversation.id,
      (value) => (latest = value),
      () => {},
    );
    await until(async () => latest, Boolean);
    assert.equal(latest!.entries.length, 50);
    assert.ok(latest!.olderCursor);
    assert.equal(
      (await client.history(conversation.id, latest!.olderCursor)).entries
        .length,
      all.length - latest!.entries.length,
    );
  } finally {
    stop?.();
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
