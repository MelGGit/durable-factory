import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowRun } from '../packages/shared/src/index.js';
import type { Workspaces } from '../apps/server/src/workspace.js';
import {
  Navigator,
  applyEdits,
  deleteInside,
  editInside,
  moveInside,
  writeInside,
} from '../apps/server/src/navigation.js';

async function repository() {
  const dir = await mkdtemp(join(tmpdir(), 'factory-nav-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'F',
        GIT_AUTHOR_EMAIL: 'f@example.com',
        GIT_COMMITTER_NAME: 'F',
        GIT_COMMITTER_EMAIL: 'f@example.com',
      },
    }).trim();
  git('init', '-q', '-b', 'main');
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, '.gitignore'), 'ignored.log\nbuild/\n');
  await writeFile(
    join(dir, 'src/a.ts'),
    'export const alpha = 1;\nexport const beta = 2;\n',
  );
  await writeFile(join(dir, 'src/b.test.ts'), "test('alpha');\n");
  await writeFile(join(dir, 'README.md'), 'Read me about alpha.\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(
    join(dir, 'src/a.ts'),
    'export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n',
  );
  await writeFile(join(dir, 'src/c.ts'), 'export const delta = 4;\n');
  git('rm', '-q', 'README.md');
  git('add', '.');
  git('commit', '-qm', 'candidate');
  const source = git('rev-parse', 'HEAD^{tree}');
  // The worktree then drifts from the validated candidate.
  await writeFile(join(dir, 'src/a.ts'), 'worktree-only alpha\n');
  await writeFile(join(dir, 'src/new.ts'), 'export const alpha = 5;\n');
  await writeFile(join(dir, 'ignored.log'), 'alpha in an ignored file\n');
  await mkdir(join(dir, 'build'));
  await writeFile(join(dir, 'build/out.js'), 'alpha\n');
  const nav = new Navigator({ path: () => dir } as unknown as Workspaces);
  const run = (stage: 'developer' | 'reviewer') =>
    ({ id: 'run', stage, base, source }) as unknown as WorkflowRun;
  return {
    dir,
    base,
    source,
    git,
    developer: run('developer'),
    reviewer: run('reviewer'),
    nav,
    /** A line-mode read, which returns text. */
    read: (run: WorkflowRun, args: Parameters<Navigator['read']>[1]) =>
      nav.read(run, args) as Promise<string>,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test('search reads the worktree for the developer and the candidate tree for the reviewer', async () => {
  const r = await repository();
  try {
    const dev = await r.nav.search(r.developer, { pattern: 'alpha' });
    assert.match(dev, /src\/a\.ts:1:worktree-only alpha/);
    assert.match(dev, /src\/new\.ts:1:export const alpha = 5;/);
    assert.doesNotMatch(dev, /ignored\.log|build\//);
    assert.doesNotMatch(dev, /README/);
    const rev = await r.nav.search(r.reviewer, { pattern: 'alpha' });
    assert.match(rev, /^src\/a\.ts:1:export const alpha = 1;/m);
    assert.doesNotMatch(rev, /worktree-only|new\.ts/);
    assert.doesNotMatch(rev, new RegExp(r.source));
    assert.match(rev, /src\/b\.test\.ts:1:test\('alpha'\);/);
  } finally {
    await r.close();
  }
});

test('search handles no match, literals, globs, context and result caps', async () => {
  const r = await repository();
  try {
    assert.match(
      await r.nav.search(r.reviewer, { pattern: 'nothing-like-this' }),
      /^No matches for "nothing-like-this"/,
    );
    assert.match(
      await r.nav.search(r.reviewer, { pattern: 'a.b(', literal: true }),
      /^No matches/,
    );
    await assert.rejects(
      r.nav.search(r.reviewer, { pattern: 'a(' }),
      /Invalid pattern.*literal/,
    );
    const globbed = await r.nav.search(r.reviewer, {
      pattern: 'const',
      path: 'src/*.test.ts',
    });
    assert.match(globbed, /^No matches/);
    const context = await r.nav.search(r.reviewer, {
      pattern: 'gamma',
      context: 1,
    });
    assert.match(context, /src\/a\.ts-2-export const beta = 2;/);
    assert.match(context, /src\/a\.ts:3:export const gamma = 3;/);
    const capped = await r.nav.search(r.reviewer, {
      pattern: 'const',
      maxResults: 2,
    });
    assert.match(capped, /2 match\(es\); 2 more match\(es\), narrow with path/);
    await assert.rejects(
      r.nav.search(r.reviewer, { pattern: 'x', path: '../outside' }),
      /relative to the repository root/,
    );
    await assert.rejects(
      r.nav.search(r.reviewer, { pattern: 'x', path: '/etc/*' }),
      /relative to the repository root/,
    );
  } finally {
    await r.close();
  }
});

test('find matches globs, honours gitignore for the developer and caps the list', async () => {
  const r = await repository();
  try {
    const dev = await r.nav.find(r.developer);
    assert.deepEqual(dev.files, [
      '.gitignore',
      'src/a.ts',
      'src/b.test.ts',
      'src/c.ts',
      'src/new.ts',
    ]);
    assert.equal(dev.truncated, false);
    assert.deepEqual((await r.nav.find(r.reviewer)).files, [
      '.gitignore',
      'src/a.ts',
      'src/b.test.ts',
      'src/c.ts',
    ]);
    assert.deepEqual((await r.nav.find(r.reviewer, '*.test.ts')).files, [
      'src/b.test.ts',
    ]);
    assert.deepEqual((await r.nav.find(r.reviewer, 'src/**/c.*')).files, [
      'src/c.ts',
    ]);
    const capped = await r.nav.find(r.reviewer, '**', 2);
    assert.equal(capped.files.length, 2);
    assert.equal(capped.truncated, true);
    assert.match(capped.hint!, /2 more file\(s\); narrow the glob/);
    await assert.rejects(r.nav.find(r.reviewer, '../*'), /relative/);
    await assert.rejects(r.nav.find(r.reviewer, '/etc/*'), /relative/);
  } finally {
    await r.close();
  }
});

test('read supports line ranges, base revisions and rejects escapes', async () => {
  const r = await repository();
  try {
    assert.equal(
      await r.read(r.reviewer, {
        path: 'src/a.ts',
        startLine: 2,
        endLine: 2,
      }),
      '2\texport const beta = 2;\n[src/a.ts lines 2-2; continue with startLine=3]',
    );
    assert.match(
      await r.read(r.reviewer, { path: 'src/a.ts', startLine: 3 }),
      /3\texport const gamma = 3;\n\[src\/a\.ts lines 3-3 \(end of file\)\]/,
    );
    // The reviewer sees the candidate even though the worktree differs.
    assert.doesNotMatch(
      await r.read(r.reviewer, { path: 'src/a.ts', startLine: 1 }),
      /worktree-only/,
    );
    assert.match(
      await r.read(r.developer, { path: 'src/a.ts', startLine: 1 }),
      /1\tworktree-only alpha/,
    );
    const base = await r.read(r.reviewer, {
      path: 'src/a.ts',
      revision: 'base',
      startLine: 1,
    });
    assert.doesNotMatch(base, /gamma/);
    assert.match(base, /at base lines 1-2 \(end of file\)/);
    assert.match(
      JSON.stringify(
        await r.nav.read(r.reviewer, { path: 'README.md', revision: 'base' }),
      ),
      /Read me about alpha/,
    );
    await assert.rejects(
      r.read(r.reviewer, { path: 'src/c.ts', revision: 'base' }),
      /does not exist at the base revision/,
    );
    const characters = (await r.nav.read(r.reviewer, {
      path: 'src/a.ts',
      limit: 10,
    })) as { text: string; truncated: boolean; nextOffset: number };
    assert.deepEqual(
      [characters.text, characters.truncated, characters.nextOffset],
      ['export con', true, 10],
    );
    assert.match(
      await r.read(r.developer, { path: 'src/a.ts', startLine: 50 }),
      /has 1 line\(s\); startLine 50 is past the end/,
    );
    for (const path of ['/etc/passwd', '../x', 'src/../../x', '.git/config'])
      await assert.rejects(
        r.read(r.developer, { path }),
        /relative path inside the repository/,
      );
    await symlink('/etc', join(r.dir, 'link'));
    await assert.rejects(
      r.read(r.developer, { path: 'link/passwd' }),
      /Symlink/,
    );
    await assert.rejects(r.read(r.developer, { path: 'src' }), /directory/);
    await assert.rejects(
      r.read(r.developer, { path: 'missing.ts' }),
      /does not exist in the worktree/,
    );
  } finally {
    await r.close();
  }
});

test('diff returns the stat and pages of the patch', async () => {
  const r = await repository();
  try {
    const both = await r.nav.diff(r.reviewer, r.source, {});
    assert.match(both, /=== stat ===[\s\S]*README\.md/);
    assert.match(both, /=== patch \(characters 0-\d+ of \d+\) ===/);
    assert.match(both, /\+export const gamma = 3;/);
    const stat = await r.nav.diff(r.reviewer, r.source, { mode: 'stat' });
    assert.doesNotMatch(stat, /=== patch/);
    const first = await r.nav.diff(r.reviewer, r.source, {
      mode: 'patch',
      limit: 200,
    });
    assert.match(first, /continue with offset=200/);
    const second = await r.nav.diff(r.reviewer, r.source, {
      mode: 'patch',
      limit: 200,
      offset: 200,
    });
    assert.match(second, /characters 200-/);
    const filtered = await r.nav.diff(r.reviewer, r.source, {
      paths: ['src/c.ts'],
    });
    assert.match(filtered, /src\/c\.ts/);
    assert.doesNotMatch(filtered, /README|a\.ts/);
    await assert.rejects(
      r.nav.diff(r.reviewer, r.source, { paths: ['/etc/passwd'] }),
      /relative path/,
    );
  } finally {
    await r.close();
  }
});

test('edits apply together, report context and reject ambiguity and overlap', () => {
  const original = 'one\ntwo\nthree\ntwo\nfour\n';
  const result = applyEdits('f.txt', original, [
    { before: 'one', after: '1' },
    { before: 'four', after: '4' },
  ]);
  assert.equal(result.text, '1\ntwo\nthree\ntwo\n4\n');
  assert.equal(result.replaced, 2);
  assert.match(result.context, /^1\t1\n2\ttwo/);
  assert.throws(
    () => applyEdits('f.txt', original, [{ before: 'two', after: '2' }]),
    /matches 2 times.*replaceAll/,
  );
  assert.equal(
    applyEdits('f.txt', original, [
      { before: 'two', after: '2', replaceAll: true },
    ]).text,
    'one\n2\nthree\n2\nfour\n',
  );
  assert.throws(
    () => applyEdits('f.txt', original, [{ before: 'zzz', after: '' }]),
    /text not found.*worktree_read/,
  );
  assert.throws(
    () =>
      applyEdits('f.txt', original, [
        { before: 'one\ntwo', after: 'x' },
        { before: 'two\nthree', after: 'y' },
      ]),
    /Edits 1 and 2 overlap/,
  );
  // Each edit matches the original, so an earlier edit cannot create a match.
  assert.throws(
    () =>
      applyEdits('f.txt', 'a\n', [
        { before: 'a', after: 'b' },
        { before: 'b', after: 'c' },
      ]),
    /Edit 2 of 2: text not found/,
  );
});

test('mutating helpers stay inside the worktree', async () => {
  const r = await repository();
  try {
    await writeInside(r.dir, 'deep/new/file.txt', 'x');
    assert.equal(await readFile(join(r.dir, 'deep/new/file.txt'), 'utf8'), 'x');
    await editInside(r.dir, 'deep/new/file.txt', [{ before: 'x', after: 'y' }]);
    await moveInside(r.dir, 'deep/new/file.txt', 'moved/file.txt');
    assert.equal(existsSync(join(r.dir, 'deep/new/file.txt')), false);
    await assert.rejects(
      moveInside(r.dir, 'moved/file.txt', 'src/a.ts'),
      /already exists/,
    );
    await assert.rejects(deleteInside(r.dir, 'moved'), /recursive/);
    assert.equal(await deleteInside(r.dir, 'moved', true), 'directory');
    assert.equal(await deleteInside(r.dir, 'src/new.ts'), 'file');
    for (const path of ['/etc/passwd', '../x', '.', '', '.git', '.git/config'])
      await assert.rejects(deleteInside(r.dir, path, true), /relative path/);
    await assert.rejects(writeInside(r.dir, '../escape', 'x'), /relative path/);
    await assert.rejects(
      moveInside(r.dir, 'src/a.ts', '/tmp/x'),
      /relative path/,
    );
    await symlink('/etc', join(r.dir, 'link'));
    await assert.rejects(writeInside(r.dir, 'link/x', 'x'), /Symlink/);
    await assert.rejects(deleteInside(r.dir, 'link'), /Symlink/);
    assert.equal(existsSync(join(r.dir, 'src/a.ts')), true);
  } finally {
    await r.close();
  }
});
