import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ChatClient,
  WorkflowClient,
  withToken,
} from '../../../packages/shared/src/index.js';
import { EXIT, parse, run, type Deps } from './cli.js';
import { detectEnvironment } from './environment.js';
import { openTerminal } from './terminal.js';

// The AG-UI SDK logs the abort that ends a one-shot read of a conversation.
const logError = console.error;
console.error = (...args: unknown[]) => {
  if (String(args[0]).startsWith('Agent execution failed')) return;
  logError(...args);
};

const url = (
  process.env.DURABLE_FACTORY_URL ?? 'http://127.0.0.1:4317'
).replace(/\/+$/, '');
const token = process.env.DURABLE_FACTORY_API_TOKEN?.trim();
const project = process.env.DURABLE_FACTORY_PROJECT?.trim() || undefined;
const fetcher = token ? withToken(token) : fetch;

/** Runs `orca` and parses its JSON, which it prints even when it fails. */
const orca = (args: string[]) =>
  new Promise<unknown>((resolve, reject) =>
    execFile('orca', args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new Error(
            (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
              ? 'The orca command was not found. Install Orca and enable its CLI in Settings → General.'
              : `orca ${args[0]} gave no JSON.`,
          ),
        );
      }
    }),
  );

/** Another terminal starts in the run's worktree, so it needs absolute paths. */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const self = `node --import ${quote(import.meta.resolve('tsx'))} ${quote(fileURLToPath(import.meta.url))}`;

let env: Deps['env'];
try {
  const choice = parse(process.argv.slice(2)).flags.get('env');
  env = detectEnvironment(
    process.env,
    orca,
    typeof choice === 'string' ? choice : undefined,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exit(EXIT.usage);
}

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
// Only the interactive chat reads the keyboard.
const terminal =
  process.argv[2] === 'plan' && process.argv[3] === 'chat'
    ? openTerminal(color)
    : undefined;

process.exitCode = await run(process.argv.slice(2), {
  workflow: new WorkflowClient(url, fetcher, project),
  chat: new ChatClient(url, fetcher, project),
  env,
  url,
  command: process.env.DURABLE_FACTORY_CLI ?? self,
  input: terminal?.input,
  working: terminal?.working,
  close: terminal?.finish,
  write: terminal?.write,
  color,
  io: {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  },
});
// A finished `watch` or `wait` leaves no timers, but a stream may linger.
process.exit();
