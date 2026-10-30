/** Test-only persistent fake. Never imported by the production entrypoint. */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after } from 'node:test';
import {
  PrivateCredentials as ProductionCredentials,
  type CredentialVault,
} from '../../apps/server/src/credentials.js';
import {
  startService as productionService,
  type ServiceOptions,
} from '../../apps/server/src/service.js';
import { runDiagnostic as productionDiagnostic } from '../../apps/server/src/diagnostics.js';
export * from '../../apps/server/src/service.js';

export function credentialFile(dataDir: string, id: string) {
  const hash = createHash('sha256').update(realpathSync(dataDir)).digest('hex');
  return join(dataDir, 'test-vault', `${hash}-${id}.json`);
}
export class FileVault implements CredentialVault {
  readonly name = 'Test vault';
  constructor(private dataDir: string) {}
  private path(account: string) {
    if (!/^[a-f0-9]{64}:(requesty|github|openai|anthropic)$/.test(account))
      throw new Error('Invalid test account');
    return join(
      this.dataDir,
      'test-vault',
      `${account.replace(':', '-')}.json`,
    );
  }
  async get(account: string) {
    try {
      return await readFile(this.path(account), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async set(account: string, value: string) {
    await mkdir(join(this.dataDir, 'test-vault'), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.path(account)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path(account));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async delete(account: string) {
    await rm(this.path(account), { force: true });
  }
}
export class PrivateCredentials extends ProductionCredentials {
  constructor(
    dataDir: string,
    vault: CredentialVault = new FileVault(dataDir),
  ) {
    super(dataDir, vault);
  }
}
type Service = Awaited<ReturnType<typeof productionService>>;
const started = new Set<Service>();
let registered = false;
// A test that fails before its own cleanup (for example when the browser cannot
// launch) would otherwise leave this listening socket holding the process open.
// close() is idempotent, so closing everything again here is always safe.
// Registered on first use: non-test importers, like the terminal login worker,
// must not start a test runner just by importing this module.
function closeLeftovers() {
  if (registered) return;
  registered = true;
  after(async () => {
    await Promise.allSettled([...started].map((service) => service.close()));
  });
}
export async function startService(options: ServiceOptions) {
  if (!options.dataDir)
    throw new Error('Tests require an explicit disposable data directory');
  const service = await productionService({
    ...options,
    credentialVault: options.credentialVault ?? new FileVault(options.dataDir),
  });
  closeLeftovers();
  started.add(service);
  return service;
}
export function runDiagnostic(args: string[]) {
  const directory = process.env.DURABLE_FACTORY_DATA_DIR;
  if (args.length && !directory)
    throw new Error('Tests require a disposable diagnostic directory');
  return productionDiagnostic(
    args,
    directory ? { credentialVault: new FileVault(directory) } : {},
  );
}
