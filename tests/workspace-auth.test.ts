import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspaces } from '../apps/server/src/workspace.js';
import { ProcessSupervisor } from '../apps/server/src/processes.js';
import { PrivateCredentials } from './helpers/credentials.js';
import { openConfiguration } from '../apps/server/src/storage.js';
import type { WorkflowRun } from '../packages/shared/src/index.js';
test('private Git helper returns only repository-scoped credentials without exposing the token in its environment or file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-auth-'));
  const config = await openConfiguration(directory),
    credentials = new PrivateCredentials(directory);
  await credentials.init();
  await credentials.replace('github', {
    type: 'api_key',
    key: 'private-fixture-token',
  });
  execFileSync('git', ['init', '-q', directory]);
  execFileSync('git', [
    '-C',
    directory,
    'config',
    'credential.helper',
    '!exit 99',
  ]);
  const workspace = new Workspaces(
    directory,
    new ProcessSupervisor(config.harness, directory),
    credentials,
  );
  try {
    await workspace.authentication(
      { repository: { github: 'example/project' } } as WorkflowRun,
      async (env) => {
        assert.ok(!JSON.stringify(env).includes('private-fixture-token'));
        const helper = env.GIT_CONFIG_VALUE_1!;
        const path = helper.match(/'([^']+\.cjs)'$/)![1];
        assert.ok(
          !(await readFile(path, 'utf8')).includes('private-fixture-token'),
        );
        const request = (host: string) =>
          new Promise<{ code: number | null; out: string; err: string }>(
            (resolve) => {
              const child = spawn(
                'git',
                ['-C', directory, 'credential', 'fill'],
                { env },
              );
              let out = '',
                err = '';
              child.stderr.on('data', (chunk) => (err += chunk));
              child.stdout.on('data', (chunk) => (out += chunk));
              child.stderr.resume();
              child.on('close', (code) => resolve({ code, out, err }));
              child.stdin.end(
                `protocol=https\nhost=${host}\npath=example/project.git\n\n`,
              );
            },
          );
        const allowed = await request('github.com');
        assert.equal(allowed.code, 0, allowed.err);
        assert.ok(allowed.out.includes('password=private-fixture-token'));
        const denied = await request('example.org');
        assert.notEqual(denied.code, 0);
        assert.ok(!denied.out.includes('private-fixture-token'));
      },
    );
  } finally {
    await config.close();
    await rm(directory, { recursive: true, force: true });
  }
});
