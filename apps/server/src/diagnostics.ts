import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { ApiError } from '../../../packages/shared/src/index.js';
import { acquireOwnership, defaultDataDir } from './runtime.js';
import { PrivateCredentials } from './credentials.js';
import { createFactoryModels, providerStatuses } from './providers.js';

export async function runDiagnostic(args: string[]) {
  process.umask(0o077);
  const [command, provider] = args;
  if (!command) {
    console.log(
      'Usage:\n  bun run diagnose status\n  bun run diagnose login openai|anthropic\n\nStop the local service before signing in or viewing connection status.',
    );
    return;
  }
  if (command !== 'status' && command !== 'login') {
    throw new ApiError(
      'INVALID_INPUT',
      'Unknown diagnostic command. Use status or login.',
      400,
    );
  }
  if (command === 'status' && args.length !== 1) {
    throw new ApiError('INVALID_INPUT', 'Usage: bun run diagnose status', 400);
  }
  if (
    command === 'login' &&
    (args.length !== 2 || !['openai', 'anthropic'].includes(provider))
  ) {
    throw new ApiError(
      'INVALID_INPUT',
      provider === 'requesty'
        ? 'Store your Requesty token in application settings.'
        : 'Usage: bun run diagnose login openai|anthropic',
      400,
    );
  }
  const owner = await acquireOwnership(defaultDataDir());
  const credentials = new PrivateCredentials(owner.dataDir);
  try {
    await credentials.init();
    if (command === 'status') {
      console.log(
        JSON.stringify(
          (await providerStatuses(credentials)).map(
            ({ id, configured, status }) => ({ id, configured, status }),
          ),
          null,
          2,
        ),
      );
      return;
    }
    const models = createFactoryModels(credentials);
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
        `${provider}: sign-in completed and credentials stored privately.`,
      );
    } finally {
      process.removeListener('SIGINT', interrupt);
      terminal.close();
    }
  } catch (error) {
    throw error instanceof ApiError
      ? error
      : new ApiError(
          'PROVIDER_UNAVAILABLE',
          'Connection operation failed. Check connectivity, subscription access, and credential storage permissions.',
          503,
        );
  } finally {
    await owner.release();
  }
}
