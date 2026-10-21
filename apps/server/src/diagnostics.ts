import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Type } from '@earendil-works/pi-ai';
import {
  ApiError,
  PROVIDERS,
  type ProviderId,
} from '../../../packages/shared/src/index.js';
import { acquireOwnership, defaultDataDir } from './runtime.js';
import { PrivateCredentials } from './credentials.js';
import {
  createFactoryModels,
  providerStatuses,
  refreshProviderCredentials,
} from './providers.js';
import { context } from './storage.js';

export async function runDiagnostic(args: string[]) {
  process.umask(0o077);
  const [command, provider, modelId] = args;
  if (
    !['status', 'login', 'check', 'interrupt', 'refresh'].includes(
      command ?? '',
    )
  ) {
    console.log(
      'Usage:\n  bun run diagnose status\n  bun run diagnose login openai|anthropic\n  bun run diagnose check requesty|openai|anthropic EXACT_MODEL_ID\n  bun run diagnose interrupt requesty|openai|anthropic EXACT_MODEL_ID\n  bun run diagnose refresh openai|anthropic\n\nStop the local service first. Checks make real model calls; no provider is selected automatically.',
    );
    return;
  }
  if (command !== 'status' && !PROVIDERS.includes(provider as ProviderId))
    throw new ApiError(
      'INVALID_INPUT',
      'Choose requesty, openai, or anthropic explicitly.',
      400,
    );
  if (
    ['check', 'interrupt'].includes(command) &&
    (!modelId || /\s/.test(modelId))
  )
    throw new ApiError(
      'INVALID_INPUT',
      'Supply the exact model ID explicitly.',
      400,
    );
  const owner = await acquireOwnership(defaultDataDir());
  const credentials = new PrivateCredentials(owner.dataDir);
  let tempDir: string | undefined;
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    await credentials.init();
    const models = createFactoryModels(
      credentials,
      provider === 'requesty' && modelId ? [modelId] : [],
    );
    if (command === 'status') {
      console.log(
        JSON.stringify(
          (await providerStatuses(credentials)).map(
            ({ id, configured, status }) => ({
              id,
              configured,
              status,
              accountAccess: 'untested',
            }),
          ),
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'login') {
      if (provider === 'requesty')
        throw new ApiError(
          'INVALID_INPUT',
          'Store your Requesty token in application settings.',
          400,
        );
      let deviceId: string;
      try {
        deviceId = await readFile(join(owner.dataDir, 'device-id'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        deviceId = randomUUID();
        await writeFile(join(owner.dataDir, 'device-id'), deviceId, {
          mode: 0o600,
          flag: 'wx',
        });
      }
      let hidden = false;
      const output = new Writable({
        write(chunk, _encoding, callback) {
          if (!hidden) process.stdout.write(chunk);
          callback();
        },
      });
      const terminal = createInterface({
        input: process.stdin,
        output,
        terminal: Boolean(process.stdout.isTTY),
      });
      const abort = new AbortController();
      const interrupt = () => abort.abort();
      process.once('SIGINT', interrupt);
      try {
        await models.login(
          provider,
          'oauth',
          {
            signal: abort.signal,
            async prompt(prompt) {
              if (prompt.type === 'select')
                for (const option of prompt.options)
                  console.log(`  ${option.id}: ${option.label}`);
              process.stdout.write(`${prompt.message}: `);
              hidden = prompt.type === 'secret';
              try {
                return await terminal.question('', {
                  signal: prompt.signal ?? abort.signal,
                });
              } finally {
                if (hidden) console.log();
                hidden = false;
              }
            },
            notify(event) {
              if (event.type === 'auth_url')
                console.log(
                  `Open this sign-in link:\n${event.url}\n${event.instructions ?? ''}`,
                );
              else if (event.type === 'device_code')
                console.log(
                  `Open ${event.verificationUri}; enter ${event.userCode}`,
                );
              else {
                console.log(event.message);
                if (event.type === 'info')
                  for (const link of event.links ?? []) console.log(link.url);
              }
            },
          },
          { getDeviceId: () => deviceId, agentName: 'Durable Factory' },
        );
        console.log(
          `${provider}: sign-in completed and credentials stored privately. Account/model access still requires a check.`,
        );
      } finally {
        process.removeListener('SIGINT', interrupt);
        terminal.close();
      }
      return;
    }
    const credential = await credentials.read(provider);
    if (!credential || (provider !== 'requesty' && credential.type !== 'oauth'))
      throw new ApiError(
        'AUTHENTICATION',
        'No matching stored credential. Sign in or store the Requesty token first.',
        401,
      );
    const deadline = AbortSignal.timeout(180000);
    if (command === 'refresh') {
      if (provider === 'requesty')
        throw new ApiError(
          'INVALID_INPUT',
          'Requesty uses an API key, not subscription token refresh.',
          400,
        );
      await refreshProviderCredentials(models, credentials, provider, deadline);
      await recordResult(owner.dataDir, provider, {
        command,
        status: 'passed',
        at: new Date().toISOString(),
      });
      console.log(`${provider}: provider-owned token refresh completed.`);
      return;
    }
    const model = models.getModel(provider, modelId);
    if (!model)
      throw new ApiError(
        'INVALID_INPUT',
        'That model is not in the selected provider catalog.',
        400,
      );
    await models.getAuth(provider, { signal: deadline });
    tempDir = await mkdtemp(join(tmpdir(), 'factory-live-'));
    const probe = defineTool({
      name: 'connection_probe',
      description:
        'Verify a harmless connection. Call with durable-factory-probe.',
      parameters: Type.Object({ value: Type.Literal('durable-factory-probe') }),
      replay: 'safe',
      execute: async () => ({
        output: [{ type: 'text', text: 'probe confirmed' }],
      }),
    });
    const registry = createRegistry();
    registry.install(
      defineExtension({ name: 'connection-diagnostic', tools: [probe] }),
    );
    harness = await Harness.open(
      await openNodeSqliteStorage(join(tempDir, 'live.sqlite')),
      {
        models,
        registry,
        settings: {
          retry: { maxRetries: 0 },
          stream: { timeoutMs: 180000 },
          progress: { partialIntervalMs: 10, outputIntervalMs: 10 },
        },
      },
      context,
    );
    const root = await harness.root(context, {
      agent: {
        model: { provider, modelId },
        instructions:
          'Run only the provided harmless probe. Do not request any credentials.',
      },
    });
    let streamed = false;
    let interrupted = false;
    let aborting: Promise<void> | undefined;
    const watch = await root.watch(context);
    watch.start(async (value) => {
      const live = value.docs['pi.live'] as
        | { generation?: { message?: unknown } }
        | undefined;
      if (live?.generation?.message) {
        streamed = true;
        if (command === 'interrupt' && !interrupted) {
          interrupted = true;
          aborting = root.abort(context);
        }
      }
    });
    try {
      const submission = await root.submit(
        {
          type: 'input',
          content:
            command === 'interrupt'
              ? 'Count slowly from 1 to 2000, one number per line. Do not call tools.'
              : 'Call connection_probe with value durable-factory-probe. Then explain in two short sentences that the connection and tool round-trip succeeded.',
        },
        context,
      );
      // A deadline aborts the actual run, not merely the wait.
      const timeout = setTimeout(() => {
        void root.abort(context);
      }, 180000).unref();
      let result;
      try {
        result = await submission.wait(context);
      } finally {
        clearTimeout(timeout);
      }
      await aborting;
      const entries = (
        await root.entries({ order: 'ascending' }, 100, undefined, context)
      ).items;
      if (command === 'interrupt') {
        const partialRetained = entries.some(
          (entry) =>
            entry.kind === 'pi.assistant' &&
            entry.model?.some(
              (message) =>
                message.role === 'assistant' &&
                message.stopReason === 'aborted',
            ),
        );
        if (!interrupted || result.status === 'done' || !partialRetained)
          throw new ApiError(
            'PROVIDER_UNAVAILABLE',
            'No interruptible streamed response was observed. Retry explicitly; no fallback was used.',
            503,
          );
        await recordResult(owner.dataDir, provider, {
          command,
          model: modelId,
          status: 'passed',
          committedPartialRetained: true,
          at: new Date().toISOString(),
        });
        console.log(
          `${provider}/${modelId}: interrupted successfully; the committed partial response is retained as aborted history.`,
        );
        return;
      }
      const tool = entries.some(
        (entry) =>
          entry.kind === 'pi.tool-result' &&
          entry.model?.some(
            (message) =>
              message.role === 'toolResult' &&
              message.toolName === 'connection_probe' &&
              !message.isError,
          ),
      );
      if (result.status !== 'done' || !tool)
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          'The provider check did not complete the required tool round-trip. No alternate provider was used.',
          503,
        );
      await recordResult(owner.dataDir, provider, {
        command,
        model: modelId,
        status: streamed ? 'passed' : 'partial',
        toolRoundTrip: true,
        committedStreamingObserved: streamed,
        at: new Date().toISOString(),
      });
      console.log(
        `${provider}/${modelId}: tool round-trip passed; committed streaming ${streamed ? 'observed' : 'not observed (retry with a longer response to verify)'}. No fallback used.`,
      );
    } finally {
      await watch.stop();
    }
  } catch (error) {
    if (provider)
      await recordResult(owner.dataDir, provider, {
        command,
        ...(modelId ? { model: modelId } : {}),
        status: 'blocked',
        code: error instanceof ApiError ? error.code : 'PROVIDER_UNAVAILABLE',
        at: new Date().toISOString(),
      });
    throw error instanceof ApiError
      ? error
      : new ApiError(
          'PROVIDER_UNAVAILABLE',
          'Provider operation failed. Check connectivity, subscription access, usage limits, and credentials. No alternate provider was used.',
          503,
        );
  } finally {
    if (harness) await harness.close(context);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    await owner.release();
  }
}
async function recordResult(
  directory: string,
  provider: string,
  result: Record<string, unknown>,
) {
  const target = join(directory, 'provider-checks.json');
  let previous: Record<string, unknown> = {};
  try {
    previous = JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify(
        { ...previous, [`${provider}:${result.command}`]: result },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
