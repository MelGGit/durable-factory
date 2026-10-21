import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDiagnostic } from '../apps/server/src/diagnostics.js';
import { PrivateCredentials } from '../apps/server/src/credentials.js';
import { ApiError } from '../packages/shared/src/index.js';

test('diagnostic usage lists only status and subscription sign-in', async (t) => {
  const output: unknown[][] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => output.push(args));
  await runDiagnostic([]);
  const help = output.flat().join('\n');
  assert.match(help, /diagnose status/);
  assert.match(help, /diagnose login openai\|anthropic/);
  assert.doesNotMatch(help, /diagnose (check|interrupt|refresh)/);
});

test('removed commands and invalid sign-in arguments fail before opening storage', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'factory-diagnostic-invalid-'),
  );
  const previous = process.env.DURABLE_FACTORY_DATA_DIR;
  process.env.DURABLE_FACTORY_DATA_DIR = join(directory, 'not-created');
  try {
    for (const args of [
      ['check', 'openai', 'model'],
      ['interrupt', 'anthropic', 'model'],
      ['refresh', 'openai'],
      ['login'],
      ['login', 'unknown'],
      ['login', 'requesty'],
      ['login', 'openai', 'extra'],
      ['status', 'extra'],
    ]) {
      await assert.rejects(
        runDiagnostic(args),
        (error) => error instanceof ApiError && error.code === 'INVALID_INPUT',
      );
    }
    await assert.rejects(access(process.env.DURABLE_FACTORY_DATA_DIR), {
      code: 'ENOENT',
    });
  } finally {
    if (previous === undefined) delete process.env.DURABLE_FACTORY_DATA_DIR;
    else process.env.DURABLE_FACTORY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('status reports all provider configurations without resolving auth or exposing secrets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-diagnostic-status-'));
  const previous = process.env.DURABLE_FACTORY_DATA_DIR;
  const output: unknown[][] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => output.push(args));
  process.env.DURABLE_FACTORY_DATA_DIR = directory;
  try {
    const credentials = new PrivateCredentials(directory);
    await credentials.init();
    await credentials.replace('requesty', {
      type: 'api_key',
      key: 'private-requesty-fixture',
    });
    // An expired OAuth token still reports stored status without a network refresh.
    await credentials.replace('openai', {
      type: 'oauth',
      access: 'private-access-fixture',
      refresh: 'private-refresh-fixture',
      expires: 1,
    });
    await runDiagnostic(['status']);
    const text = output.flat().join('\n');
    assert.deepEqual(JSON.parse(text), [
      { id: 'requesty', configured: true, status: 'configured' },
      { id: 'openai', configured: true, status: 'configured' },
      { id: 'anthropic', configured: false, status: 'not_configured' },
    ]);
    assert.doesNotMatch(text, /private-|untested|accountAccess/);
  } finally {
    if (previous === undefined) delete process.env.DURABLE_FACTORY_DATA_DIR;
    else process.env.DURABLE_FACTORY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
