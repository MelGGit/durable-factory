import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDiagnostic } from '../apps/server/src/diagnostics.js';
import { ApiError } from '../packages/shared/src/index.js';

test('real checks require an explicit model and stored credentials without ambient fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-diagnostic-'));
  const previous = process.env.DURABLE_FACTORY_DATA_DIR;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.DURABLE_FACTORY_DATA_DIR = directory;
  process.env.OPENAI_API_KEY = 'ambient-fixture-never-used';
  try {
    await assert.rejects(
      runDiagnostic(['check', 'openai']),
      (error) => error instanceof ApiError && error.code === 'INVALID_INPUT',
    );
    for (const provider of ['requesty', 'openai', 'anthropic']) {
      await assert.rejects(
        runDiagnostic(['check', provider, 'explicit-model']),
        (error) => error instanceof ApiError && error.code === 'AUTHENTICATION',
      );
    }
    const result = await readFile(
      join(directory, 'provider-checks.json'),
      'utf8',
    );
    assert.ok(!result.includes('ambient-fixture'));
    const records = JSON.parse(result);
    for (const provider of ['requesty', 'openai', 'anthropic'])
      assert.equal(records[`${provider}:check`].status, 'blocked');
  } finally {
    if (previous === undefined) delete process.env.DURABLE_FACTORY_DATA_DIR;
    else process.env.DURABLE_FACTORY_DATA_DIR = previous;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});
