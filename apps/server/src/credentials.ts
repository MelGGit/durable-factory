import { chmod, mkdir, readFile, lstat, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import {
  type CredentialId,
  type CredentialStorageStatus,
} from '../../../packages/shared/src/index.js';
import { withProcessLock } from './locking.js';
import { NativeCredentialVault } from './credential-vault.js';

export interface CredentialVault {
  readonly name: string;
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}
const ids: CredentialId[] = ['requesty', 'openai', 'anthropic', 'github'];
export interface CredentialInspection {
  configured: Record<CredentialId, boolean>;
  errors: Partial<Record<CredentialId, string>>;
  storage: CredentialStorageStatus;
}
export class CredentialStorageError extends Error {
  constructor() {
    super(
      'Secure credentials cannot be accessed. Unlock your system credential vault and retry secure storage, or reconnect the affected account.',
    );
  }
}
function validateCredential(value: unknown, id: string): Credential {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const credential = value as Record<string, unknown>;
    if (
      (id === 'requesty' || id === 'github') &&
      credential.type === 'api_key' &&
      typeof credential.key === 'string' &&
      credential.key.length > 0
    )
      return value as Credential;
    if (
      (id === 'openai' || id === 'anthropic') &&
      credential.type === 'oauth' &&
      typeof credential.access === 'string' &&
      credential.access.length > 0 &&
      typeof credential.refresh === 'string' &&
      credential.refresh.length > 0 &&
      typeof credential.expires === 'number' &&
      Number.isFinite(credential.expires)
    )
      return value as Credential;
  }
  throw new CredentialStorageError();
}

export class PrivateCredentials implements CredentialStore {
  private directory: string;
  private namespace = '';
  private types = new Map<CredentialId, Credential['type']>();
  private errors: CredentialInspection['errors'] = {};
  private revisions = new Map<CredentialId, number>();
  private pending = new Set<Promise<unknown>>();
  constructor(
    private dataDir: string,
    private vault: CredentialVault = new NativeCredentialVault(),
  ) {
    this.directory = join(dataDir, 'credentials');
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    this.namespace = createHash('sha256')
      .update(await realpath(this.dataDir))
      .digest('hex');
    await this.retry();
  }
  private id(id: string): CredentialId {
    if (!ids.includes(id as CredentialId))
      throw new Error('Unknown credential provider');
    return id as CredentialId;
  }
  private account(id: string) {
    return `${this.namespace}:${this.id(id)}`;
  }
  private path(id: string) {
    return join(this.directory, `${this.id(id)}.json`);
  }
  private locked<T>(work: () => Promise<T>, signal?: AbortSignal) {
    const operation = withProcessLock(
      join(this.directory, 'write.lock'),
      work,
      signal,
    );
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  private revision(id: CredentialId) {
    return this.revisions.get(id) ?? 0;
  }
  private async operation<T>(
    id: string,
    work: () => Promise<T>,
    revision?: number,
  ): Promise<T> {
    const provider = this.id(id);
    try {
      return await work();
    } catch {
      if (revision === undefined || revision === this.revision(provider)) {
        this.errors[provider] = new CredentialStorageError().message;
        this.revisions.set(provider, this.revision(provider) + 1);
      }
      throw new CredentialStorageError();
    }
  }
  private remember(id: string, credential?: Credential) {
    const provider = this.id(id);
    if (credential) this.types.set(provider, credential.type);
    else this.types.delete(provider);
    delete this.errors[provider];
    this.revisions.set(provider, this.revision(provider) + 1);
  }
  private async load(id: string) {
    const raw = await this.vault.get(this.account(id));
    return raw === undefined
      ? undefined
      : validateCredential(JSON.parse(raw), id);
  }
  // Only migration reads legacy files. Normal authentication never falls back.
  async retry() {
    await this.locked(async () => {
      for (const id of ids) {
        await this.operation(id, async () => {
          let credential = await this.load(id);
          let legacy = false;
          try {
            const stat = await lstat(this.path(id));
            if (!stat.isFile() || stat.isSymbolicLink())
              throw new CredentialStorageError();
            legacy = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (legacy && !credential) {
            credential = validateCredential(
              JSON.parse(await readFile(this.path(id), 'utf8')),
              id,
            );
            await this.save(id, credential);
          } else if (legacy) {
            // A verified vault entry is authoritative, including after rotation.
            await rm(this.path(id));
          }
          this.remember(id, credential);
        }).catch(() => {}); // Isolate unavailable/corrupt connections; Settings remains usable.
      }
    });
    return this.inspect();
  }
  async read(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const provider = this.id(id);
    const revision = this.revision(provider);
    // Reads remain optimistic so they do not wait behind token refresh. An older
    // read may finish, but cannot replace a newer mutation's status or error.
    return this.operation(
      id,
      async () => {
        if (this.errors[provider]) throw new CredentialStorageError();
        const credential = await this.load(id);
        if (revision === this.revision(provider)) this.remember(id, credential);
        return credential;
      },
      revision,
    );
  }
  async list(options?: { signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    if (Object.keys(this.errors).length) throw new CredentialStorageError();
    return ids
      .filter((id) => this.types.has(id))
      .map((providerId) => ({ providerId, type: this.types.get(providerId)! }));
  }
  async inspect(): Promise<CredentialInspection> {
    return {
      configured: Object.fromEntries(
        ids.map((id) => [id, this.types.has(id) && !this.errors[id]]),
      ) as Record<CredentialId, boolean>,
      errors: { ...this.errors },
      storage: {
        backend: this.vault.name,
        status: Object.keys(this.errors).length ? 'error' : 'ready',
      },
    };
  }
  private async save(id: string, credential: Credential) {
    validateCredential(credential, id);
    const raw = JSON.stringify(credential);
    // Do not cancel native mutations: they may still run after their JS promise rejects.
    await this.vault.set(this.account(id), raw);
    if ((await this.vault.get(this.account(id))) !== raw)
      throw new CredentialStorageError();
    await rm(this.path(id), { force: true });
    this.remember(id, credential);
  }
  async replace(
    id: string,
    credential: Credential,
    options?: { signal?: AbortSignal },
  ) {
    await this.locked(
      () => this.operation(id, () => this.save(id, credential)),
      options?.signal,
    );
  }
  // Login may repair a corrupt credential, but must check cancellation under the lock.
  async commitLogin(
    id: string,
    credential: Credential,
    guard: () => void,
    signal: AbortSignal,
  ) {
    await this.locked(async () => {
      guard();
      await this.operation(id, () => this.save(id, credential));
    }, signal);
  }
  async modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ) {
    return this.locked(async () => {
      const current = await this.read(id, options);
      const next = await fn(current); // Provider errors must not become storage errors.
      options?.signal?.throwIfAborted();
      if (next) await this.operation(id, () => this.save(id, next));
      return next ?? current;
    }, options?.signal);
  }
  async delete(id: string, options?: { signal?: AbortSignal }) {
    await this.locked(
      () =>
        this.operation(id, async () => {
          // Remove legacy data first so a failed vault deletion cannot resurrect it.
          await rm(this.path(id), { force: true });
          await this.vault.delete(this.account(id));
          if ((await this.vault.get(this.account(id))) !== undefined)
            throw new CredentialStorageError();
          this.remember(id);
        }),
      options?.signal,
    );
  }
}
