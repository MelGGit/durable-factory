import { realpath } from 'node:fs/promises';
import type { Environment } from './environment.js';
import { comment, type RunSummary } from './summary.js';

/** Runs the `orca` command and returns its parsed `--json` result. */
export type OrcaExec = (args: string[]) => Promise<unknown>;

interface OrcaReply {
  ok?: boolean;
  result?: any;
  error?: { code?: string; message?: string };
}

export class OrcaError extends Error {}

async function call(exec: OrcaExec, args: string[]) {
  const reply = (await exec([...args, '--json'])) as OrcaReply;
  if (!reply?.ok)
    throw new OrcaError(
      `orca ${args.slice(0, 2).join(' ')}: ${reply?.error?.message ?? reply?.error?.code ?? 'failed'}`,
    );
  return reply.result;
}

/** Orca matches worktree paths exactly, so symlinks (macOS /tmp) must be resolved. */
const resolved = (path: string) => realpath(path).catch(() => path);

/** Makes sure Orca knows the repository; worktrees under it show up on their own. */
async function ensureRepo(exec: OrcaExec, repositoryPath: string) {
  const { repos = [] } = await call(exec, ['repo', 'list']);
  const root = await resolved(repositoryPath);
  if (repos.some((repo: { path: string }) => repo.path === root)) return;
  await call(exec, ['repo', 'add', '--path', root]);
}

/** Mirrors a run's state into Orca's worktree comment, status and unread dot. */
export async function syncRun(exec: OrcaExec, run: RunSummary, unread = true) {
  if (!run.worktree) return false;
  const worktree = await resolved(run.worktree);
  const attention = Boolean(run.question) || run.status === 'pr_ready';
  try {
    await call(exec, [
      'worktree',
      'set',
      '--worktree',
      `path:${worktree}`,
      '--comment',
      comment(run),
      ...(run.status === 'pr_ready' ? ['--workspace-status', 'in-review'] : []),
      ...(unread && attention ? ['--unread'] : []),
    ]);
    return true;
  } catch (error) {
    // Orca stops listing a worktree once its run is cleaned up.
    if (error instanceof OrcaError && /selector_not_found/.test(error.message))
      return false;
    throw error;
  }
}

/**
 * Orca as an environment. Orca lists a worktree that git created outside it, so
 * opening one only needs the repository to be known.
 */
export function orcaEnvironment(
  exec: OrcaExec,
  vars: Record<string, string | undefined> = {},
): Environment {
  return {
    name: 'orca',
    async openTerminal({ cwd, repository, command, title }) {
      const worktree = await resolved(cwd);
      await ensureRepo(exec, repository);
      const terminal = await call(exec, [
        'terminal',
        'create',
        '--worktree',
        `path:${worktree}`,
        '--title',
        title,
        '--command',
        command,
      ]);
      return {
        cwd: worktree,
        terminal: terminal?.handle ?? terminal?.terminal?.handle ?? '',
      };
    },
    setStatus: (run, unread) => syncRun(exec, run, unread),
    async nameTerminal(title) {
      const handle = vars.ORCA_TERMINAL_HANDLE;
      if (!handle) return;
      await call(exec, [
        'terminal',
        'rename',
        '--terminal',
        handle,
        '--title',
        title,
      ]);
    },
  };
}
