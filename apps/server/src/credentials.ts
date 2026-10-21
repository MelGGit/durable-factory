import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { type CredentialId } from '../../../packages/shared/src/index.js';
import { withProcessLock } from './locking.js';

const ids: CredentialId[] = ['requesty', 'openai', 'anthropic', 'github'];
export interface CredentialInspection {
  configured: Record<CredentialId, boolean>;
  errors: Partial<Record<CredentialId, string>>;
}
function validateCredential(value: unknown, id: string): Credential {
  if (value && typeof value === 'object') {
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
      typeof credential.expires === 'number' &&
      Number.isFinite(credential.expires)
    )
      return value as Credential;
  }
  throw new Error('Stored credential is invalid.');
}

export class PrivateCredentials implements CredentialStore {
  private directory: string;
  constructor(dataDir: string) {
    this.directory = join(dataDir, 'credentials');
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }
  private path(id: string) {
    if (!ids.includes(id as CredentialId))
      throw new Error('Unknown credential provider');
    return join(this.directory, `${id}.json`);
  }
  async read(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    try {
      return validateCredential(
        JSON.parse(await readFile(this.path(id), 'utf8')),
        id,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  // Pi's CredentialStore remains strict: authentication never hides a corrupt
  // credential as "missing" or falls back to another source.
  async list(options?: { signal?: AbortSignal }) {
    const entries = [];
    for (const providerId of ids) {
      const credential = await this.read(providerId, options);
      if (credential) entries.push({ providerId, type: credential.type });
    }
    return entries;
  }
  // App inspection isolates read failures and returns fixed, secret-free errors.
  async inspect(): Promise<CredentialInspection> {
    const configured = Object.fromEntries(
      ids.map((id) => [id, false]),
    ) as Record<CredentialId, boolean>;
    const errors: CredentialInspection['errors'] = {};
    await Promise.all(
      ids.map(async (id) => {
        try {
          configured[id] = Boolean(await this.read(id));
        } catch {
          errors[id] =
            'Stored credentials cannot be read. Replace the token or remove the connection and sign in again.';
        }
      }),
    );
    return { configured, errors };
  }
  private locked<T>(work: () => Promise<T>, signal?: AbortSignal) {
    return withProcessLock(join(this.directory, 'write.lock'), work, signal);
  }
  private async write(id: string, credential: Credential) {
    validateCredential(credential, id);
    const target = this.path(id),
      temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(credential), {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  // Explicit user replacement may repair a malformed file without reading it.
  async replace(
    id: string,
    credential: Credential,
    options?: { signal?: AbortSignal },
  ) {
    await this.locked(() => this.write(id, credential), options?.signal);
  }
  async modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ) {
    return this.locked(async () => {
      const current = await this.read(id, options);
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next) await this.write(id, next);
      return next ?? current;
    }, options?.signal);
  }
  async delete(id: string, options?: { signal?: AbortSignal }) {
    await this.locked(
      () => rm(this.path(id), { force: true }),
      options?.signal,
    );
  }
}
