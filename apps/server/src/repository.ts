import { spawn } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ApiError } from '../../../packages/shared/src/index.js';
import { inside } from './runtime.js';
const invalid = () =>
  new ApiError(
    'INVALID_INPUT',
    'Choose a readable, non-ignored file within the registered repository.',
    400,
  );
export async function gitRead(
  root: string,
  args: string[],
  input?: string,
): Promise<string> {
  // Git's ordinary working-tree diff can execute clean/process filters. Disable
  // every configured filter before inspecting current content.
  const overrides: string[] = [];
  if (args[0] === 'diff') {
    const keys = await gitRead(root, [
      'config',
      '--name-only',
      '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process|required)$',
    ]);
    const filters = new Set(
      keys
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((key) => key.replace(/\.(clean|smudge|process|required)$/, '')),
    );
    for (const filter of filters) {
      for (const field of ['clean', 'smudge', 'process'])
        overrides.push('-c', `${filter}.${field}=`);
      overrides.push('-c', `${filter}.required=false`);
    }
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
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
        ...overrides,
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          LANG: 'C.UTF-8',
          GIT_OPTIONAL_LOCKS: '0',
          ...(args[0] === 'diff' ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
          GIT_CONFIG_COUNT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let failure = false;
    const timer = setTimeout(() => {
      failure = true;
      child.kill('SIGKILL');
    }, 10000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        failure = true;
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(invalid());
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (
        failure ||
        (code !== 0 &&
          !(['check-ignore', 'config'].includes(args[0]) && code === 1))
      )
        reject(invalid());
      else resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export class RepositoryReader {
  constructor(private root: string) {}
  private async files() {
    const root = await realpath(this.root).catch(() => {
      throw invalid();
    });
    if (!this.root || resolve(root) !== resolve(this.root)) throw invalid();
    const files = (
      await gitRead(root, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--deduplicate',
      ])
    )
      .split('\0')
      .filter(Boolean);
    if (!files.length) return [];
    const ignored = new Set(
      (
        await gitRead(
          root,
          ['check-ignore', '--no-index', '-z', '--stdin'],
          files.join('\0') + '\0',
        )
      ).split('\0'),
    );
    return files.filter(
      (file) =>
        !ignored.has(file) &&
        !file
          .split('/')
          .some((part) => part === '.git' || part.toLowerCase() === '.git'),
    );
  }
  private async safe(path: string, allowMissing = false) {
    if (
      !path ||
      isAbsolute(path) ||
      path.includes('\0') ||
      path.split('/').includes('..')
    )
      throw invalid();
    const full = resolve(this.root, path);
    if (!inside(full, this.root)) throw invalid();
    let next = this.root;
    for (const part of relative(this.root, full).split('/')) {
      next = join(next, part);
      try {
        if ((await lstat(next)).isSymbolicLink()) throw invalid();
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')
          return full;
        throw error;
      }
    }
    if (!(await lstat(full)).isFile()) throw invalid();
    return full;
  }
  async read(path: string) {
    if (!(await this.files()).includes(path)) throw invalid();
    return this.readAllowed(path);
  }
  private async readAllowed(path: string) {
    const full = await this.safe(path);
    const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).includes(0))
        throw new ApiError(
          'INVALID_INPUT',
          'Binary files cannot be inspected.',
          400,
        );
      return {
        path,
        text: buffer.subarray(0, Math.min(bytesRead, 65536)).toString('utf8'),
        truncated: bytesRead > 65536,
      };
    } finally {
      await file.close();
    }
  }
  async list(prefix = '') {
    if (prefix.includes('..') || isAbsolute(prefix)) throw invalid();
    const files = (await this.files()).filter((file) =>
      file.startsWith(prefix),
    );
    const safe: string[] = [];
    for (const file of files.slice(0, 1000)) {
      try {
        await this.safe(file);
        safe.push(file);
      } catch {}
    }
    return { files: safe, truncated: files.length > 1000 };
  }
  async search(query: string) {
    if (!query || query.length > 200) throw invalid();
    const files = await this.list();
    const matches: { path: string; line: number; text: string }[] = [];
    let scanned = 0;
    let truncated = files.truncated;
    for (const path of files.files) {
      if (scanned >= 4 * 1024 * 1024 || matches.length >= 100)
        return { matches, truncated: true };
      try {
        const file = await this.readAllowed(path);
        scanned += Buffer.byteLength(file.text);
        truncated ||= file.truncated;
        file.text.split('\n').forEach((line, index) => {
          if (matches.length < 100 && line.includes(query))
            matches.push({ path, line: index + 1, text: line.slice(0, 1000) });
        });
      } catch {}
    }
    return { matches, truncated };
  }
  async changes() {
    // Only literal, checked paths may enter the diff.
    const files = { files: await this.files() };
    const results: { path: string; diff: string }[] = [];
    let bytes = 0;
    const safeFiles: string[] = [];
    for (const path of files.files.slice(0, 1000)) {
      try {
        await this.safe(path, true);
        safeFiles.push(path);
      } catch {}
    }
    if (!safeFiles.length)
      return { changes: [], truncated: files.files.length > 1000 };
    let hasHead = true;
    try {
      await gitRead(this.root, ['rev-parse', '--verify', 'HEAD']);
    } catch {
      hasHead = false;
    }
    const diff = hasHead
      ? await gitRead(this.root, [
          'diff',
          'HEAD',
          '--no-ext-diff',
          '--no-textconv',
          '--',
          ...safeFiles,
        ])
      : (await gitRead(this.root, [
          'diff',
          '--cached',
          '--no-ext-diff',
          '--no-textconv',
          '--',
          ...safeFiles,
        ])) +
        (await gitRead(this.root, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--',
          ...safeFiles,
        ]));
    bytes = Buffer.byteLength(diff);
    if (diff)
      results.push({
        path: '(tracked changes)',
        diff: Buffer.from(diff).subarray(0, 65536).toString('utf8'),
      });
    return {
      changes: results,
      truncated: files.files.length > 1000 || bytes > 65536,
      note: 'Diff includes tracked changes; use list/read for untracked files.',
    };
  }
}
