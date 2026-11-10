import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import picomatch from 'picomatch';
import {
  relativeFile,
  type WorkflowRun,
} from '../../../packages/shared/src/index.js';
import { Workspaces, git, gitEnvironment, safePath } from './workspace.js';
import { OUTPUT_BYTES, numbered } from './agent-output.js';

/** Files `worktree_find` and `worktree_list` return at most. */
export const FIND_LIMIT = 1000;
const SEARCH_DEFAULT = 100;
const SEARCH_CAP = 300;
/** Raw git grep lines examined, so match totals stay cheap. */
const SEARCH_SCAN = 20000;
const READ_LINES = 500;
const DIFF_PAGE = 32 * 1024;
const GIT_TIMEOUT = 15000;
const gitPrefix = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

/** A path or glob from the model, relative to the repository root. */
export function relativeGlob(pattern: string) {
  if (
    !pattern ||
    pattern.startsWith('/') ||
    pattern.startsWith(':') ||
    pattern.includes('\\') ||
    /[\0\r\n]/.test(pattern) ||
    pattern.split('/').some((part) => part === '..')
  )
    throw new Error(
      `Use a glob relative to the repository root, such as src/**/*.ts; got ${JSON.stringify(pattern)}.`,
    );
  return pattern;
}
/** A path the model names must be a plain relative file path. */
function plainPath(path: string) {
  if (!relativeFile(path))
    throw new Error(
      `Use a relative path inside the repository without "." or ".." segments; got ${JSON.stringify(path)}.`,
    );
  return path;
}
/** Spawn git and hand its stdout to `use`; resolves with the exit code and a stderr excerpt. */
function gitStream<T>(
  root: string,
  args: string[],
  use: (stdout: Readable, kill: () => void) => Promise<T>,
) {
  return new Promise<{ value: T; code: number | null; error: string }>(
    (resolve, reject) => {
      const child = spawn('git', [...gitPrefix, '-C', root, ...args], {
        env: gitEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let error = '',
        expired = false,
        settled = false;
      const timer = setTimeout(() => {
        expired = true;
        child.kill('SIGKILL');
      }, GIT_TIMEOUT);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (error.length < 500) error += chunk;
      });
      child.stdout.setEncoding('utf8');
      const used = use(child.stdout, () => child.kill('SIGKILL'));
      // Whatever the reader did not consume is not wanted; stopping git is not a failure.
      used
        .finally(() => {
          settled = true;
          child.stdout.destroy();
          child.kill('SIGKILL');
        })
        .catch(() => {});
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (expired)
          return reject(new Error('git timed out; narrow the request.'));
        used.then(
          (value) =>
            resolve({
              value,
              code: code === null && settled ? 0 : code,
              error: error.trim(),
            }),
          reject,
        );
      });
    },
  );
}
/** Text between two character offsets of a stream, plus its full length. */
async function streamPage(stdout: Readable, offset: number, limit: number) {
  let position = 0,
    page = '';
  for await (const chunk of stdout as AsyncIterable<string>) {
    if (position < offset + limit && position + chunk.length > offset)
      page += chunk.slice(
        Math.max(0, offset - position),
        offset + limit - position,
      );
    position += chunk.length;
  }
  return { page, total: position };
}
/** Lines `startLine..endLine` of a stream, and whether another line follows. */
async function streamLines(
  stdout: Readable,
  startLine: number,
  endLine: number,
) {
  const reader = createInterface({ input: stdout, crlfDelay: Infinity });
  const lines: { number: number; text: string }[] = [];
  let number = 0,
    more = false;
  for await (const text of reader) {
    number++;
    if (text.includes('\0'))
      throw new Error('Binary file; it cannot be shown.');
    if (number > endLine) {
      more = true;
      break;
    }
    if (number >= startLine) lines.push({ number, text });
  }
  reader.close();
  return { lines, more, reached: number };
}

export type Revision = 'candidate' | 'base';
/** Read-only repository navigation. Reviewers see the validated tree, developers the worktree. */
export class Navigator {
  constructor(private workspaces: Workspaces) {}
  private root(run: WorkflowRun) {
    return this.workspaces.path(run);
  }
  private reviewer(run: WorkflowRun) {
    return run.stage === 'reviewer';
  }
  async search(
    run: WorkflowRun,
    args: {
      pattern: string;
      literal?: boolean;
      ignoreCase?: boolean;
      path?: string;
      context?: number;
      maxResults?: number;
    },
  ) {
    const max = Math.min(args.maxResults ?? SEARCH_DEFAULT, SEARCH_CAP),
      reviewer = this.reviewer(run);
    if (args.pattern.length > 500)
      throw new Error('Pattern is longer than 500 characters.');
    const base = [
      'grep',
      '-n',
      '-I',
      '--no-color',
      ...(reviewer ? [] : ['--untracked', '--exclude-standard']),
      args.literal ? '-F' : '-E',
      ...(args.ignoreCase ? ['-i'] : []),
    ];
    const target = [
      '-e',
      args.pattern,
      ...(reviewer ? [run.source] : []),
      '--',
      ...(args.path ? [`:(glob)${relativeGlob(args.path)}`] : []),
    ];
    const prefix = reviewer ? `${run.source}:` : '';
    const strip = (value: string) =>
      value.startsWith(prefix) ? value.slice(prefix.length) : value;
    // With --null the file, line and text are exactly separated, so matches are exact.
    const first = await gitStream(
      this.root(run),
      [...base, '--null', ...target],
      async (stdout, kill) => {
        const reader = createInterface({ input: stdout, crlfDelay: Infinity });
        const found: { file: string; line: string; text: string }[] = [];
        let matches = 0,
          scanned = 0;
        for await (const raw of reader) {
          if (++scanned > SEARCH_SCAN) {
            kill();
            break;
          }
          const parts = /^([^\0]*)\0(\d+)\0(.*)$/s.exec(raw);
          if (!parts) continue;
          matches++;
          if (matches <= max)
            found.push({
              file: strip(parts[1]),
              line: parts[2],
              text: parts[3],
            });
        }
        return { found, matches, scanned };
      },
    );
    const { found, matches, scanned } = first.value;
    if (first.code !== 0 && first.code !== 1)
      throw new Error(
        /parenthes|bracket|brace|unbalanced|invalid|unmatched|repetition|trailing|-e option/i.test(
          first.error,
        )
          ? `Invalid pattern: ${first.error}. Escape special characters, or set literal to search for the text as written.`
          : `Search failed: ${first.error || `git exited with ${first.code}`}.`,
      );
    if (!found.length)
      return `No matches for ${JSON.stringify(args.pattern)}${args.path ? ` in ${args.path}` : ''}.`;
    let lines = found.map((m) => `${m.file}:${m.line}:${m.text}`);
    const context = Math.min(args.context ?? 0, 5);
    const capped = [
      ...((args.context ?? 0) > 5 ? ['context capped at 5'] : []),
      ...((args.maxResults ?? 0) > SEARCH_CAP
        ? [`maxResults capped at ${SEARCH_CAP}`]
        : []),
    ];
    if (context) {
      // Re-run with context lines; the exact matches above tell them apart.
      const known = new Set(found.map((m) => `${m.file}:${m.line}`));
      const isMatch = (line: string) => {
        for (let i = line.indexOf(':'); i >= 0; i = line.indexOf(':', i + 1)) {
          const number = /^(\d+):/.exec(line.slice(i + 1));
          if (number && known.has(`${line.slice(0, i)}:${number[1]}`))
            return true;
        }
        return false;
      };
      const second = await gitStream(
        this.root(run),
        [...base, `-C${context}`, ...target],
        async (stdout, kill) => {
          const reader = createInterface({
            input: stdout,
            crlfDelay: Infinity,
          });
          const out: string[] = [];
          let seen = 0,
            budget = 0;
          for await (const raw of reader) {
            const line = strip(raw);
            if (isMatch(line)) {
              if (++seen > found.length) {
                kill();
                break;
              }
              budget = context;
            } else if (seen >= found.length && line !== '--' && budget-- <= 0) {
              kill();
              break;
            }
            out.push(line);
          }
          return out;
        },
      );
      lines = second.value;
    }
    const page = numberedLines(lines);
    const more = matches - max;
    return `${page.text}\n[${Math.min(matches, max)} match(es)${
      more > 0
        ? `; ${scanned > SEARCH_SCAN ? 'many' : more} more match(es), narrow with path or a more specific pattern`
        : ''
    }${capped.map((note) => `; ${note}`).join('')}${page.cut ? `; output cut at ${OUTPUT_BYTES} bytes, lower maxResults or context` : ''}]`;
  }
  /** Repository files matching a glob, from the worktree (developer) or the validated tree (reviewer). */
  async find(run: WorkflowRun, glob = '**', limit = FIND_LIMIT) {
    const root = this.root(run);
    const listed = this.reviewer(run)
      ? await git(root, ['ls-tree', '-r', '--name-only', '-z', run.source])
      : await git(root, [
          'ls-files',
          '--cached',
          '--others',
          '--exclude-standard',
          '-z',
        ]);
    const deleted = this.reviewer(run)
      ? new Set<string>()
      : new Set(
          (await git(root, ['ls-files', '--deleted', '-z']))
            .split('\0')
            .filter(Boolean),
        );
    const matches = picomatch(relativeGlob(glob), {
      dot: true,
      matchBase: !glob.includes('/'),
    });
    const files = [
      ...new Set(listed.split('\0').filter((f) => f && !deleted.has(f))),
    ]
      .filter((f) => matches(f))
      .sort();
    return {
      files: files.slice(0, limit),
      total: files.length,
      truncated: files.length > limit,
      ...(files.length > limit
        ? {
            hint: `${files.length - limit} more file(s); narrow the glob, for example src/**/*.ts.`,
          }
        : {}),
    };
  }
  private source(run: WorkflowRun, revision: Revision, path: string) {
    return revision === 'base'
      ? `${run.base}:${path}`
      : `${run.source}:${path}`;
  }
  /**
   * A file by lines or by character offset. Candidate reads the worktree for the
   * developer and the validated tree for the reviewer; base reads the captured base.
   */
  async read(
    run: WorkflowRun,
    args: {
      path: string;
      startLine?: number;
      endLine?: number;
      offset?: number;
      limit?: number;
      revision?: Revision;
    },
  ) {
    const revision = args.revision ?? 'candidate',
      viaGit = revision === 'base' || this.reviewer(run);
    const path = plainPath(args.path);
    if (args.startLine === undefined && args.endLine === undefined)
      return this.readCharacters(run, path, revision, args.offset, args.limit);
    const startLine = args.startLine ?? 1,
      cap = startLine + READ_LINES - 1,
      endLine = Math.min(args.endLine ?? cap, cap);
    if (endLine < startLine)
      throw new Error('endLine must not be before startLine.');
    const result = viaGit
      ? await this.gitFile(run, revision, path, (stdout) =>
          streamLines(stdout, startLine, endLine),
        )
      : await this.worktreeFile(run, path, (stdout) =>
          streamLines(stdout, startLine, endLine),
        );
    if (!result.lines.length)
      return `${path} has ${result.reached} line(s); startLine ${startLine} is past the end.`;
    const page = numbered(result.lines);
    const last = result.lines[page.shown - 1].number;
    const more = result.more || page.shown < result.lines.length;
    return `${page.text}\n[${path}${revision === 'base' ? ' at base' : ''} lines ${startLine}-${last}${more ? `; continue with startLine=${last + 1}` : ' (end of file)'}${args.endLine !== undefined && args.endLine > endLine ? `; at most ${READ_LINES} lines per call` : ''}]`;
  }
  private async readCharacters(
    run: WorkflowRun,
    path: string,
    revision: Revision,
    offset = 0,
    requested = OUTPUT_BYTES,
  ) {
    const limit = Math.min(requested, OUTPUT_BYTES);
    if (this.reviewer(run) || revision === 'base') {
      const { page, total } = await this.gitFile(
        run,
        revision,
        path,
        (stdout) => streamPage(stdout, offset, limit + 1),
      );
      return {
        text: page.slice(0, limit),
        truncated: page.length > limit,
        ...(page.length > limit ? { nextOffset: offset + limit } : {}),
        total,
      };
    }
    const value = await this.worktreeFile(run, path, (stdout) =>
      streamPage(stdout, offset, limit + 1),
    );
    return {
      text: value.page.slice(0, limit),
      truncated: value.page.length > limit,
      ...(value.page.length > limit ? { nextOffset: offset + limit } : {}),
      total: value.total,
    };
  }
  private async gitFile<T>(
    run: WorkflowRun,
    revision: Revision,
    path: string,
    use: (stdout: Readable) => Promise<T>,
  ) {
    const { value, code } = await gitStream(
      this.root(run),
      ['cat-file', 'blob', this.source(run, revision, path)],
      (stdout, kill) =>
        use(stdout).catch((error) => {
          kill();
          throw error;
        }),
    );
    if (code !== 0)
      throw new Error(
        revision === 'base'
          ? `${path} does not exist at the base revision; it is a new file, or the path is wrong. Use worktree_find to check.`
          : `${path} is not a file in the candidate; use worktree_find to locate files.`,
      );
    return value;
  }
  private async worktreeFile<T>(
    run: WorkflowRun,
    path: string,
    use: (stdout: Readable) => Promise<T>,
  ) {
    const full = await safePath(this.root(run), path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          `${path} does not exist in the worktree; use worktree_find to locate files.`,
        );
      throw error;
    });
    if (!(await lstat(full)).isFile())
      throw new Error(
        `${path} is a directory or special file; use worktree_find with ${path}/** to list it.`,
      );
    const input = createReadStream(full, { encoding: 'utf8' });
    try {
      return await use(input);
    } finally {
      input.destroy();
    }
  }
  /** The candidate diff against the base: a stat, a page of the patch, or both. */
  async diff(
    run: WorkflowRun,
    source: string,
    args: {
      mode?: 'stat' | 'patch';
      paths?: string[];
      offset?: number;
      limit?: number;
    },
  ) {
    const filter = (args.paths ?? []).map((p) => `:(literal)${plainPath(p)}`);
    const base = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      run.base,
      source,
      '--',
      ...filter,
    ];
    const sections: string[] = [];
    if (args.mode !== 'patch') {
      const stat = await git(this.root(run), [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--stat=140,100',
        '--stat-count=300',
        run.base,
        source,
        '--',
        ...filter,
      ]);
      sections.push(`=== stat ===\n${stat.trimEnd() || '(no changes)'}`);
    }
    if (args.mode !== 'stat') {
      const offset = args.offset ?? 0,
        limit = Math.min(args.limit ?? DIFF_PAGE, OUTPUT_BYTES);
      const { value } = await gitStream(this.root(run), base, (stdout) =>
        streamPage(stdout, offset, limit),
      );
      const end = offset + value.page.length;
      sections.push(
        `=== patch (characters ${offset}-${end} of ${value.total}${end < value.total ? `; continue with offset=${end}, or restrict with paths` : ''}) ===\n${value.page}`,
      );
    }
    return sections.join('\n\n');
  }
}
/** Search output keeps its `path:line:text` shape; only the byte budget and long lines are limited. */
function numberedLines(lines: string[]) {
  const shown: string[] = [];
  let used = 0;
  for (const line of lines) {
    const text =
      line.length > 2000 ? `${line.slice(0, 2000)}… [line truncated]` : line;
    used += Buffer.byteLength(text) + 1;
    if (used > OUTPUT_BYTES && shown.length) break;
    shown.push(text);
  }
  return { text: shown.join('\n'), cut: shown.length < lines.length };
}

/** One exact replacement; `replaceAll` replaces every occurrence. */
export interface FileEdit {
  before: string;
  after: string;
  replaceAll?: boolean;
}
const occurrences = (value: string, text: string) => {
  const found: number[] = [];
  for (let at = value.indexOf(text); at >= 0; at = value.indexOf(text, at + 1))
    found.push(at);
  return found;
};
/**
 * Apply edits that each match the original text, none overlapping. Returns the
 * new text and a few numbered lines around every change.
 */
export function applyEdits(path: string, original: string, edits: FileEdit[]) {
  const ranges: { start: number; end: number; after: string; edit: number }[] =
    [];
  for (const [index, edit] of edits.entries()) {
    const label =
      edits.length > 1 ? `Edit ${index + 1} of ${edits.length}: ` : '';
    if (!edit.before) throw new Error(`${label}before must not be empty.`);
    const at = occurrences(original, edit.before);
    if (!at.length)
      throw new Error(
        `${label}text not found in ${path}. Read the file again with worktree_read and copy the text exactly, including whitespace.`,
      );
    if (at.length > 1 && !edit.replaceAll)
      throw new Error(
        `${label}text matches ${at.length} times in ${path}. Include more surrounding lines so it matches once, or set replaceAll to replace every occurrence.`,
      );
    for (const start of edit.replaceAll ? at : [at[0]])
      ranges.push({
        start,
        end: start + edit.before.length,
        after: edit.after,
        edit: index + 1,
      });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i].start < ranges[i - 1].end)
      throw new Error(
        `Edits ${ranges[i - 1].edit} and ${ranges[i].edit} overlap in ${path}. Merge them into one edit.`,
      );
  let result = '',
    cursor = 0,
    delta = 0;
  const shifted: { start: number; end: number }[] = [];
  for (const range of ranges) {
    result += original.slice(cursor, range.start) + range.after;
    shifted.push({
      start: range.start + delta,
      end: range.start + delta + range.after.length,
    });
    delta += range.after.length - (range.end - range.start);
    cursor = range.end;
  }
  result += original.slice(cursor);
  const lines = result.split('\n'),
    starts = [0];
  for (const line of lines) starts.push(starts.at(-1)! + line.length + 1);
  const lineOf = (offset: number) => {
    let low = 0,
      high = lines.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const windows: [number, number][] = [];
  for (const range of shifted) {
    const first = Math.max(0, lineOf(range.start) - 3),
      last = Math.min(
        lines.length - 1,
        lineOf(Math.max(range.start, range.end - 1)) + 3,
      );
    const previous = windows.at(-1);
    if (previous && first <= previous[1] + 1)
      previous[1] = Math.max(previous[1], last);
    else windows.push([first, last]);
  }
  const context = windows
    .map(
      ([first, last]) =>
        numbered(
          lines.slice(first, Math.min(last, first + 60) + 1).map((text, i) => ({
            number: first + i + 1,
            text,
          })),
          8192,
        ).text,
    )
    .join('\n...\n');
  return { text: result, replaced: ranges.length, context };
}

/** Mutations of the run worktree; callers have already passed the attempt guard. */
export async function writeInside(root: string, path: string, content: string) {
  const full = await safePath(root, plainPath(path), true);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}
export async function editInside(
  root: string,
  path: string,
  edits: FileEdit[],
) {
  const full = await safePath(root, plainPath(path));
  const result = applyEdits(path, await readFile(full, 'utf8'), edits);
  await writeFile(full, result.text);
  return result;
}
export async function deleteInside(
  root: string,
  path: string,
  recursive = false,
) {
  const full = await safePath(root, plainPath(path));
  const stats = await lstat(full).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${path} does not exist; use worktree_find to check.`);
    throw error;
  });
  if (stats.isDirectory() && !recursive)
    throw new Error(
      `${path} is a directory; set recursive to delete it with everything inside.`,
    );
  await rm(full, { recursive: true });
  return stats.isDirectory() ? 'directory' : 'file';
}
export async function moveInside(root: string, from: string, to: string) {
  const source = await safePath(root, plainPath(from)),
    target = await safePath(root, plainPath(to), true);
  await lstat(source).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${from} does not exist; use worktree_find to check.`);
    throw error;
  });
  if (
    await lstat(target).then(
      () => true,
      () => false,
    )
  )
    throw new Error(
      `${to} already exists; delete it first with worktree_delete, or choose another name.`,
    );
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}
