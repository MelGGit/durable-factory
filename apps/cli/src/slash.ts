import type { Styles } from './chat-view.js';

export interface SlashCommand {
  name: string;
  hint: string;
}

/** The commands `plan chat` understands, in the order the menu lists them. */
export const COMMANDS: SlashCommand[] = [
  { name: '/ticket', hint: 'show the current ticket' },
  {
    name: '/approve',
    hint: 'create the GitHub issue (after the planner proposes it)',
  },
  { name: '/start', hint: 'start an implementation run from this plan' },
  { name: '/help', hint: 'list the commands' },
  { name: '/quit', hint: 'leave (Ctrl-D also works)' },
];

/** The commands a half-typed line could become. Nothing once an argument starts. */
export const matches = (line: string) =>
  line.startsWith('/') && !/\s/.test(line)
    ? COMMANDS.filter((command) => command.name.startsWith(line.toLowerCase()))
    : [];

/** Highlights every known command named inside a sentence. */
export const highlight = (text: string, s: Styles) =>
  text.replace(/\/[a-z]+/g, (word) =>
    COMMANDS.some((command) => command.name === word)
      ? s.bold(s.cyan(word))
      : word,
  );

export function menuRows(found: SlashCommand[], selected: number, s: Styles) {
  const width = Math.max(...found.map((command) => command.name.length));
  return found.map((command, index) => {
    const name = command.name.padEnd(width);
    return index === selected
      ? `${s.bold(s.cyan(`› ${name}`))}  ${command.hint}`
      : `  ${s.cyan(name)}  ${s.dim(command.hint)}`;
  });
}

/**
 * Which command the person is picking while a line starts with `/`. Drawing is
 * the screen's job; this only keeps the matches and the highlighted one.
 */
export class SlashMenu {
  selected = 0;
  found: SlashCommand[] = [];

  /** Called whenever the line changed; keeps the highlight where it was if it can. */
  update(line: string) {
    const before = this.choice();
    this.found = matches(line);
    const kept = this.found.findIndex((command) => command.name === before);
    this.selected = kept >= 0 ? kept : 0;
  }

  move(by: number) {
    if (!this.found.length) return false;
    this.selected =
      (this.selected + by + this.found.length) % this.found.length;
    return true;
  }

  /** The command Tab or Enter would pick, if the menu is open. */
  choice() {
    return this.found[this.selected]?.name;
  }

  reset() {
    this.found = [];
    this.selected = 0;
  }

  /** What the person meant by this line: Enter on `/ap` runs `/approve`. */
  resolve(line: string) {
    const text = line.trim();
    if (!text.startsWith('/') || /\s/.test(text)) return text;
    if (COMMANDS.some((command) => command.name === text.toLowerCase()))
      return text.toLowerCase();
    return this.choice() ?? text;
  }
}
