import type {
  ConversationSnapshot,
  ToolView,
} from '../../../packages/shared/src/index.js';
import { summarizePlan, type PlanSummary } from './planning.js';
import { COMMANDS } from './slash.js';

const sgr = (color: boolean, code: string) => (text: string) =>
  color ? `\x1b[${code}m${text}\x1b[0m` : text;

export function styles(color: boolean) {
  return {
    bold: sgr(color, '1'),
    dim: sgr(color, '2'),
    red: sgr(color, '31'),
    green: sgr(color, '32'),
    yellow: sgr(color, '33'),
    cyan: sgr(color, '36'),
    magenta: sgr(color, '35'),
  };
}
export type Styles = ReturnType<typeof styles>;

/** Text as it appears on screen, without colour codes. */
export const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** A tool, named as Claude Code names its own: `Read(src/a.ts)`. */
const TOOLS: Record<string, string> = {
  list_repository: 'List',
  read_repository: 'Read',
  search_repository: 'Search',
  repository_changes: 'Changes',
  search_history: 'History',
  save_ticket: 'Save ticket',
  review_ticket: 'Review ticket',
  propose_issue: 'Propose issue',
  create_issue: 'Create issue',
  update_issue: 'Update issue',
  start_development: 'Start run',
};

export function toolLabel(tool: Pick<ToolView, 'name' | 'arguments'>) {
  let arg = '';
  try {
    const args = JSON.parse(tool.arguments || '{}');
    if (typeof args.path === 'string') arg = args.path;
    else {
      const text = args.pattern ?? args.query ?? args.literal;
      if (typeof text === 'string') arg = `"${text}"`;
    }
  } catch {
    // Arguments may still be streaming in.
  }
  return {
    name: TOOLS[tool.name] ?? tool.name.replace(/_/g, ' '),
    arg: arg.slice(0, 60),
  };
}

export function describeTool(tool: Pick<ToolView, 'name' | 'arguments'>) {
  const { name, arg } = toolLabel(tool);
  return arg ? `${name}(${arg})` : name;
}

/** Terminal markdown, one line at a time so a reply can stream. */
export class Markdown {
  private fenced = false;
  constructor(private s: Styles) {}
  inline(text: string) {
    return text
      .replace(/\*\*([^*]+)\*\*/g, (_, t) => this.s.bold(t))
      .replace(/`([^`]+)`/g, (_, t) => this.s.cyan(t));
  }
  line(raw: string) {
    if (/^\s*```/.test(raw)) {
      this.fenced = !this.fenced;
      return this.s.dim(raw.trim() ? '┄' : '');
    }
    if (this.fenced) return this.s.dim(`│ ${raw}`);
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) return this.s.bold(this.inline(heading[1]));
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if (bullet) return `${bullet[1]}• ${this.inline(bullet[2])}`;
    return this.inline(raw);
  }
}

const HISTORY = 6;

/**
 * Turns the snapshots of a planning conversation into terminal output in the
 * style of Claude Code: `>` for the person, `●` for the planner and its tools.
 * Each `update` returns only what is new since the last one.
 */
export class ChatView {
  private s: Styles;
  private md: Markdown;
  private started = false;
  private seen = new Set<string>();
  private tools = new Set<string>();
  /** A reply is being written. */
  private open = false;
  /** Its bullet is already shown. */
  private led = false;
  /** Characters of the current reply already shown, and a line not yet finished. */
  private shown = 0;
  private pending = '';
  private ticket = -1;
  private awaiting = false;
  private issue = '';
  private run = '';
  private muted: string[] = [];
  private exec: ConversationSnapshot['execution'] = 'idle';
  plan?: PlanSummary;
  /** The planner is working on a turn. */
  working = false;
  /** The planner finished a turn with this update. */
  idle = false;

  constructor(color: boolean) {
    this.s = styles(color);
    this.md = new Markdown(this.s);
  }

  /** A command name, the way the menu and help show it. */
  cmd(name: string) {
    return this.s.bold(this.s.cyan(name));
  }

  private bullet(color: (text: string) => string = this.s.bold) {
    return color('●');
  }

  /** A message from the person, as it is echoed into the transcript. */
  echo(text: string) {
    const [first, ...rest] = text.trim().split('\n');
    return [
      '',
      `${this.s.bold(this.s.dim('>'))} ${this.s.bold(first)}`,
      ...rest.map((line) => `  ${line}`),
    ].join('\n');
  }

  /** Text a command sends for the person; its echo from the service is not shown. */
  mute(text: string) {
    this.muted.push(text);
  }

  /** A short result under a command, the way Claude Code shows one. */
  note(text: string) {
    return `${this.s.dim('  ⎿  ')}${text}`;
  }

  /** Planner text; only the first line of a reply carries the bullet. */
  private speak(text: string, out: string[]) {
    if (!this.open) {
      out.push('');
      this.open = true;
      this.led = false;
    }
    out.push(
      text
        .split('\n')
        .map((line, index) => {
          const lead = !this.led && index === 0 ? `${this.bullet()} ` : '  ';
          return `${lead}${this.md.line(line)}`;
        })
        .join('\n'),
    );
    this.led = true;
  }

  private activity(tool: ToolView, out: string[]) {
    if (this.tools.has(tool.id)) return;
    this.tools.add(tool.id);
    this.close(out);
    const { name, arg } = toolLabel(tool);
    out.push(
      `${this.bullet(this.s.green)} ${this.s.bold(name)}${arg ? this.s.dim(`(${arg})`) : ''}`,
    );
  }

  /** Ends the reply being streamed, if any. */
  private close(out: string[]) {
    if (!this.open) return;
    if (this.pending) this.speak(this.pending, out);
    this.open = false;
    this.led = false;
    this.pending = '';
    this.shown = 0;
  }

  /** A rounded box around lines of any styling. */
  box(lines: string[]) {
    const width = Math.max(...lines.map((line) => visible(line).length)) + 2;
    const edge = this.s.dim;
    return [
      edge(`╭${'─'.repeat(width)}╮`),
      ...lines.map(
        (line) =>
          `${edge('│')} ${line}${' '.repeat(width - visible(line).length - 1)}${edge('│')}`,
      ),
      edge(`╰${'─'.repeat(width)}╯`),
    ].join('\n');
  }

  panel(plan: PlanSummary) {
    if (!plan.ticket) return '';
    const bar = this.s.dim('│');
    const lines = [
      `${this.s.dim('┌')} ${this.s.bold(`Ticket r${plan.ticket.revision} · ${plan.ticket.title}`)}`,
      ...plan.ticket.text.split('\n').map((line) => `${bar} ${line}`),
    ];
    if (plan.review)
      lines.push(
        `${bar} ${
          plan.review.passed
            ? this.s.green('✔ readiness review passed')
            : this.s.yellow('! readiness review has open findings')
        }`,
        ...plan.review.open.map(
          (text) => `${bar}   ${this.s.yellow('-')} ${text}`,
        ),
      );
    lines.push(this.s.dim('└'));
    return lines.join('\n');
  }

  private welcome(snapshot: ConversationSnapshot, plan: PlanSummary) {
    return [
      this.box([
        `${this.s.yellow('✻')} ${this.s.bold('Durable Factory')}`,
        '',
        `  ${this.s.bold('Planning')} · ${snapshot.conversation.title}`,
        this.s.dim(
          `  #${snapshot.conversation.id} · ${plan.repository || 'no repository'}`,
        ),
      ]),
      this.s.dim(
        '  Describe what you want built. Type / for commands, Ctrl-D to leave.',
      ),
    ].join('\n');
  }

  update(snapshot: ConversationSnapshot) {
    const out: string[] = [];
    const first = !this.started;
    this.started = true;
    const plan = (this.plan = summarizePlan(snapshot));

    if (first) {
      out.push(this.welcome(snapshot, plan));
      const shown = snapshot.entries.filter(
        (entry) =>
          entry.kind === 'pi.user' ||
          (entry.kind === 'pi.assistant' && entry.text.trim()),
      );
      if (shown.length > HISTORY)
        out.push(
          '',
          this.s.dim(`  … ${shown.length - HISTORY} earlier messages`),
        );
      const keep = new Set(shown.slice(-HISTORY).map((entry) => entry.id));
      for (const entry of snapshot.entries) {
        this.seen.add(entry.id);
        entry.tools.forEach((tool) => this.tools.add(tool.id));
        if (!keep.has(entry.id)) continue;
        if (entry.kind === 'pi.user') out.push(this.echo(entry.text));
        else {
          this.speak(entry.text.trim(), out);
          this.open = false;
          this.led = false;
        }
      }
    }

    // The reply as it streams: whole lines at a time, so markdown can style them.
    if (snapshot.partial) {
      if (snapshot.partial.length < this.shown + this.pending.length) {
        this.open = false;
        this.led = false;
        this.shown = 0;
        this.pending = '';
      }
      const fresh = snapshot.partial.slice(this.shown + this.pending.length);
      this.pending += fresh;
      const cut = this.pending.lastIndexOf('\n');
      if (cut >= 0) {
        this.speak(this.pending.slice(0, cut), out);
        this.shown += cut + 1;
        this.pending = this.pending.slice(cut + 1);
      }
    }

    for (const tool of snapshot.tools) this.activity(tool, out);

    for (const entry of snapshot.entries) {
      if (this.seen.has(entry.id)) continue;
      this.seen.add(entry.id);
      entry.tools.forEach((tool) => this.activity(tool, out));
      const text = entry.text.trim();
      if (entry.kind === 'pi.user') {
        this.close(out);
        const muted = this.muted.indexOf(text);
        if (muted >= 0) this.muted.splice(muted, 1);
        else out.push(this.echo(text));
      } else if (entry.kind === 'pi.assistant' && text) {
        // Text already streamed is not shown twice.
        const rest = this.open
          ? text.slice(this.shown).replace(/^\n/, '')
          : text;
        if (rest.trim()) this.speak(rest, out);
        this.open = false;
        this.led = false;
        this.pending = '';
        this.shown = 0;
      }
    }

    if (plan.ticket && plan.ticket.revision !== this.ticket) {
      this.close(out);
      this.ticket = plan.ticket.revision;
      out.push('', this.panel(plan));
    }
    if (plan.awaitingApproval && !this.awaiting) {
      this.close(out);
      out.push(
        '',
        `${this.bullet(this.s.yellow)} ${this.s.bold('Ready to create the GitHub issue.')} Reply yes or ${this.cmd('/approve')}, or tell me what to change.`,
      );
    }
    this.awaiting = plan.awaitingApproval;
    const issue = plan.issue?.number ? `${plan.issue.number}` : '';
    if (issue && issue !== this.issue) {
      this.issue = issue;
      out.push(
        '',
        this.s.bold(
          this.s.green(
            `✔ Issue #${issue} created${plan.issue?.url ? `  ${plan.issue.url}` : ''}`,
          ),
        ),
        `  ${this.cmd('/start')}${this.s.dim(' begins an implementation run.')}`,
      );
    }
    if (plan.runId && plan.runId !== this.run) {
      this.run = plan.runId;
      out.push(
        '',
        this.s.bold(this.s.green(`▶ Run ${plan.runId} started`)),
        this.s.dim(`  factory watch ${plan.runId}`),
      );
    }

    this.working = snapshot.execution === 'running';
    this.idle =
      snapshot.execution === 'idle' && (first || this.exec !== 'idle');
    if (snapshot.execution === 'idle') this.close(out);
    this.exec = snapshot.execution;
    const text = out.join('\n').replace(/\n{3,}/g, '\n\n');
    return first ? text : text.replace(/^\n+/, '\n').replace(/^\n$/, '');
  }

  help() {
    const width = Math.max(...COMMANDS.map((command) => command.name.length));
    return [
      '',
      `${this.bullet()} ${this.s.bold('Commands')}`,
      ...COMMANDS.map(
        (command) =>
          `  ${this.cmd(command.name.padEnd(width))}  ${this.s.dim(command.hint)}`,
      ),
    ].join('\n');
  }
}
