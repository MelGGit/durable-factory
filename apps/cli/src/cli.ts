import { randomUUID } from 'node:crypto';
import {
  ApiError,
  acceptsTypedAnswer,
  type ChatClient,
  type RunAction,
  type WorkflowClient,
  type WorkflowRun,
  type WorkflowSnapshot,
} from '../../../packages/shared/src/index.js';
import { ChatView } from './chat-view.js';
import type { Environment } from './environment.js';
import {
  planText,
  readSnapshot,
  say,
  summarizePlan,
  type PlanSummary,
} from './planning.js';
import { line, pendingQuestion, summarize } from './summary.js';

export const EXIT = { ok: 0, failed: 1, usage: 2, timeout: 124 } as const;

/** Statuses `wait` stops on unless `--for` says otherwise. */
const SETTLED = [
  'needs_input',
  'paused',
  'pr_ready',
  'cancelled',
  'termination_blocker',
];

export interface Io {
  out(text: string): void;
  err(text: string): void;
}
export interface Deps {
  workflow: WorkflowClient;
  chat: ChatClient;
  /** What the terminal can do beyond printing; see `environment.ts`. */
  env: Environment;
  /** The command another terminal runs to follow a run. */
  command: string;
  io: Io;
  /** Lines the person types, for `plan chat`. */
  input?: AsyncIterable<string>;
  /** Where the service is expected, for the message when it is not there. */
  url?: string;
  /** Writes into the conversation above the input area. */
  write?(text: string): void;
  /** Tells the screen whether the planner is working, for its status row. */
  working?(on: boolean): void;
  /** Called when `plan chat` ends, to leave the terminal tidy. */
  close?(): void;
  color?: boolean;
}

export class UsageError extends Error {}

interface Parsed {
  words: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['for', 'timeout', 'conversation', 'env']);

export function parse(argv: string[]): Parsed {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      words.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (VALUE_FLAGS.has(name)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value.`);
      flags.set(name, value);
    } else flags.set(name, true);
  }
  return { words, flags };
}

export const USAGE = `factory — drive Durable Factory runs from a terminal

  factory runs                       List runs
  factory show <run>                 One run: stage, question, worktree
  factory watch [<run>]              Follow runs live
  factory wait <run>                 Block until the run needs you (--for a,b  --timeout seconds)
  factory start <issue>              Start a run for a GitHub issue number
  factory start --conversation <id>  Start a run from an approved plan
  factory pause|resume|cancel <run>  Control a run
  factory answer <run> <text>        Answer the run's pending question
  factory send <run> <text>          Send a follow-up to the developer (--steer to redirect)
  factory open <run>                 Open a terminal in the run's worktree (--pause first)

Planning (the chat that turns an idea into a GitHub issue):
  factory plan list                  Planning conversations
  factory plan new <title>           Open one; prints its id
  factory plan send <id> <text>      Say something, wait for the planner's reply and show it
  factory plan show <id>             Reply, ticket draft, readiness review, issue link
  factory plan approve <id>          Approve creating the issue (same as replying "yes")
  factory plan chat <id>             Talk to the planner interactively

Every command takes --json. Settings come from DURABLE_FACTORY_URL (default
http://127.0.0.1:4317), DURABLE_FACTORY_API_TOKEN and DURABLE_FACTORY_PROJECT.
Exit codes: 0 ok, 1 failed, 2 usage, 124 wait timed out. A <run> may be an id or
a unique id prefix.

Environment: inside Orca the CLI opens terminals and shows run state there; in any
other terminal it prints what to run instead. Force it with --env orca|none or
FACTORY_ENV; --no-env stops watch from writing state into the environment.`;

function find(snapshot: WorkflowSnapshot, id: string | undefined) {
  if (!id) throw new UsageError('Name a run.');
  const matches = snapshot.runs.filter(
    (run) => run.id === id || run.id.startsWith(id),
  );
  const exact = matches.find((run) => run.id === id);
  if (exact) return exact;
  if (matches.length > 1)
    throw new UsageError(`"${id}" matches ${matches.length} runs.`);
  if (!matches[0]) throw new UsageError(`No run "${id}".`);
  return matches[0];
}

const lookup = async (deps: Deps, id: string | undefined) =>
  find(await deps.workflow.workflow(), id);

async function control(deps: Deps, run: WorkflowRun, action: RunAction) {
  return deps.workflow.command(run.id, {
    operationId: randomUUID(),
    expectedRevision: run.revision,
    action,
  });
}

/** Resolves when `done` holds for a snapshot, or after `seconds`. */
function until(
  deps: Deps,
  done: (snapshot: WorkflowSnapshot) => boolean,
  seconds: number | undefined,
) {
  return new Promise<'done' | 'timeout'>((resolve, reject) => {
    let stop = () => {};
    const timer =
      seconds === undefined
        ? undefined
        : setTimeout(() => {
            stop();
            resolve('timeout');
          }, seconds * 1000);
    stop = deps.workflow.watchRuns(
      (snapshot) => {
        if (!done(snapshot)) return;
        clearTimeout(timer);
        stop();
        resolve('done');
      },
      () => {},
      (error) => {
        clearTimeout(timer);
        stop();
        reject(error);
      },
    );
  });
}

/** Opens a terminal if the environment can, else says what to run by hand. */
async function openOrExplain(
  deps: Deps,
  request: { cwd: string; repository: string; command: string; title: string },
  extra: Record<string, unknown>,
  json: boolean,
) {
  const { env, io } = deps;
  if (!env.openTerminal) {
    io.out(
      json
        ? JSON.stringify({ ...extra, opened: false, ...request })
        : `This terminal cannot open another one (${env.name}). Run:\n  cd ${request.cwd}\n  ${request.command}`,
    );
    return;
  }
  const result = await env.openTerminal(request);
  io.out(
    json
      ? JSON.stringify({ ...extra, opened: true, ...result })
      : `Opened ${result.cwd} in ${env.name}.`,
  );
}

export async function run(argv: string[], deps: Deps): Promise<number> {
  const { io } = deps;
  try {
    const { words, flags } = parse(argv);
    const json = flags.has('json');
    const [command, target, ...rest] = words;
    const print = (value: unknown, text: string) =>
      io.out(json ? JSON.stringify(value) : text);
    switch (command) {
      case undefined:
      case 'help':
        io.out(USAGE);
        return command ? EXIT.ok : EXIT.usage;
      case 'runs': {
        const { runs } = await deps.workflow.workflow();
        const rows = runs.map(summarize);
        print(rows, rows.map(line).join('\n') || 'No runs.');
        return EXIT.ok;
      }
      case 'show': {
        const row = summarize(await lookup(deps, target));
        print(
          row,
          [
            line(row),
            row.worktree ? `worktree  ${row.worktree}` : '',
            row.branch ? `branch    ${row.branch}` : '',
            row.question ? `\n${row.question.text}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return EXIT.ok;
      }
      case 'watch': {
        const id = target ? (await lookup(deps, target)).id : undefined;
        const seen = new Map<string, string>();
        const mirror = !flags.has('no-env') && deps.env.setStatus;
        await new Promise<void>((_, reject) =>
          deps.workflow.watchRuns(
            (snapshot) => {
              for (const item of snapshot.runs) {
                if (id && item.id !== id) continue;
                const row = summarize(item);
                const key = JSON.stringify([
                  row.status,
                  row.stage,
                  row.repair,
                  row.question?.id,
                  row.cleanup?.state,
                  row.pr,
                ]);
                if (seen.get(row.id) === key) continue;
                const first = !seen.has(row.id);
                seen.set(row.id, key);
                io.out(json ? JSON.stringify(row) : line(row));
                if (mirror)
                  void deps.env.setStatus!(row, !first).catch((error) =>
                    io.err(String(error.message ?? error)),
                  );
              }
            },
            () => {},
            reject,
          ),
        );
        return EXIT.ok;
      }
      case 'wait': {
        const id = (await lookup(deps, target)).id;
        const wanted =
          typeof flags.get('for') === 'string'
            ? (flags.get('for') as string).split(',')
            : SETTLED;
        const seconds =
          typeof flags.get('timeout') === 'string'
            ? Number(flags.get('timeout'))
            : undefined;
        if (seconds !== undefined && !(seconds > 0))
          throw new UsageError('--timeout must be a number of seconds.');
        let last: WorkflowRun | undefined;
        const outcome = await until(
          deps,
          (snapshot) => {
            last = snapshot.runs.find((item) => item.id === id);
            // A run that is gone can never reach a status, so stop waiting.
            return !last || wanted.includes(last.status);
          },
          seconds,
        );
        if (outcome === 'timeout') {
          io.err(`Timed out waiting for ${id}.`);
          return EXIT.timeout;
        }
        const row = last ? summarize(last) : { id, status: 'removed' };
        print(
          row,
          last
            ? line(row as ReturnType<typeof summarize>)
            : `${id} was removed.`,
        );
        return EXIT.ok;
      }
      case 'start': {
        const conversation = flags.get('conversation');
        const issue = Number(target);
        if (
          typeof conversation !== 'string' &&
          (!Number.isInteger(issue) || issue < 1)
        )
          throw new UsageError('Give a GitHub issue number.');
        const started = summarize(
          typeof conversation === 'string'
            ? await deps.workflow.startRun(conversation, randomUUID())
            : await deps.workflow.startIssue(issue, randomUUID()),
        );
        print(started, line(started));
        return EXIT.ok;
      }
      case 'pause':
      case 'resume':
      case 'cancel': {
        const row = summarize(
          await control(deps, await lookup(deps, target), command),
        );
        print(row, line(row));
        return EXIT.ok;
      }
      case 'answer': {
        const current = await lookup(deps, target);
        const question = pendingQuestion(current);
        const answer = rest.join(' ').trim();
        if (!question)
          throw new UsageError('This run has no pending question.');
        if (!acceptsTypedAnswer(question))
          throw new UsageError(
            `This question (${question.reason}) is cleared by a control, not a typed answer. Try: factory resume ${current.id}`,
          );
        if (!answer) throw new UsageError('Give the answer text.');
        const row = summarize(
          await deps.workflow.command(current.id, {
            operationId: randomUUID(),
            expectedRevision: current.revision,
            action: 'answer',
            interventionId: question.id,
            interventionRevision: question.revision,
            answer,
          }),
        );
        print(row, line(row));
        return EXIT.ok;
      }
      case 'send': {
        const current = await lookup(deps, target);
        const text = rest.join(' ').trim();
        if (!text) throw new UsageError('Give the message text.');
        const submission = await deps.chat.submit(
          current.developerConversationId,
          text,
          randomUUID(),
          flags.has('steer') ? 'steer' : 'followUp',
        );
        print(submission, `${submission.status}: ${submission.content}`);
        return EXIT.ok;
      }
      case 'open': {
        let current = await lookup(deps, target);
        if (flags.has('pause') && summarize(current).worktreeBusy) {
          current = await control(deps, current, 'pause');
          await until(
            deps,
            (snapshot) => !summarize(find(snapshot, current.id)).worktreeBusy,
            60,
          );
          current = await lookup(deps, current.id);
        }
        const row = summarize(current);
        if (!row.worktree)
          throw new Error(
            'This run has no worktree yet. Setup creates it; try again once the run is past setup.',
          );
        if (row.worktreeBusy)
          io.err(
            `warning: The run is ${row.status}; its developer agent may be writing to this worktree. Pause it (factory pause ${row.id}) before editing by hand.`,
          );
        await openOrExplain(
          deps,
          {
            cwd: row.worktree,
            repository: current.repository.path,
            command: `${deps.command} watch ${row.id}`,
            title: `factory ${row.id}`,
          },
          { run: row.id },
          json,
        );
        await deps.env.setStatus?.(row, false).catch(() => {});
        return EXIT.ok;
      }
      case 'plan':
        return await plan(deps, [target, ...rest], flags, json);
      default:
        throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT.usage;
    }
    if ((error as Error)?.message === 'fetch failed') {
      io.err(
        `Cannot reach the factory service at ${deps.url ?? 'its address'}. Start it (bun run dev) or set DURABLE_FACTORY_URL.`,
      );
      return EXIT.failed;
    }
    io.err(
      error instanceof ApiError
        ? `${error.code}: ${error.message}`
        : String((error as Error)?.message ?? error),
    );
    return EXIT.failed;
  }
}

const WAIT = 300;

async function plan(
  deps: Deps,
  [sub, id, ...rest]: (string | undefined)[],
  flags: Parsed['flags'],
  json: boolean,
) {
  const { io, chat } = deps;
  const seconds =
    typeof flags.get('timeout') === 'string'
      ? Number(flags.get('timeout'))
      : WAIT;
  if (!(seconds > 0))
    throw new UsageError('--timeout must be a number of seconds.');
  const show = (value: PlanSummary) =>
    io.out(json ? JSON.stringify(value) : planText(value));
  const need = () => {
    if (!id)
      throw new UsageError(
        'Name a planning conversation. List them with: factory plan list',
      );
    return id;
  };
  switch (sub) {
    case 'list': {
      const { conversations } = await chat.conversations();
      const rows = conversations
        .filter((item) => item.role === 'planning')
        .map((item) => ({ id: item.id, title: item.title, run: item.runId }));
      io.out(
        json
          ? JSON.stringify(rows)
          : rows
              .map(
                (row) =>
                  `${row.id}  ${row.title}${row.run ? `  run ${row.run}` : ''}`,
              )
              .join('\n') || 'No planning conversations.',
      );
      return EXIT.ok;
    }
    case 'new': {
      const title = [id, ...rest].filter(Boolean).join(' ').trim();
      if (!title) throw new UsageError('Give the conversation a title.');
      const created = await chat.createConversation(title, randomUUID());
      io.out(
        json
          ? JSON.stringify({ id: created.id, title: created.title })
          : `${created.id}  ${created.title}`,
      );
      return EXIT.ok;
    }
    case 'show':
      show(summarizePlan(await readSnapshot(chat, need())));
      return EXIT.ok;
    case 'send': {
      const conversation = need();
      const text = rest.join(' ').trim();
      if (!text) throw new UsageError('Give the message text.');
      show(await say(chat, conversation, text, seconds));
      return EXIT.ok;
    }
    case 'approve': {
      const current = summarizePlan(await readSnapshot(chat, need()));
      if (!current.awaitingApproval)
        throw new UsageError(
          'The planner has not proposed an issue yet. Keep planning with: factory plan send <id> <text>',
        );
      show(await say(chat, need(), 'create it', seconds));
      return EXIT.ok;
    }
    case 'chat': {
      const conversation = need();
      if (!deps.input) throw new UsageError('plan chat needs a terminal.');
      const view = new ChatView(deps.color ?? false);
      const write =
        deps.write ?? ((text: string) => io.out(text.replace(/\n$/, '')));
      // Errors go through the screen too, so they do not tear the input area.
      const problem = (text: string) =>
        deps.write ? write(view.note(text)) : io.err(text);
      let title = '';
      let ready!: () => void;
      const opened = new Promise<void>((resolve) => (ready = resolve));
      const stop = chat.watch(
        conversation,
        (snapshot) => {
          title = snapshot.conversation.title;
          const text = view.update(snapshot);
          if (text) write(text);
          deps.working?.(view.working);
          ready();
        },
        () => {},
        (error) => problem(String(error.message ?? error)),
      );
      try {
        await opened;
        await deps.env.nameTerminal?.(`plan: ${title}`).catch(() => {});
        for await (const raw of deps.input) {
          const text = raw.trim();
          if (!text) continue;
          try {
            if (text === '/quit' || text === '/exit') break;
            // A command shows up in the conversation like any message.
            if (text.startsWith('/')) write(view.echo(text));
            if (text === '/help') write(view.help());
            else if (text === '/ticket')
              write(
                view.plan?.ticket
                  ? view.panel(view.plan)
                  : view.note('No ticket yet. Describe what you want built.'),
              );
            else if (text === '/approve') {
              if (!view.plan?.awaitingApproval)
                write(view.note('The planner has not proposed an issue yet.'));
              else {
                view.mute('create it');
                await chat.submit(conversation, 'create it', randomUUID());
              }
            } else if (text === '/start') {
              if (!view.plan?.issue?.number)
                write(
                  view.note(
                    `Create the issue first (${view.cmd('/approve')}).`,
                  ),
                );
              else {
                const started = await deps.workflow.startRun(
                  conversation,
                  randomUUID(),
                );
                write(view.note(`Started run ${started.id}`));
                write(`     factory watch ${started.id}`);
              }
            } else if (text.startsWith('/'))
              write(view.note(`Unknown command ${text}. Try /help.`));
            else await chat.submit(conversation, text, randomUUID());
          } catch (error) {
            problem(String((error as Error).message ?? error));
          }
        }
      } finally {
        stop();
        deps.close?.();
      }
      return EXIT.ok;
    }
    case 'open': {
      // Kept from before environments existed; `plan chat` now does this itself.
      const snapshot = await readSnapshot(chat, need());
      const repository = snapshot.conversation.repository.path;
      await openOrExplain(
        deps,
        {
          cwd: repository,
          repository,
          command: `${deps.command} plan chat ${snapshot.conversation.id}`,
          title: `plan ${snapshot.conversation.id}`,
        },
        { conversation: snapshot.conversation.id },
        json,
      );
      return EXIT.ok;
    }
    default:
      throw new UsageError(
        'Use: factory plan list | new <title> | show <id> | send <id> <text> | approve <id> | chat <id>',
      );
  }
}
