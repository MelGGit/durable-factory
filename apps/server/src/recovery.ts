import { join } from 'node:path';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { Type } from '@earendil-works/pi-ai';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { acquireOwnership } from './runtime.js';
import { context } from './storage.js';
export type RecoveryScenario = 'model' | 'safe' | 'unsafe';
export async function recoveryWorker(
  dataDir: string,
  scenario: RecoveryScenario,
  mode: 'crash' | 'resume',
  notify: (value: unknown) => void,
) {
  process.umask(0o077);
  const owner = await acquireOwnership(dataDir);
  const faux = fauxProvider({
    models: [{ id: 'deterministic', contextWindow: 32768 }],
    tokensPerSecond: mode === 'crash' && scenario === 'model' ? 20 : Infinity,
    tokenSize: { min: 1, max: 1 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  // Choose from persisted model context, never an in-memory response index.
  faux.setResponses(
    Array.from({ length: 10 }, () => async (input) => {
      if (
        input.messages.some((message) => message.role === 'toolResult') ||
        scenario === 'model'
      )
        return fauxAssistantMessage(
          'Recovered conversation. '.repeat(
            scenario === 'model' && mode === 'crash' ? 100 : 1,
          ),
        );
      return fauxAssistantMessage(
        fauxToolCall('controlled_probe', {}, { id: 'controlled-call' }),
        { stopReason: 'toolUse' },
      );
    }),
  );
  const registry = createRegistry();
  const probe = defineTool({
    name: 'controlled_probe',
    description: 'A controlled disposable recovery fixture',
    parameters: Type.Object({}),
    ...(scenario === 'safe' ? { replay: 'safe' as const } : {}),
    execute: async (_args, api) => {
      await appendFile(join(dataDir, 'invocations.txt'), 'called\n', {
        mode: 0o600,
      });
      if (scenario === 'unsafe')
        await appendFile(join(dataDir, 'effects.txt'), 'external-effect\n', {
          mode: 0o600,
        });
      api.output('Committed progress before interruption.\n');
      if (mode === 'crash') {
        // Wait for retained output to commit, so recovery can inspect partial output.
        await delay(150);
        notify({ phase: scenario });
        await new Promise(() => {});
      }
      return {
        output: [
          {
            type: 'text' as const,
            text:
              scenario === 'safe'
                ? await readFile(join(dataDir, 'fixture.txt'), 'utf8')
                : 'effect complete',
          },
        ],
      };
    },
  });
  registry.install(
    defineExtension({ name: 'recovery-fixtures', tools: [probe] }),
  );
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dataDir, 'recovery.sqlite')),
    {
      models,
      registry,
      settings: {
        retry: { maxRetries: 0 },
        progress: { partialIntervalMs: 10, outputIntervalMs: 10 },
      },
    },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: {
        model: { provider: faux.provider.id, modelId: 'deterministic' },
      },
    });
    const before = await harness.inspect(context);
    let watch: Awaited<ReturnType<typeof root.watch>> | undefined;
    if (scenario === 'model' && mode === 'crash') {
      watch = await root.watch(context);
      let signalled = false;
      watch.start(async (value) => {
        if (
          !signalled &&
          JSON.stringify(value.docs['pi.live']).includes('Recovered')
        ) {
          signalled = true;
          notify({ phase: 'model', partialCommitted: true });
        }
      });
    }
    const submission = await root.submit(
      {
        type: 'input',
        content: 'Run the controlled recovery probe.',
        requestId: 'stable-probe-input',
      },
      context,
    );
    if (mode === 'crash') {
      await writeFile(
        join(dataDir, 'submission-id.txt'),
        String(submission.id),
        { mode: 0o600 },
      );
      await root.submit(
        {
          type: 'input',
          content: 'Queued follow-up.',
          requestId: 'queued-follow-up',
        },
        context,
      );
    }
    const result = await submission.wait(context);
    await root.waitForIdle(context);
    const repeat = await root.submit(
      {
        type: 'input',
        content: 'Run the controlled recovery probe.',
        requestId: 'stable-probe-input',
      },
      context,
    );
    const entries = (
      await root.entries({ order: 'ascending' }, 100, undefined, context)
    ).items;
    const queued = await root.submit(
      {
        type: 'input',
        content: 'Queued follow-up.',
        requestId: 'queued-follow-up',
      },
      context,
    );
    const queuedResult = await queued.wait(context);
    await watch?.stop();
    notify({
      phase: 'done',
      result,
      before,
      submissionId: submission.id,
      repeatedId: repeat.id,
      queuedResult,
      entries,
      conversationId: root.id,
    });
  } finally {
    await harness.close(context);
    await owner.release();
  }
}
