import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workspaces } from '../apps/server/src/workspace.js';
import type { WorkflowRun } from '../packages/shared/src/index.js';

test('selected ignored files may be deleted, and candidate files can be read beyond the command output limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-candidate-'));
  const root = join(directory, 'worktrees', 'run');
  await mkdir(root, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const workspace = new Workspaces(directory, null!, null!);
  const run = {
    id: 'run',
    workspace: { includedIgnored: ['generated.txt'] },
  } as WorkflowRun;
  try {
    git('init', '-q');
    await writeFile(join(root, '.gitignore'), 'generated.txt\n');
    const content = 'a'.repeat(17 * 1024 * 1024) + '💡TAIL';
    await writeFile(join(root, 'large.txt'), content);
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-qm',
      'Base',
    );
    const base = await workspace.candidate(run);
    await writeFile(join(root, 'generated.txt'), 'selected');
    run.source = await workspace.candidate(run);
    assert.notEqual(run.source, base);
    const first = await workspace.treeRead(run, 'large.txt');
    assert.equal(first.text.length, 65536);
    assert.equal(first.nextOffset, 65536);
    const tail = await workspace.treeRead(
      run,
      'large.txt',
      content.length - 6,
      6,
    );
    assert.equal(tail.text, '💡TAIL');
    assert.equal(tail.truncated, false);
    await assert.rejects(() => workspace.treeRead(run, 'large.txt', -1));
    await rm(join(root, 'generated.txt'));
    assert.equal(await workspace.candidate(run), base);
    // A previously committed ignored selection must be staged as a deletion too.
    await writeFile(join(root, 'generated.txt'), 'selected');
    git('add', '-f', 'generated.txt');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-qm',
      'Generated',
    );
    await rm(join(root, 'generated.txt'));
    assert.equal(await workspace.candidate(run), base);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
