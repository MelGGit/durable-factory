import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styles } from '../apps/cli/src/chat-view.js';
import { Screen } from '../apps/cli/src/screen.js';
import {
  COMMANDS,
  SlashMenu,
  highlight,
  matches,
  menuRows,
} from '../apps/cli/src/slash.js';

const plain = styles(false);

test('matches lists commands that continue the typed text and stops at an argument', () => {
  assert.equal(matches('/').length, COMMANDS.length);
  assert.deepEqual(
    matches('/a').map((c) => c.name),
    ['/approve'],
  );
  assert.deepEqual(
    matches('/APP').map((c) => c.name),
    ['/approve'],
  );
  assert.deepEqual(matches('hello'), []);
  assert.deepEqual(matches('/approve now'), []);
  assert.deepEqual(matches('/nope'), []);
});

test('menu rows mark the selected command and align the hints', () => {
  const rows = menuRows(COMMANDS, 1, plain);
  assert.equal(rows.length, COMMANDS.length);
  assert.ok(rows[1].startsWith('› /approve'));
  assert.ok(rows[0].startsWith('  /ticket '));
  assert.match(menuRows(COMMANDS, 0, styles(true))[0], /\x1b\[1m/);
});

test('highlight styles only known commands inside a sentence', () => {
  const colored = highlight(
    'Reply yes (or /approve) or /unknown',
    styles(true),
  );
  assert.match(colored, /\x1b\[1m\x1b\[36m\/approve/);
  assert.doesNotMatch(colored, /\/unknown\x1b/);
});

test('the menu opens on /, moves with wrap-around, narrows as you type and resets', () => {
  const menu = new SlashMenu();
  assert.equal(menu.move(1), false, 'closed menu does not move');
  menu.update('/');
  assert.equal(menu.found.length, COMMANDS.length);
  assert.equal(menu.choice(), '/ticket');
  menu.move(-1);
  assert.equal(menu.choice(), '/quit');
  menu.move(1);
  assert.equal(menu.choice(), '/ticket');
  menu.move(1);
  assert.equal(menu.choice(), '/approve');
  menu.update('/a');
  assert.deepEqual(
    menu.found.map((c) => c.name),
    ['/approve'],
  );
  menu.update('hello');
  assert.equal(menu.found.length, 0);
  menu.update('/s');
  menu.reset();
  assert.equal(menu.choice(), undefined);
});

test('Enter on a partial command runs the highlighted one, and exact text is left alone', () => {
  const menu = new SlashMenu();
  menu.update('/st');
  assert.equal(menu.resolve('/st'), '/start');
  assert.equal(menu.resolve('/QUIT'), '/quit');
  assert.equal(menu.resolve('/approve now'), '/approve now');
  assert.equal(menu.resolve('  plain text  '), 'plain text');
  menu.update('/zzz');
  assert.equal(menu.resolve('/zzz'), '/zzz');
});

function screen() {
  const written: string[] = [];
  const editor = { line: '', cursor: 0 };
  const menu = new SlashMenu();
  const view = new Screen({
    editor,
    write: (text) => written.push(text),
    s: plain,
    columns: () => 40,
    prompt: () => written.push('<prompt>'),
    menu,
    promptWidth: 2,
  });
  return { view, written, editor, menu, text: () => written.join('') };
}

test('the screen draws a status row, a rule, the prompt, a rule and a hint', () => {
  const { view, text } = screen();
  view.start();
  const rule = '─'.repeat(40);
  assert.match(text(), new RegExp(`^\\n\\r${rule}\\n\\r<prompt>`));
  assert.match(text(), new RegExp(`\\n\\r${rule}\\n\\r.*/ for commands`));
  // Back on the input line: up past the rule and the hint.
  assert.match(text(), /\x1b\[2A\r\x1b\[2C$/);
});

test('printing erases the input area, writes the text, then redraws it', () => {
  const { view, written, text } = screen();
  view.start();
  written.length = 0;
  view.print('hello\nworld\n');
  assert.ok(text().startsWith('\x1b[2A\r\x1b[J'));
  assert.ok(text().includes('hello\r\nworld\r\n'));
  assert.ok(text().indexOf('world') < text().indexOf('<prompt>'));
  assert.match(text(), /\/ for commands/);
});

test('the slash menu replaces the hint and follows the highlight', () => {
  const { view, written, editor, menu, text } = screen();
  view.start();
  editor.line = '/';
  editor.cursor = 1;
  menu.update('/');
  written.length = 0;
  view.refresh();
  assert.match(text(), /› \/ticket/);
  assert.doesNotMatch(text(), /Tab completes/);
  assert.match(
    text(),
    new RegExp(`\\x1b\\[${COMMANDS.length + 1}A\\r\\x1b\\[3C$`),
  );
  menu.move(1);
  written.length = 0;
  view.refresh();
  assert.match(text(), /› \/approve/);
});

test('Enter collapses the typed line, closes the menu and redraws an empty input', () => {
  const { view, written, menu, text } = screen();
  view.start();
  menu.update('/he');
  written.length = 0;
  view.submit();
  // Up past the bottom rule, input line, top rule and status row.
  assert.ok(text().startsWith('\x1b[3A\r\x1b[J'));
  assert.equal(menu.found.length, 0);
  assert.match(text(), /<prompt>/);
});

test('working shows an animated status row and clears it when done', () => {
  const { view, written, text } = screen();
  view.start();
  written.length = 0;
  view.setWorking(true);
  assert.match(text(), /Working…/);
  assert.match(text(), /\x1b\[2K/);
  written.length = 0;
  view.setWorking(false);
  assert.doesNotMatch(text(), /Working/);
  assert.match(text(), /\x1b\[2K/);
  view.setWorking(false);
  view.finish();
});
