import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../apps/server/src/service.js';
import {
  ChatClient,
  ApiError,
  type ConversationSnapshot,
} from '../packages/shared/src/index.js';
import { fixture, configure, until } from './fixtures/chat.js';
import { fauxAssistantMessage } from '../apps/server/src/chat-fixtures.js';
import { TitleState, shortTitle } from '../apps/server/src/titles.js';
import { Catalog } from '../apps/server/src/chat.js';
import { context } from '../apps/server/src/storage.js';
import { Deletions } from '../apps/server/src/deletion-state.js';
import type { ConversationId } from '../apps/server/node_modules/@earendil-works/pi-durable/dist/index.js';

const selection = {
  provider: 'requesty' as const,
  model: 'offline',
  reasoning: null,
};
const generic = 'New planning conversation';
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-titles-'));
  const deps = fixture();
  let service = await startService({ dataDir, port: 0, chat: deps });
  let client = new ChatClient(service.url);
  await configure(client);
  return {
    deps,
    get client() {
      return client;
    },
    get service() {
      return service;
    },
    get harness() {
      return service.workflow['harness'];
    },
    async restart() {
      await service.close();
      service = await startService({ dataDir, port: 0, chat: deps });
      client = new ChatClient(service.url);
    },
    async close() {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('title settings are shared, revisioned, validated, and persist after restart', async () => {
  const f = await setup();
  try {
    assert.deepEqual(await f.client.titleGenerator(), {
      revision: 0,
      selection: null,
    });
    await f.client.saveTitleGenerator({ revision: 0, selection });
    const project = await f.client.createProject('Other');
    assert.deepEqual(
      await new ChatClient(
        f.service.url,
        undefined,
        project.id,
      ).titleGenerator(),
      { revision: 1, selection },
    );
    await assert.rejects(
      f.client.saveTitleGenerator({ revision: 0, selection: null }),
      (e) => e instanceof ApiError && e.code === 'CONFLICT',
    );
    for (const bad of [
      { ...selection, model: '' },
      { ...selection, model: 'white space' },
      { ...selection, provider: 'unknown' },
      { ...selection, reasoning: 'invalid' },
    ]) {
      await assert.rejects(
        f.client.saveTitleGenerator({
          revision: 1,
          selection: bad as typeof selection,
        }),
        (e) => e instanceof ApiError && e.code === 'INVALID_INPUT',
      );
    }
    await f.restart();
    assert.deepEqual(await f.client.titleGenerator(), {
      revision: 1,
      selection,
    });
  } finally {
    await f.close();
  }
});

test('first-message fallback is stable, Unicode-safe, and preserves creation retries and custom/legacy titles', async () => {
  const f = await setup();
  try {
    let calls = 0;
    f.deps.models.completeSimple = async () => {
      calls++;
      return fauxAssistantMessage('Unwanted');
    };
    const conversation = await f.client.createConversation(generic, 'generic');
    await f.client.submit(
      conversation.id,
      '  Fix\n  the sidebar layout  ',
      'first',
    );
    await f.client.submit(
      conversation.id,
      '  Fix\n  the sidebar layout  ',
      'first',
    );
    assert.equal(
      (await f.client.conversations()).conversations[0].title,
      'Fix the sidebar layout',
    );
    assert.equal(
      (await f.client.createConversation(generic, 'generic')).id,
      conversation.id,
    );
    await assert.rejects(
      f.client.createConversation('Different', 'generic'),
      (e) => e instanceof ApiError && e.code === 'CONFLICT',
    );
    await f.client.submit(conversation.id, 'Do not rename again', 'second');
    assert.equal(
      (await f.client.conversations()).conversations[0].title,
      'Fix the sidebar layout',
    );
    const custom = await f.client.createConversation(
      'My custom title',
      'custom',
    );
    await f.client.submit(custom.id, 'Different wording', 'custom-first');
    assert.equal(
      (await f.client.conversations()).conversations.find(
        (c) => c.id === custom.id,
      )?.title,
      'My custom title',
    );
    const legacy = await f.client.createConversation(generic, 'legacy');
    await f.harness.commit(async (tx) => {
      (await tx.doc(TitleState, Number(legacy.id) as ConversationId)).eligible =
        false;
    }, context);
    await f.client.submit(legacy.id, 'Keep old history', 'legacy-first');
    assert.equal(
      (await f.client.conversations()).conversations.find(
        (c) => c.id === legacy.id,
      )?.title,
      generic,
    );
    assert.equal(calls, 0);
    assert.equal(Array.from(shortTitle('😀'.repeat(90))).length, 80);
    await f.restart();
    assert.equal(
      (await f.client.conversations()).conversations.find(
        (c) => c.id === conversation.id,
      )?.title,
      'Fix the sidebar layout',
    );
  } finally {
    await f.close();
  }
});

test('AI titles run separately from planning, stream live, and generate only once', async () => {
  const f = await setup();
  let stop: (() => void) | undefined;
  try {
    let resolve!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
    let calls = 0;
    f.deps.models.completeSimple = async (_model, input, options) => {
      calls++;
      assert.equal(input.tools, undefined);
      assert.ok(input.systemPrompt?.includes('3–8 words'));
      assert.ok(options?.signal);
      return new Promise((done) => {
        resolve = done;
      });
    };
    await f.client.saveTitleGenerator({ revision: 0, selection });
    const c = await f.client.createConversation(generic, 'ai');
    let snapshot: ConversationSnapshot | undefined;
    stop = f.client.watch(
      c.id,
      (value) => {
        snapshot = value;
      },
      () => {},
    );
    await f.client.submit(
      c.id,
      'Improve the sidebar and project navigation',
      'first',
    );
    await until(
      () => f.client.submission(c.id, 'first'),
      (s) => s.status === 'completed',
    );
    await until(
      async () => calls,
      (n) => n === 1,
    );
    assert.equal(
      (await f.client.conversations()).conversations[0].title,
      'Improve the sidebar and project navigation',
    );
    await f.client.saveTitleGenerator({ revision: 1, selection: null });
    resolve(fauxAssistantMessage('"Refine project navigation"'));
    await until(
      async () => snapshot?.conversation.title,
      (title) => title === 'Refine project navigation',
    );
    await f.client.submit(c.id, 'A follow-up', 'second');
    await f.client.submit(
      c.id,
      'Improve the sidebar and project navigation',
      'first',
    );
    assert.equal(calls, 1);
    assert.equal((await f.client.createConversation(generic, 'ai')).id, c.id);
  } finally {
    stop?.();
    await f.close();
  }
});

test('failed and empty title responses keep the fallback without failing planning', async () => {
  const f = await setup();
  try {
    await f.client.saveTitleGenerator({ revision: 0, selection });
    for (const [i, response] of [null, '', 'provider-error'].entries()) {
      f.deps.models.completeSimple = async () => {
        if (response === null) throw new Error('private provider failure');
        return fauxAssistantMessage(response, {
          stopReason: response === 'provider-error' ? 'error' : 'stop',
        });
      };
      const c = await f.client.createConversation(generic, `failure-${i}`);
      await f.client.submit(c.id, `Fallback ${i}`, `message-${i}`);
      await until(
        () =>
          f.harness.snapshot(
            TitleState,
            Number(c.id) as ConversationId,
            context,
          ),
        (s) => s?.state === 'done',
      );
      assert.equal(
        (await f.client.conversations()).conversations.find(
          (v) => v.id === c.id,
        )?.title,
        `Fallback ${i}`,
      );
      await until(
        () => f.client.submission(c.id, `message-${i}`),
        (s) => s.status === 'completed',
      );
    }
  } finally {
    await f.close();
  }
});

test('queued titles recover; uncertain in-flight calls are never repeated; deletion ignores late completion', async () => {
  const f = await setup();
  try {
    let calls = 0;
    f.deps.models.completeSimple = async () => {
      calls++;
      return fauxAssistantMessage('Recovered title');
    };
    const queued = await f.client.createConversation(generic, 'queued');
    const uncertain = await f.client.createConversation(generic, 'uncertain');
    await f.harness.commit(async (tx) => {
      for (const [id, state] of [
        [queued.id, 'queued'],
        [uncertain.id, 'running'],
      ] as const) {
        const doc = await tx.doc(TitleState, Number(id) as ConversationId);
        doc.state = state;
        doc.input = 'Pending input';
        doc.selection = selection;
        (await tx.doc(Catalog)).items[id].title = 'Pending input';
      }
    }, context);
    await f.restart();
    await until(
      () => f.client.conversations(),
      (s) => s.conversations.some((c) => c.title === 'Recovered title'),
    );
    assert.equal(
      (await f.client.conversations()).conversations.find(
        (c) => c.id === uncertain.id,
      )?.title,
      'Pending input',
    );
    assert.equal(calls, 1);
    // A blocked deletion retains its conversation and must still reject a late title.
    let release!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
    f.deps.models.completeSimple = async () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    await f.client.saveTitleGenerator({ revision: 0, selection });
    const c = await f.client.createConversation(generic, 'deleting');
    await f.client.submit(c.id, 'Deletion fallback', 'delete-first');
    await until(
      async () => calls,
      (n) => n === 2,
    );
    await f.harness.commit(async (tx) => {
      (await tx.doc(Deletions)).items.test = {
        id: 'test',
        conversationIds: [c.id],
        state: 'blocked',
        message: 'Fixture deletion',
      };
    }, context);
    release(fauxAssistantMessage('Do not publish this title'));
    await f.service.chat!['titles'].stop(c.id);
    assert.equal(
      (await f.client.conversations()).conversations.find((v) => v.id === c.id)
        ?.title,
      'Deletion fallback',
    );
  } finally {
    await f.close();
  }
});

test('shutdown aborts title requests that ignore cancellation and restart keeps the fallback', async () => {
  const f = await setup();
  try {
    let calls = 0;
    f.deps.models.completeSimple = async () => {
      calls++;
      return new Promise(() => {});
    };
    await f.client.saveTitleGenerator({ revision: 0, selection });
    const c = await f.client.createConversation(generic, 'shutdown');
    await f.client.submit(c.id, 'Shutdown fallback', 'first');
    await until(
      async () => calls,
      (n) => n === 1,
    );
    await f.restart();
    assert.equal(calls, 1);
    assert.equal(
      (await f.client.conversations()).conversations[0].title,
      'Shutdown fallback',
    );
  } finally {
    await f.close();
  }
});

test(
  'a timed-out title request retains its fallback and does not retry',
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      let calls = 0;
      f.deps.models.completeSimple = async () => {
        calls++;
        return new Promise(() => {});
      };
      await f.client.saveTitleGenerator({ revision: 0, selection });
      const c = await f.client.createConversation(generic, 'timeout');
      await f.client.submit(c.id, 'Timeout fallback', 'first');
      await until(
        () =>
          f.harness.snapshot(
            TitleState,
            Number(c.id) as ConversationId,
            context,
          ),
        (s) => s?.state === 'done',
        25000,
      );
      assert.equal(
        (await f.client.conversations()).conversations[0].title,
        'Timeout fallback',
      );
      await f.client.submit(c.id, 'Keep the same title', 'second');
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
  },
);
