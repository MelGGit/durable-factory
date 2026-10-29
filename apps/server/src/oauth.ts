import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AuthInteraction,
  CredentialStore,
  LoginOptions,
} from '@earendil-works/pi-ai';
import {
  ApiError,
  type OAuthProvider,
  type OAuthSession,
} from '../../../packages/shared/src/index.js';
import { PrivateCredentials, CredentialStorageError } from './credentials.js';
import { createFactoryModels } from './providers.js';
import { safeAuthFailure, validateCallbackHost } from './auth-errors.js';

export async function installationDeviceId(dataDir: string) {
  const path = join(dataDir, 'device-id');
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const id = randomUUID();
    await writeFile(path, id, { mode: 0o600, flag: 'wx' });
    return id;
  }
}
export type OAuthLogin = (
  provider: OAuthProvider,
  store: CredentialStore,
  interaction: AuthInteraction,
  options: LoginOptions,
) => Promise<unknown>;
const defaultLogin: OAuthLogin = (provider, store, interaction, options) =>
  createFactoryModels(store).login(provider, 'oauth', interaction, options);
interface Session {
  view: OAuthSession;
  abort: AbortController;
  done: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  retire?: ReturnType<typeof setTimeout>;
  answer?: (answer: string) => void;
  committed: boolean;
}
export class OAuthSessions {
  private current?: Session;
  private closed = false;
  private disconnections = new Map<string, Promise<void>>();
  constructor(
    private credentials: PrivateCredentials,
    private dataDir: string,
    private login: OAuthLogin = defaultLogin,
    private lifetime = 10 * 60_000,
    private retention = 60_000,
  ) {}
  status(provider: OAuthProvider) {
    return this.current?.view.provider === provider
      ? structuredClone(this.current.view)
      : null;
  }
  async start(provider: OAuthProvider): Promise<OAuthSession> {
    if (this.closed)
      throw new ApiError('NOT_READY', 'The service is stopping.', 503);
    if (this.disconnections.has(provider))
      throw new ApiError(
        'BUSY',
        'Wait for this account to disconnect before signing in again.',
        409,
      );
    validateCallbackHost();
    if (this.current?.view.state === 'pending') {
      if (this.current.view.provider !== provider)
        throw new ApiError(
          'BUSY',
          'Finish or cancel the other provider sign-in first.',
          409,
        );
      return this.status(provider)!;
    }
    if (this.current) {
      const previous = this.current;
      await previous.done;
      if (this.closed)
        throw new ApiError('NOT_READY', 'The service is stopping.', 503);
      if (this.disconnections.has(provider))
        throw new ApiError(
          'BUSY',
          'Wait for this account to disconnect before signing in again.',
          409,
        );
      if (this.current !== previous) return this.start(provider);
      clearTimeout(previous.retire);
    }
    // Reserve synchronously before device-id or vault I/O, including concurrent starts.
    const session: Session = {
      view: {
        id: randomUUID(),
        provider,
        state: 'pending',
        expiresAt: Date.now() + this.lifetime,
      },
      abort: new AbortController(),
      done: Promise.resolve(),
      timer: setTimeout(() => {
        if (!session.committed) {
          session.view.state = 'expired';
          session.abort.abort();
          this.clearInteractive(session);
        }
      }, this.lifetime),
      committed: false,
    };
    session.timer.unref();
    this.current = session;
    session.done = this.run(session);
    return this.status(provider)!;
  }
  private clearInteractive(session: Session) {
    delete session.view.prompt;
    delete session.view.authUrl;
    delete session.view.deviceCode;
    delete session.answer;
  }
  private async run(session: Session) {
    const { provider } = session.view;
    const guard = () => {
      session.abort.signal.throwIfAborted();
      if (
        this.closed ||
        this.current !== session ||
        session.view.state !== 'pending'
      )
        throw new Error('Login cancelled');
    };
    const store: CredentialStore = {
      read: (...args) => this.credentials.read(...args),
      list: (...args) => this.credentials.list(...args),
      delete: (...args) => this.credentials.delete(...args),
      modify: async (id, fn) => {
        if (id !== provider) throw new Error('Unexpected login provider');
        const credential = await fn(undefined);
        if (!credential) throw new Error('Missing login credential');
        await this.credentials.commitLogin(
          id,
          credential,
          () => {
            guard();
            // Cancellation cannot roll back an already started vault write.
            session.committed = true;
          },
          session.abort.signal,
        );
        return credential;
      },
    };
    try {
      if ((await this.credentials.inspect()).errors[provider]) {
        await this.credentials.retry();
        // Replacement can repair corrupt credentials; inaccessible storage fails safely on write.
      }
      const deviceId = await installationDeviceId(this.dataDir);
      guard();
      await this.login(
        provider,
        store,
        {
          signal: session.abort.signal,
          prompt: (prompt) => {
            guard();
            const signal = AbortSignal.any([
              session.abort.signal,
              ...(prompt.signal ? [prompt.signal] : []),
            ]);
            return new Promise<string>((resolve, reject) => {
              const id = randomUUID();
              const finish = (answer?: string) => {
                signal.removeEventListener('abort', cancel);
                if (session.view.prompt?.id === id) {
                  delete session.view.prompt;
                  delete session.answer;
                }
                if (answer === undefined)
                  reject(new Error('Login prompt cancelled'));
                else resolve(answer);
              };
              const cancel = () => finish();
              session.view.prompt = {
                id,
                type: prompt.type,
                // Do not forward provider-owned messages which might contain response bodies.
                message:
                  prompt.type === 'select'
                    ? 'Choose a sign-in method'
                    : 'Paste the authorization code or final redirect URL',
                ...(prompt.type === 'select'
                  ? {
                      options: prompt.options.map(({ id, label }) => ({
                        id,
                        label,
                      })),
                    }
                  : {}),
              };
              session.answer = (answer) => finish(answer);
              signal.addEventListener('abort', cancel, { once: true });
              if (signal.aborted) cancel();
            });
          },
          notify: (event) => {
            guard();
            if (event.type === 'auth_url') {
              const url = new URL(event.url);
              const hostname =
                provider === 'openai' ? 'auth.openai.com' : 'claude.ai';
              if (
                url.protocol !== 'https:' ||
                url.hostname !== hostname ||
                url.username ||
                url.password ||
                (url.port && url.port !== '443')
              )
                throw new Error('Unexpected authorization URL');
              session.view.authUrl = event.url;
            } else if (event.type === 'device_code') {
              const url = new URL(event.verificationUri);
              if (
                url.protocol !== 'https:' ||
                url.hostname !== 'auth.openai.com' ||
                provider !== 'openai'
              )
                throw new Error('Unexpected verification URL');
              session.view.deviceCode = {
                userCode: event.userCode,
                verificationUri: event.verificationUri,
              };
            }
          },
        },
        { getDeviceId: () => deviceId, agentName: 'Durable Factory' },
      );
      if (!session.committed)
        throw new Error('Login did not store credentials');
      session.view.state = 'completed';
    } catch (error) {
      if (session.view.state === 'pending') {
        session.view.state = 'failed';
        const safe = safeAuthFailure(error);
        session.view.error = { category: safe.category, message: safe.message };
      }
    } finally {
      clearTimeout(session.timer);
      this.clearInteractive(session);
      session.retire = setTimeout(() => {
        if (this.current === session) this.current = undefined;
      }, this.retention);
      session.retire.unref();
    }
  }
  private find(provider: OAuthProvider, id: string) {
    if (
      !this.current ||
      this.current.view.provider !== provider ||
      this.current.view.id !== id
    )
      throw new ApiError(
        'NOT_FOUND',
        'Sign-in session not found. Start a new sign-in.',
        404,
      );
    return this.current;
  }
  answer(provider: OAuthProvider, id: string, input: unknown) {
    const session = this.find(provider, id);
    const prompt = session.view.prompt;
    const value = input as { promptId?: unknown; answer?: unknown } | null;
    if (
      session.view.state !== 'pending' ||
      !prompt ||
      !session.answer ||
      value?.promptId !== prompt.id
    )
      throw new ApiError(
        'CONFLICT',
        'This sign-in prompt is no longer active.',
        409,
      );
    if (
      typeof value?.answer !== 'string' ||
      !value.answer.trim() ||
      value.answer.length > 16384 ||
      value.answer.includes('\0') ||
      (prompt.options &&
        !prompt.options.some((option) => option.id === value.answer))
    )
      throw new ApiError(
        'INVALID_INPUT',
        'Enter a valid answer for the current sign-in prompt.',
        400,
      );
    session.answer(value.answer.trim());
    return this.status(provider)!;
  }
  async cancel(provider: OAuthProvider, id: string) {
    const session = this.find(provider, id);
    if (session.view.state === 'pending' && !session.committed) {
      session.view.state = 'cancelled';
      session.abort.abort();
      this.clearInteractive(session);
    }
    await session.done;
    return structuredClone(session.view);
  }
  async disconnect(provider: string) {
    const previous = this.disconnections.get(provider);
    if (previous) return previous;
    const operation = (async () => {
      if (this.current?.view.provider === provider)
        await this.cancel(this.current.view.provider, this.current.view.id);
      try {
        await this.credentials.delete(provider);
      } catch {
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          new CredentialStorageError().message,
          503,
        );
      }
    })();
    this.disconnections.set(provider, operation);
    try {
      await operation;
    } finally {
      this.disconnections.delete(provider);
    }
  }
  async close() {
    this.closed = true;
    if (this.current) {
      const session = this.current;
      await this.cancel(session.view.provider, session.view.id);
      clearTimeout(session.retire);
    }
    await Promise.allSettled([...this.disconnections.values()]);
  }
}
