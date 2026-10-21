import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { openConfiguration } from '../apps/server/src/storage.js';
import {
  inside,
  acquireOwnership,
  canonical,
  validateRepositoryLocation,
  sourceRoot,
} from '../apps/server/src/runtime.js';

test('runtime containment handles dot-prefixed children and resolves aliases before locking', async () => {
  assert.equal(inside('/project/..data', '/project'), true);
  assert.equal(inside('/project-other', '/project'), false);
  assert.equal(inside('/other', '/project'), false);
  const parent = await mkdtemp(join(tmpdir(), 'factory-paths-'));
  try {
    await mkdir(join(parent, 'data'));
    await symlink(join(parent, 'data'), join(parent, 'alias'));
    assert.equal(
      await canonical(join(parent, 'alias/future')),
      await canonical(join(parent, 'data/future')),
    );
    const owner = await acquireOwnership(join(parent, 'data'));
    try {
      await assert.rejects(
        acquireOwnership(join(parent, 'alias')),
        /Another service/,
      );
    } finally {
      await owner.release();
    }
    await assert.rejects(
      acquireOwnership(join(sourceRoot, '..data')),
      /outside the application/,
    );
    await assert.rejects(
      validateRepositoryLocation(parent, join(parent, 'data')),
      /must be separate/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test(
  'a live stalled owner cannot be replaced after the former heartbeat expiry',
  { timeout: 25000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-stalled-owner-'));
    const child = fork(resolve('scripts/ownership-worker.ts'), [directory], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    try {
      assert.equal((await once(child, 'message'))[0].phase, 'ready');
      const stalled = once(child, 'message');
      child.send('stall');
      assert.equal((await stalled)[0].phase, 'stalled');
      const saved = once(child, 'message');
      await delay(12500);
      await assert.rejects(acquireOwnership(directory), /Another service/);
      assert.equal((await saved)[0].phase, 'saved');
      const exited = once(child, 'exit');
      child.send('close');
      await exited;
      const owner = await acquireOwnership(directory);
      try {
        const configuration = await openConfiguration(owner.dataDir);
        try {
          assert.equal(
            (await configuration.read()).settings.repository.github,
            'original-owner/after-stall',
          );
        } finally {
          await configuration.close();
        }
      } finally {
        await owner.release();
      }
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('legacy heartbeat locks are never silently bypassed during an upgrade', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'factory-legacy-owner-'));
  try {
    const directory = join(parent, 'data');
    await mkdir(directory);
    await mkdir(`${directory}.lock`);
    await assert.rejects(
      acquireOwnership(directory),
      /older service ownership lock/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
