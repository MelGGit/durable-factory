import { createInterface } from 'node:readline';
import { styles } from './chat-view.js';
import { Screen } from './screen.js';
import { SlashMenu } from './slash.js';

/**
 * The person's side of `plan chat`: a prompt, and on a real terminal a menu of
 * `/` commands that Up and Down move through and Tab or Enter picks.
 */
export function openTerminal(color: boolean) {
  const s = styles(color);
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const menu = new SlashMenu();
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: color ? `${s.bold(s.dim('>'))} ` : '> ',
    terminal: tty,
    // Up and Down belong to the menu, so history navigation is off.
    historySize: 0,
    completer: (line: string): [string[], string] => {
      const choice = menu.choice();
      return choice && choice.startsWith(line) ? [[choice], line] : [[], line];
    },
  });
  const raw = (text: string) => process.stdout.write(text);
  const screen = tty
    ? new Screen({
        editor: lines,
        write: raw,
        s,
        columns: () => process.stdout.columns || 80,
        prompt: () => lines.prompt(true),
        menu,
        promptWidth: 2,
      })
    : undefined;
  if (screen) {
    // Readline has already handled the key by the time this runs.
    process.stdin.on('keypress', (_text, key) => {
      if (key?.name === 'return') {
        screen.submit();
        return;
      }
      if (key?.name === 'up' || key?.name === 'down')
        menu.move(key.name === 'up' ? -1 : 1);
      else menu.update(lines.line);
      screen.refresh();
    });
    screen.start();
  }

  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  lines.on('line', (line) => {
    // Resolved now, while the menu still shows what Enter would pick.
    queue.push(menu.resolve(line));
    wake?.();
  });
  lines.on('close', () => {
    closed = true;
    wake?.();
  });
  async function* input() {
    for (;;) {
      if (queue.length) yield queue.shift()!;
      else if (closed) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    input: input(),
    write: (text: string) =>
      screen ? screen.print(text) : raw(`${text.replace(/\n$/, '')}\n`),
    working: (on: boolean) => screen?.setWorking(on),
    finish: () => screen?.finish(),
  };
}
