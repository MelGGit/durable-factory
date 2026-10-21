import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
