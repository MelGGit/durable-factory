import { orcaEnvironment, type OrcaExec } from './orca.js';
import type { RunSummary } from './summary.js';

export interface TerminalRequest {
  /** The folder the terminal starts in. */
  cwd: string;
  /** The repository the folder belongs to, for tools that must know it. */
  repository: string;
  command: string;
  title: string;
}

/**
 * What the terminal the CLI runs in can do beyond printing. Every method is
 * optional: the CLI works the same in any terminal, and an environment only
 * adds shortcuts. Failures here must never stop a command.
 */
export interface Environment {
  name: string;
  /** Opens another terminal in `cwd` running `command`. */
  openTerminal?(
    request: TerminalRequest,
  ): Promise<{ cwd: string; terminal: string }>;
  /** Shows a run's state on its worktree. Returns false if there is nowhere to show it. */
  setStatus?(run: RunSummary, unread: boolean): Promise<boolean>;
  /** Names the terminal the CLI is running in. */
  nameTerminal?(title: string): Promise<void>;
}

/** A plain terminal: no extras. */
export const NONE: Environment = { name: 'none' };

export const ENVIRONMENTS = ['orca', 'none'];

type Variables = Record<string, string | undefined>;

/**
 * Picks the environment from `--env`, then FACTORY_ENV, then the variables the
 * terminal sets. Orca sets TERM_PROGRAM and ORCA_TERMINAL_HANDLE in its own.
 */
export function detectEnvironment(
  vars: Variables,
  exec: OrcaExec,
  choice?: string,
): Environment {
  const wanted = (choice ?? vars.FACTORY_ENV)?.trim().toLowerCase();
  if (wanted === 'orca') return orcaEnvironment(exec, vars);
  if (wanted === 'none') return NONE;
  if (wanted)
    throw new Error(
      `Unknown environment "${wanted}". Use one of: ${ENVIRONMENTS.join(', ')}.`,
    );
  return vars.TERM_PROGRAM === 'Orca' || vars.ORCA_TERMINAL_HANDLE
    ? orcaEnvironment(exec, vars)
    : NONE;
}
