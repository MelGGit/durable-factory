import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfiguration } from '../apps/server/src/storage.js';
import { ProcessSupervisor } from '../apps/server/src/processes.js';

test('supervised commands retain output and never repeat an operation identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-process-'));
  const config = await openConfiguration(directory);
  const processes = new ProcessSupervisor(config.harness, directory);
  try {
    const options = {
      id: 'run-attempt-command',
      runId: 'run',
      attemptId: 'attempt',
      cwd: directory,
      command: 'echo done; echo effect >> effect',
      timeout: 5,
      cancellation: 1,
    };
    const result = await processes.run(options);
    assert.equal(result.exitCode, 0);
    assert.equal(await processes.output(result), 'done\n');
    await processes.run(options);
    assert.equal(await readFile(join(directory, 'effect'), 'utf8'), 'effect\n');
    assert.equal(await processes.quiescent('run'), true);
  } finally {
    await config.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('deadline terminates a command and its background child and prevents replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-process-'));
  const config = await openConfiguration(directory);
  const processes = new ProcessSupervisor(config.harness, directory);
  try {
    const options = {
      id: 'run-attempt-timeout',
      runId: 'run',
      attemptId: 'attempt',
      cwd: directory,
      command: 'sleep 60 & wait',
      timeout: 1,
      cancellation: 2,
    };
    await assert.rejects(processes.run(options), /interrupted/);
    assert.equal(await processes.cancel('run', 1000), true);
    await assert.rejects(processes.run(options), /inspection/);
  } finally {
    await config.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a rapidly detached child remains accounted for after its parent exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-process-'));
  const config = await openConfiguration(directory);
  const processes = new ProcessSupervisor(config.harness, directory);
  try {
    await assert.rejects(
      processes.run({
        id: 'run-detached-command',
        runId: 'run',
        attemptId: 'detached',
        cwd: directory,
        command: 'unused',
        executable: process.execPath,
        args: [
          '-e',
          "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'}).unref()",
        ],
        timeout: 5,
        cancellation: 2,
      }),
      /interrupted/,
    );
    assert.equal(await processes.cancel('run', 1000), true);
  } finally {
    await config.close();
    await rm(directory, { recursive: true, force: true });
  }
});
