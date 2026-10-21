import { mkdir, realpath, chmod, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, relative, join, sep } from 'node:path';
import { acquireProcessLock } from './locking.js';
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
  // Older builds used a heartbeat directory beside dataDir. Do not bypass an
  // older owner or guess whether a leftover legacy lock is safe to remove.
  try {
    await stat(`${dataDir}.lock`);
    throw new ApiError(
      'BUSY',
      'An older service ownership lock exists. Stop the older service first. If it crashed, confirm that it exited before removing its legacy .lock directory.',
      409,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let release: () => void;
  try {
    release = acquireProcessLock(join(dataDir, 'ownership.lock'));
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'BUSY') throw error;
    throw new ApiError(
      'BUSY',
      'Another service or diagnostic owns this data directory. Stop it before retrying.',
      409,
    );
  }
  return { dataDir, release: async () => release() };
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
