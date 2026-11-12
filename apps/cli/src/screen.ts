import type { Styles } from './chat-view.js';
import { menuRows, type SlashMenu } from './slash.js';

interface Editor {
  line: string;
  cursor: number;
}

export interface ScreenOptions {
  editor: Editor;
  write: (text: string) => void;
  s: Styles;
  columns: () => number;
  /** Prints the prompt and the line typed so far, leaving the cursor in it. */
  prompt: () => void;
  menu: SlashMenu;
  /** Width of the prompt as it appears on screen. */
  promptWidth: number;
}

const SPINNER = ['✻', '✽', '✶', '✳'];

/** Rows above the input line: the status row and the top rule. */
const ABOVE = 2;

/**
 * The part of the terminal that stays at the bottom while the conversation
 * scrolls above it, laid out like Claude Code's:
 *
 *     ✻ Working… (3s)        status row, blank when idle
 *     ────────────────       rule
 *     > text you type        the input line, which readline owns
 *     ────────────────       rule
 *       / for commands …     the hint, or the slash menu while typing /
 *
 * The cursor rests on the input line. Everything else is reached with relative
 * moves, so the layout survives the terminal scrolling.
 */
export class Screen {
  private below = 0;
  private working = false;
  private since = 0;
  private frames = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private o: ScreenOptions) {}

  private col() {
    const column = this.o.promptWidth + this.o.editor.cursor;
    return column > 0 ? `\r\x1b[${column}C` : '\r';
  }

  private rule() {
    return this.o.s.dim('─'.repeat(Math.max(10, this.o.columns())));
  }

  private status() {
    if (!this.working) return '';
    const seconds = Math.floor((Date.now() - this.since) / 1000);
    const { s } = this.o;
    return `${s.yellow(SPINNER[this.frames % SPINNER.length])} ${s.yellow('Working…')} ${s.dim(`(${seconds}s)`)}`;
  }

  private hint() {
    return this.o.s.dim('  / for commands · Tab completes · Ctrl-D leaves');
  }

  /** The bottom rule, then the menu or the hint, drawn under the input line. */
  private drawBelow() {
    const { menu, s } = this.o;
    const rows = [
      this.rule(),
      ...(menu.found.length
        ? menuRows(menu.found, menu.selected, s)
        : [this.hint()]),
    ];
    this.o.write(`\n\r${rows.join('\n\r')}\x1b[${rows.length}A${this.col()}`);
    this.below = rows.length;
  }

  private eraseBelow() {
    if (!this.below) return;
    this.o.write(`\n\r\x1b[J\x1b[1A${this.col()}`);
    this.below = 0;
  }

  /** Draws everything from a cursor at the start of an empty row. */
  private frame() {
    this.o.write(`${this.status()}\n\r${this.rule()}\n\r`);
    this.o.prompt();
    this.drawBelow();
  }

  start() {
    this.frame();
  }

  /** Writes text into the conversation above, then restores the input area. */
  print(text: string) {
    this.o.write(`\x1b[${ABOVE}A\r\x1b[J`);
    this.below = 0;
    const body = text.replace(/\n$/, '');
    if (body) this.o.write(`${body.replace(/\r?\n/g, '\r\n')}\r\n`);
    this.frame();
  }

  /** Redraws what is under the input line after the line or the menu changed. */
  refresh() {
    this.eraseBelow();
    this.drawBelow();
  }

  /** After Enter: the typed line is replaced by its echo in the conversation. */
  submit() {
    // Enter left the cursor on the bottom rule, one row under the input line.
    this.o.write(`\x1b[${ABOVE + 1}A\r\x1b[J`);
    this.below = 0;
    this.o.menu.reset();
    this.frame();
  }

  private paintStatus() {
    this.o.write(
      `\x1b[${ABOVE}A\r\x1b[2K${this.status()}\x1b[${ABOVE}B${this.col()}`,
    );
  }

  setWorking(on: boolean) {
    if (on === this.working) return;
    this.working = on;
    if (on) {
      this.since = Date.now();
      this.timer = setInterval(() => {
        this.frames++;
        this.paintStatus();
      }, 120);
    } else clearInterval(this.timer);
    this.paintStatus();
  }

  /** Leaves the terminal tidy: no rules under the shell prompt. */
  finish() {
    clearInterval(this.timer);
    this.eraseBelow();
    this.o.write('\r\n');
  }
}
