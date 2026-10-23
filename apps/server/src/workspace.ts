import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdir,
  mkdtemp,
  lstat,
  realpath,
  readFile,
  writeFile,
  rm,
  chmod,
  open,
  readlink,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { inside } from './runtime.js';
import { ProcessSupervisor } from './processes.js';
import type { PrivateCredentials } from './credentials.js';
import type {
  WorkflowRun,
  StageAttempt,
} from '../../../packages/shared/src/index.js';
const exec = promisify(execFile);
function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  LANG: 'C.UTF-8',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '0',
  GIT_OPTIONAL_LOCKS: '0',
});
export async function git(
  root: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) {
  const result = await exec(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      root,
      '--work-tree',
      root,
      ...args,
    ],
    {
      env: { ...gitEnvironment(), ...env },
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return result.stdout;
}
export async function safePath(root: string, path: string, writing = false) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\0') ||
    path.split('/').some((p) => p === '..' || p.toLowerCase() === '.git')
  )
    throw new Error('Use a path inside the run worktree.');
  const full = resolve(root, path);
  if (!inside(full, root)) throw new Error('Path outside worktree.');
  let current = root;
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Symlink traversal is unavailable.');
    } catch (e) {
      if (writing && (e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
  }
  return full;
}
export class Workspaces {
  constructor(
    private dataDir: string,
    private processes: ProcessSupervisor,
    private credentials: PrivateCredentials,
    private localRemote?: string,
  ) {}
  path(run: WorkflowRun) {
    return join(this.dataDir, 'worktrees', run.id);
  }
  branch(run: WorkflowRun) {
    return `durable-factory/issue-${run.issue.number}-${run.id}`;
  }
  remote(run: WorkflowRun) {
    return (
      this.localRemote ?? `https://github.com/${run.repository.github}.git`
    );
  }
  async authentication<T>(
    run: WorkflowRun,
    work: (env: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    if (this.localRemote) return work(gitEnvironment());
    const directory = await mkdtemp('/tmp/durable-factory-git-');
    await chmod(directory, 0o700);
    // A short socket path also works with macOS's sockaddr_un limit.
    const socket = join(directory, `${randomUUID().slice(0, 8)}.sock`),
      helper = socket + '.cjs';
    const server = createServer((connection) => {
      let data = '';
      connection.on('data', (chunk) => {
        data += chunk;
        if (data.length > 4096) {
          connection.destroy();
          return;
        }
        if (!data.endsWith('\n\n')) return;
        const fields = Object.fromEntries(
          data
            .trim()
            .split('\n')
            .map((line) => {
              const n = line.indexOf('=');
              return [line.slice(0, n), line.slice(n + 1)];
            }),
        );
        if (
          fields.protocol !== 'https' ||
          fields.host !== 'github.com' ||
          ![run.repository.github, run.repository.github + '.git'].includes(
            fields.path,
          )
        ) {
          connection.end();
          return;
        }
        void this.credentials
          .read('github')
          .then((token) => {
            if (token?.type === 'api_key')
              connection.end(
                `username=x-access-token\npassword=${token.key}\n\n`,
              );
            else connection.end();
          })
          .catch(() => connection.end());
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    await chmod(socket, 0o600);
    await writeFile(
      helper,
      `const net=require('node:net');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{if(process.argv[2]!=='get')return;const c=net.connect(${JSON.stringify(socket)});c.on('connect',()=>c.write(input+String.fromCharCode(10)));c.on('data',b=>process.stdout.write(b));c.on('error',()=>process.exit(1));c.setTimeout(10000,()=>c.destroy());});`,
      { mode: 0o700 },
    );
    try {
      return await work({
        ...gitEnvironment(),
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: `!${shellQuote(process.execPath)} ${shellQuote(helper)}`,
        GIT_CONFIG_KEY_2: 'credential.useHttpPath',
        GIT_CONFIG_VALUE_2: 'true',
      });
    } finally {
      server.close();
      await rm(helper, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  }
  async command(
    run: WorkflowRun,
    attempt: StageAttempt,
    key: string,
    args: string[],
    signal: AbortSignal,
    root = this.path(run),
    auth = false,
    hooks = false,
  ) {
    const execute = (env: NodeJS.ProcessEnv) =>
      this.processes.run({
        id: `${run.id}-${attempt.id}-${attempt.taskId}-${key}`,
        runId: run.id,
        attemptId: attempt.id,
        cwd: root,
        command: `git ${args.join(' ')}`,
        executable: 'git',
        args: [
          '-c',
          'core.fsmonitor=false',
          '-c',
          'http.followRedirects=false',
          '-c',
          'protocol.allow=never',
          '-c',
          `protocol.${this.localRemote ? 'file' : 'https'}.allow=always`,
          ...(!hooks ? ['-c', 'core.hooksPath=/dev/null'] : []),
          '-C',
          root,
          '--work-tree',
          root,
          ...args,
        ],
        env: {
          ...env,
          GIT_AUTHOR_NAME: run.configuration.commitIdentity.name,
          GIT_AUTHOR_EMAIL: run.configuration.commitIdentity.email,
          GIT_COMMITTER_NAME: run.configuration.commitIdentity.name,
          GIT_COMMITTER_EMAIL: run.configuration.commitIdentity.email,
        },
        timeout: run.configuration.timeouts.tool,
        cancellation: run.configuration.timeouts.cancellation,
        signal,
      });
    const result = await (auth
      ? this.authentication(run, execute)
      : execute(gitEnvironment()));
    if (result.exitCode !== 0)
      throw new Error(
        `Git operation ${key} failed; inspect its command output.`,
      );
    return this.processes.output(result);
  }
  async setup(run: WorkflowRun, attempt: StageAttempt, signal: AbortSignal) {
    const root = run.repository.path;
    const reference = `refs/durable-factory/${run.id}/base`;
    await this.command(
      run,
      attempt,
      'fetch',
      [
        'fetch',
        '--no-tags',
        this.remote(run),
        `refs/heads/${run.repository.baseBranch}:${reference}`,
      ],
      signal,
      root,
      true,
    );
    await git(root, ['rev-parse', '--verify', reference]);
    const base = run.workspace?.base ?? run.base;
    await git(root, ['cat-file', '-e', `${base}^{commit}`]);
    await this.command(
      run,
      attempt,
      'capture-base',
      ['update-ref', reference, base],
      signal,
      root,
    );
    await mkdir(join(this.dataDir, 'worktrees'), {
      recursive: true,
      mode: 0o700,
    });
    const target = this.path(run),
      branch = this.branch(run);
    const listed = await git(root, ['worktree', 'list', '--porcelain']);
    let exists = false;
    try {
      await lstat(target);
      exists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (exists) {
      if (
        !listed.includes(`worktree ${target}\n`) ||
        (await git(target, ['symbolic-ref', '--short', 'HEAD'])).trim() !==
          branch
      )
        throw new Error(
          'Workspace identity conflicts with an existing directory.',
        );
    } else
      await this.command(
        run,
        attempt,
        'worktree',
        ['worktree', 'add', '-b', branch, target, base],
        signal,
        root,
      );
    if ((await realpath(target)) !== target)
      throw new Error('Workspace path was redirected.');
    return { path: target, branch, base };
  }
  /** Fingerprint ignored files without following symlinks or running Git filters. */
  async ignoredInventory(run: WorkflowRun, signal?: AbortSignal) {
    return this.fileInventory(this.path(run), false, signal);
  }
  async fileInventory(root: string, all = true, signal?: AbortSignal) {
    const ignored = await git(root, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
    ]);
    const tracked = all
      ? await git(root, [
          'ls-files',
          '--cached',
          '--others',
          '--exclude-standard',
          '-z',
        ])
      : '';
    const paths = [
      ...new Set((ignored + tracked).split('\0').filter(Boolean)),
    ].sort();
    const digest = createHash('sha256');
    for (const path of paths) {
      signal?.throwIfAborted();
      await safePath(root, dirname(path));
      const full = resolve(root, path);
      if (!inside(full, root))
        throw new Error('Ignored file outside worktree.');
      let before;
      try {
        before = await lstat(full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        digest.update(JSON.stringify([path, 'missing']));
        continue;
      }
      const content = createHash('sha256');
      if (before.isSymbolicLink()) content.update(await readlink(full));
      else if (before.isFile()) {
        const file = await open(
          full,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          for await (const chunk of file.createReadStream({
            autoClose: false,
            signal,
          }))
            content.update(chunk);
          const opened = await file.stat();
          if (
            opened.ino !== before.ino ||
            opened.dev !== before.dev ||
            opened.size !== before.size ||
            opened.mtimeMs !== before.mtimeMs
          )
            throw new Error('Ignored files changed while being inspected.');
        } finally {
          await file.close();
        }
      } else throw new Error('Ignored file type cannot be verified.');
      const after = await lstat(full);
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.mode !== after.mode
      )
        throw new Error('Ignored files changed while being inspected.');
      digest.update(
        JSON.stringify([
          path,
          before.isSymbolicLink() ? 'link' : 'file',
          before.mode & 0o777,
          content.digest('hex'),
        ]),
      );
    }
    return { digest: digest.digest('hex'), files: paths.length };
  }
  async cleanupProofIndexes(run: WorkflowRun) {
    for (const path of run.proofIndexes ?? []) {
      const parent = join(this.dataDir, 'proofs');
      const name = path.slice(parent.length + 1);
      if (
        path !== join(parent, name) ||
        !name.startsWith(`${run.id}-`) ||
        !/^[A-Za-z0-9_-]+\.index$/.test(name)
      )
        throw new Error('Proof index ownership is uncertain.');
      for (const target of [path, path + '.lock']) {
        try {
          const stat = await lstat(target);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            (await realpath(dirname(target))) !== parent
          )
            throw new Error('Proof index ownership is uncertain.');
          await rm(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }
  async cleanupProofWorkspace(
    run: WorkflowRun,
    resource: NonNullable<WorkflowRun['proofWorkspaces']>[number],
  ) {
    const expected = join(this.dataDir, 'proofs', resource.id);
    if (
      !/^[A-Za-z0-9_-]+$/.test(resource.id) ||
      !resource.id.startsWith(`${run.id}-`) ||
      resource.root !== expected
    )
      throw new Error('Proof workspace ownership is uncertain.');
    const listed = await git(run.repository.path, [
      'worktree',
      'list',
      '--porcelain',
    ]);
    try {
      await lstat(expected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (listed.includes(`worktree ${expected}\n`))
        throw new Error(
          'Proof worktree is missing but still registered; inspect before cleanup.',
        );
      return;
    }
    if (
      resource.state === 'removed' ||
      (await realpath(expected)) !== expected ||
      !listed.includes(`worktree ${expected}\n`)
    )
      throw new Error('Proof workspace ownership is uncertain.');
    if ((await git(expected, ['rev-parse', 'HEAD'])).trim() !== resource.commit)
      throw new Error('Proof workspace HEAD changed.');
    const common = async (root: string) =>
      realpath(
        (
          await git(root, [
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ])
        ).trim(),
      );
    if ((await common(expected)) !== (await common(run.repository.path)))
      throw new Error('Proof repository changed.');
    if (resource.inventory) {
      if (
        JSON.stringify(await this.fileInventory(expected)) !==
        JSON.stringify(resource.inventory)
      )
        throw new Error(
          'Proof workspace content changed; preserve unexpected files before cleanup.',
        );
    } else if (
      (await this.candidate(run, expected)) !==
        (
          await git(expected, ['rev-parse', `${resource.commit}^{tree}`])
        ).trim() ||
      (await this.fileInventory(expected, false)).files > 0
    )
      throw new Error(
        'Interrupted proof has unverified content; inspect and preserve it before cleanup.',
      );
    await git(run.repository.path, ['worktree', 'remove', '--force', expected]);
  }
  async candidate(run: WorkflowRun, root = this.path(run)) {
    const index = join(
      this.dataDir,
      'worktrees',
      `.${run.id}-${randomUUID()}.index`,
    );
    const env = { GIT_INDEX_FILE: index };
    try {
      const filters = (
        await git(root, [
          'config',
          '--name-only',
          '--get-regexp',
          '^filter\\..*\\.(clean|smudge|process|required)$',
        ]).catch(() => '')
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      const options = filters.flatMap((key) => [
        '-c',
        `${key}=${key.endsWith('.required') ? 'false' : ''}`,
      ]);
      await git(root, ['read-tree', 'HEAD'], env);
      await git(root, [...options, 'add', '-A', '--', '.'], env);
      for (const path of run.workspace?.includedIgnored ?? []) {
        const full = await safePath(root, path, true);
        try {
          await lstat(full);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        await git(root, [...options, 'add', '-f', '--', path], env);
      }
      const entries = await git(root, ['ls-files', '--stage'], env);
      if (entries.split('\n').some((line) => line.startsWith('160000 ')))
        throw new Error(
          'Submodules require manual handling before automated publication.',
        );
      return (await git(root, ['write-tree'], env)).trim();
    } finally {
      await rm(index, { force: true });
    }
  }
  async treeRead(run: WorkflowRun, path: string, offset = 0, limit = 65536) {
    if (
      !path ||
      path.startsWith('-') ||
      path.includes('\0') ||
      path.split('/').includes('..')
    )
      throw new Error('Invalid candidate path');
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 65536
    )
      throw new Error('Invalid candidate page');
    // Stream the blob so large files remain fully accessible with bounded memory.
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'git',
        ['-C', this.path(run), 'cat-file', 'blob', `${run.source}:${path}`],
        {
          env: gitEnvironment(),
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      let position = 0,
        page = '',
        expired = false;
      const timer = setTimeout(() => {
        expired = true;
        child.kill('SIGKILL');
      }, 15000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (position < offset + limit + 1 && position + chunk.length > offset)
          page += chunk.slice(
            Math.max(0, offset - position),
            offset + limit + 1 - position,
          );
        position += chunk.length;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || expired)
          reject(new Error('Cannot read candidate file.'));
        else resolve(page);
      });
    });
    const truncated = output.length > limit;
    return {
      text: output.slice(0, limit),
      truncated,
      ...(truncated ? { nextOffset: offset + limit } : {}),
    };
  }
  async diff(run: WorkflowRun) {
    return git(this.path(run), [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      run.base,
      run.source,
      '--',
    ]);
  }
  async currentBase(run: WorkflowRun) {
    return (
      await git(run.repository.path, [
        'rev-parse',
        `refs/durable-factory/${run.id}/base`,
      ])
    ).trim();
  }
}
