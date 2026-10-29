import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ApiError,
  type OAuthPrompt,
  type OAuthProvider,
} from '../../../packages/shared/src/index.js';
import { acquireOwnership, defaultDataDir } from './runtime.js';
import { PrivateCredentials, type CredentialVault } from './credentials.js';
import { providerStatuses } from './providers.js';
import { OAuthSessions, type OAuthLogin } from './oauth.js';

export function selectionAnswer(prompt: OAuthPrompt, answer: string) {
  if (!prompt.options?.length) return answer.trim();
  const value = answer.trim();
  if (!value) return prompt.options[0].id;
  const exact = prompt.options.find((option) => option.id === value);
  if (exact) return exact.id;
  if (/^[1-9]\d*$/.test(value)) return prompt.options[Number(value) - 1]?.id;
  return undefined;
}

export async function runDiagnostic(
  args: string[],
  dependencies: {
    credentialVault?: CredentialVault;
    oauthLogin?: OAuthLogin;
  } = {},
) {
  process.umask(0o077);
  const [command, provider] = args;
  if (!command) {
    console.log(
      'Usage:\n  bun run diagnose status\n  bun run diagnose login openai|anthropic\n\nConnect in Settings while the app runs, or stop the service before using these terminal diagnostics.',
    );
    return;
  }
  if (command !== 'status' && command !== 'login')
    throw new ApiError(
      'INVALID_INPUT',
      'Unknown diagnostic command. Use status or login.',
      400,
    );
  if (command === 'status' && args.length !== 1)
    throw new ApiError('INVALID_INPUT', 'Usage: bun run diagnose status', 400);
  if (
    command === 'login' &&
    (args.length !== 2 || !['openai', 'anthropic'].includes(provider))
  )
    throw new ApiError(
      'INVALID_INPUT',
      provider === 'requesty'
        ? 'Store your Requesty token in application settings.'
        : 'Usage: bun run diagnose login openai|anthropic',
      400,
    );
  const owner = await acquireOwnership(defaultDataDir());
  const credentials = new PrivateCredentials(
    owner.dataDir,
    dependencies.credentialVault,
  );
  let sessions: OAuthSessions | undefined;
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
    sessions = new OAuthSessions(
      credentials,
      owner.dataDir,
      dependencies.oauthLogin,
    );
    const selected = provider as OAuthProvider;
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
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
    const abort = new AbortController();
    const interrupt = () => abort.abort();
    terminal.once('close', interrupt);
    process.once('SIGINT', interrupt);
    let question:
      | { id: string; abort: AbortController; done: Promise<void> }
      | undefined;
    let shownUrl: string | undefined;
    try {
      await sessions.start(selected);
      while (!abort.signal.aborted) {
        const session = sessions.status(selected);
        if (!session) throw new Error('Login expired');
        if (session.state !== 'pending') {
          if (session.state === 'completed') {
            console.log(
              `${provider}: sign-in completed and credentials stored securely.`,
            );
            return;
          }
          throw new ApiError(
            'PROVIDER_UNAVAILABLE',
            session.error?.message ??
              'Sign-in cancelled or expired. Start a new sign-in.',
            503,
          );
        }
        if (session.authUrl && session.authUrl !== shownUrl) {
          shownUrl = session.authUrl;
          hidden = false;
          console.log(`Open this sign-in link:\n${session.authUrl}`);
          hidden = Boolean(question);
        }
        if (question && session.prompt?.id !== question.id) {
          question.abort.abort();
          await question.done;
          question = undefined;
        }
        if (session.prompt && !question) {
          const prompt = session.prompt;
          const cancellation = new AbortController();
          const signal = AbortSignal.any([cancellation.signal, abort.signal]);
          const done = (async () => {
            try {
              if (prompt.options)
                for (const [index, option] of prompt.options.entries())
                  console.log(
                    `  ${index + 1}. ${option.label} (${option.id})${index === 0 ? ' [default]' : ''}`,
                  );
              while (!signal.aborted) {
                process.stdout.write(`${prompt.message}: `);
                hidden =
                  prompt.type === 'secret' || prompt.type === 'manual_code';
                const raw = await terminal.question('', { signal });
                if (hidden) {
                  hidden = false;
                  console.log();
                }
                const answer = selectionAnswer(prompt, raw);
                if (!answer) {
                  console.log(
                    prompt.options
                      ? 'Choose an option number or ID, or press Enter for the default.'
                      : 'Enter the authorization code or full redirect URL, or press Ctrl+C to cancel.',
                  );
                  continue;
                }
                sessions!.answer(selected, session.id, {
                  promptId: prompt.id,
                  answer,
                });
                return;
              }
            } catch {
              if (!signal.aborted) abort.abort();
            } finally {
              hidden = false;
            }
          })();
          question = { id: prompt.id, abort: cancellation, done };
        }
        await delay(50);
      }
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        'Sign-in cancelled. Start a new sign-in when ready.',
        503,
      );
    } finally {
      question?.abort.abort();
      await question?.done;
      process.removeListener('SIGINT', interrupt);
      terminal.removeListener('close', interrupt);
      terminal.close();
    }
  } catch (error) {
    throw error instanceof ApiError
      ? error
      : new ApiError(
          'PROVIDER_UNAVAILABLE',
          'Connection operation failed. Unlock your credential vault, check connectivity, and retry.',
          503,
        );
  } finally {
    await sessions?.close();
    await credentials.drain();
    await owner.release();
  }
}
