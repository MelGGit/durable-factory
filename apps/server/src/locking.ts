import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from '../../../packages/shared/src/index.js';

// A separate, empty SQLite file is only a mutex: it stores no application state.
// BEGIN EXCLUSIVE holds an OS file lock until close/process death, including while
// the event loop is stalled or the process is suspended. Never unlink this file:
// replacing its inode would allow a second owner to lock a different file.
export function acquireProcessLock(path: string): () => void {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
  } catch (error) {
    database.close();
    if ((error as { errcode?: number }).errcode === 5) {
      throw new ApiError(
        'BUSY',
        'Another process owns this lock. Stop it before retrying.',
        409,
      );
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    database.close();
    released = true;
  };
}

export async function withProcessLock<T>(
  path: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + 10000;
  let release: (() => void) | undefined;
  while (!release) {
    signal?.throwIfAborted();
    try {
      release = acquireProcessLock(path);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.code !== 'BUSY' ||
        Date.now() >= deadline
      )
        throw error;
      await delay(25, undefined, { signal });
    }
  }
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    release();
  }
}
