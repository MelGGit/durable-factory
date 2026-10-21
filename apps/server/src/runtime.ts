import { mkdir, realpath, chmod, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, relative, join, sep } from 'node:path';
import lockfile from 'proper-lockfile';
import { ApiError } from '../../../packages/shared/src/index.js';

function findSourceRoot() {
  let directory = import.meta.dirname;
  while (directory !== resolve(directory, '..')) {
    try {
      if (
        JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
          .name === 'durable-factory'
      )
        return directory;
    } catch {}
    directory = resolve(directory, '..');
  }
  throw new Error('Cannot locate application installation root.');
}
export const sourceRoot = findSourceRoot();
export const defaultDataDir = () =>
  process.env.DURABLE_FACTORY_DATA_DIR ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/Durable Factory')
    : join(
        process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'),
        'durable-factory',
      ));
export function inside(path: string, parent: string) {
  const rel = relative(parent, path);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}
export async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = resolve(path, '..');
    if (parent === path) throw error;
    return join(
      await canonical(parent),
      path.slice(parent.length + (parent.endsWith('/') ? 0 : 1)),
    );
  }
}
export async function acquireOwnership(input: string) {
  if (!isAbsolute(input))
    throw new ApiError(
      'INVALID_INPUT',
      'The runtime data directory must be an absolute path.',
      400,
    );
  const dataDir = await canonical(resolve(input));
  if (inside(dataDir, await realpath(sourceRoot)))
    throw new ApiError(
      'INVALID_INPUT',
      'Runtime data must be outside the application source directory.',
      400,
    );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  let compromised = false;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(dataDir, {
      realpath: true,
      stale: 10000,
      update: 2000,
      retries: 0,
      onCompromised: () => {
        compromised = true;
        process.stderr.write(
          '{"level":"error","event":"storage_ownership_lost"}\n',
        );
        process.exit(1);
      },
    });
  } catch {
    throw new ApiError(
      'BUSY',
      'Another service or diagnostic owns this data directory. Stop it first; after a crash, retry in 10 seconds.',
      409,
    );
  }
  return {
    dataDir,
    release: async () => {
      if (!compromised) await release();
    },
  };
}
export async function validateRepositoryLocation(
  path: string,
  dataDir: string,
) {
  if (!path) return;
  if (!isAbsolute(path))
    throw new ApiError(
      'INVALID_INPUT',
      'Repository path must be absolute.',
      400,
    );
  const target = await canonical(path);
  const runtime = await canonical(dataDir);
  if (inside(runtime, target) || inside(target, runtime))
    throw new ApiError(
      'INVALID_INPUT',
      'Repository and runtime data directories must be separate.',
      400,
    );
  return target;
}
export async function validateRepository(path: string, dataDir: string) {
  const target = await validateRepositoryLocation(path, dataDir);
  if (!target) return;
  try {
    if (!(await stat(target)).isDirectory()) throw new Error();
    await stat(join(target, '.git'));
  } catch {
    throw new ApiError(
      'INVALID_INPUT',
      'Choose an existing Git repository directory.',
      400,
    );
  }
}
// Log fixed event names and allowlisted metadata only; never request bodies or provider errors.
export function log(
  event: string,
  fields: { code?: string; port?: number; state?: string } = {},
) {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: 'info', event, ...fields })}\n`,
  );
}
