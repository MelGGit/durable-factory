import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/** Largest text any one agent tool returns (about 16k tokens). */
export const OUTPUT_BYTES = 64 * 1024;
/** Output tail attached to a failed check or proof for the developer. */
export const FAILURE_TAIL_BYTES = 8 * 1024;
/** Longest log line shown; minified output would otherwise fill a page. */
const LINE_CHARS = 2000;

const clip = (line: string) =>
  line.length > LINE_CHARS
    ? `${line.slice(0, LINE_CHARS)}… [line truncated]`
    : line;

/** The last `limit` bytes of `text`, starting on a line boundary when possible. */
export function tailText(text: string, limit = OUTPUT_BYTES) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return { text, truncated: false };
  let tail = buffer.subarray(buffer.length - limit).toString('utf8');
  const newline = tail.indexOf('\n');
  if (newline >= 0 && newline < tail.length - 1) tail = tail.slice(newline + 1);
  return { text: tail.replace(/^�+/, ''), truncated: true };
}
/** The last `limit` bytes of a log file, which may be far larger than memory should hold. */
export async function fileTail(path: string, limit = FAILURE_TAIL_BYTES) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, limit + 4);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const tail = tailText(buffer.toString('utf8'), limit);
    return { text: tail.text, truncated: tail.truncated || size > length };
  } finally {
    await file.close();
  }
}
/** Lines rendered `number<TAB>text`, stopping before the byte budget runs out. */
export function numbered(
  entries: { number: number; text: string }[],
  budget = OUTPUT_BYTES,
) {
  const shown: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const line = `${entry.number}\t${clip(entry.text)}`;
    used += Buffer.byteLength(line) + 1;
    if (used > budget && shown.length) break;
    shown.push(line);
  }
  return { text: shown.join('\n'), shown: shown.length };
}
/** The last lines that fit the byte budget, numbered; `first` is the number of the earliest shown. */
export function numberedTail(
  entries: { number: number; text: string }[],
  budget = OUTPUT_BYTES,
) {
  const kept: typeof entries = [];
  let used = 0;
  for (const entry of entries.slice().reverse()) {
    used += Buffer.byteLength(`${entry.number}\t${clip(entry.text)}`) + 1;
    if (used > budget && kept.length) break;
    kept.unshift(entry);
  }
  return { text: numbered(kept, Infinity).text, first: kept[0]?.number ?? 1 };
}
/** Whether a model-supplied search expression is usable; the message is for the model. */
export function searchExpression(pattern: string, literal?: boolean) {
  if (pattern.length > 500)
    throw new Error('Pattern is longer than 500 characters.');
  try {
    return new RegExp(
      literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern,
    );
  } catch (error) {
    throw new Error(
      `Invalid regular expression: ${(error as Error).message}. Set literal to search for the text as written.`,
    );
  }
}

export type LogQuery =
  | { mode: 'tail'; lines: number }
  | { mode: 'range'; startLine: number; endLine: number }
  | {
      mode: 'grep';
      pattern: RegExp;
      context: number;
      maxMatches: number;
    };
/** One bounded read of a command log: its tail, a line range or matches with context. */
export async function readLog(path: string, query: LogQuery) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let total = 0;
  const picked: { number: number; text: string }[] = [];
  const before: { number: number; text: string }[] = [];
  let after = 0,
    matches = 0,
    last = 0;
  try {
    for await (const text of reader) {
      const number = ++total;
      if (query.mode === 'tail') {
        picked.push({ number, text });
        if (picked.length > query.lines) picked.shift();
      } else if (query.mode === 'range') {
        if (number >= query.startLine && number <= query.endLine)
          picked.push({ number, text });
      } else if (query.pattern.test(text)) {
        matches++;
        if (matches <= query.maxMatches) {
          for (const line of before) if (line.number > last) picked.push(line);
          picked.push({ number, text });
          last = number;
          after = query.context;
        }
        before.length = 0;
      } else if (after > 0) {
        picked.push({ number, text });
        last = number;
        after--;
      } else if (query.context) {
        before.push({ number, text });
        if (before.length > query.context) before.shift();
      }
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return { total, lines: picked, matches };
}
