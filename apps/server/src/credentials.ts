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
import lockfile from 'proper-lockfile';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';

// All processes use this lock, including provider-owned token refresh callbacks.
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
    if (!['requesty', 'openai', 'anthropic', 'github'].includes(id))
      throw new Error('Unknown credential provider');
    return join(this.directory, `${id}.json`);
  }
  async read(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    try {
      return JSON.parse(await readFile(this.path(id), 'utf8')) as Credential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async list(options?: { signal?: AbortSignal }) {
    const entries = [];
    for (const providerId of ['requesty', 'openai', 'anthropic', 'github']) {
      const credential = await this.read(providerId, options);
      if (credential) entries.push({ providerId, type: credential.type });
    }
    return entries;
  }
  private async locked<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    // Service/CLI ownership prevents cross-process contention; this also serializes concurrent refreshes.
    const release = await lockfile.lock(this.directory, {
      stale: 10000,
      update: 2000,
      retries: { retries: 200, minTimeout: 20, maxTimeout: 50 },
      onCompromised: () => process.exit(1),
    });
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      await release();
    }
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
      if (next) {
        const target = this.path(id),
          temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next), {
            mode: 0o600,
            flag: 'wx',
          });
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
      }
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
