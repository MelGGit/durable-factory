import type { ServerResponse } from 'node:http';

export type Redaction = [path: string, label: string];

const escapePattern = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Latin-1 maps every byte to one character, so text can be matched and
// replaced without decoding a multi-byte character that a write split.
const bytes = (text: string) => Buffer.from(text, 'utf8').toString('latin1');
const escaped = (text: string) => JSON.stringify(text).slice(1, -1);

/** Replaces server paths with short labels in a stream of byte chunks. A
 * path can straddle two writes, so a tail that could still become a path is
 * held back until the next chunk settles it. */
export function createRedactor(redactions: Redaction[]) {
  const labels = new Map<string, string>();
  for (const [path, label] of redactions) {
    if (path.length < 2) continue;
    for (const form of [path, escaped(path)])
      if (!labels.has(bytes(form))) labels.set(bytes(form), bytes(label));
  }
  const needles = [...labels.keys()].sort((a, b) => b.length - a.length);
  if (!needles.length) return undefined;
  // A path ends at a separator, a quote or the end of the text. Without that
  // check `/Users/mel` would also rewrite the start of `/Users/melody`.
  const pattern = new RegExp(
    `(?:${needles.map(escapePattern).join('|')})(?![A-Za-z0-9_-])`,
    'g',
  );
  const replace = (text: string) =>
    text.replace(pattern, (found) => labels.get(found)!);
  const longest = needles[0].length;
  // A tail that is, or could grow into, a path is held until the next chunk
  // shows what follows it. Every needle starts with `/`, which is not a name
  // character, so the text before a held tail never affects a match.
  const held = (text: string) => {
    for (let size = Math.min(longest, text.length); size > 0; size--) {
      const tail = text.slice(-size);
      if (
        needles.some(
          (needle) => needle.length >= size && needle.startsWith(tail),
        )
      )
        return size;
    }
    return 0;
  };
  let pending = '';
  return {
    push(chunk: Buffer) {
      const text = pending + chunk.toString('latin1');
      const keep = held(text);
      pending = text.slice(text.length - keep);
      return Buffer.from(replace(text.slice(0, text.length - keep)), 'latin1');
    },
    flush() {
      const text = pending;
      pending = '';
      return Buffer.from(replace(text), 'latin1');
    },
  };
}

/** Rewrites everything written to `res` so a remote client never sees the
 * server's own directories. */
export function redactResponse(res: ServerResponse, redactions: Redaction[]) {
  const redactor = createRedactor(redactions);
  if (!redactor) return;
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
  const toBuffer = (chunk: unknown, encoding: unknown) =>
    typeof chunk === 'string'
      ? Buffer.from(
          chunk,
          typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8',
        )
      : Buffer.from(chunk as Uint8Array);
  res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    return write(redactor.push(toBuffer(chunk, encoding)), done);
  }) as typeof res.write;
  res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
    const done =
      typeof chunk === 'function'
        ? chunk
        : typeof encoding === 'function'
          ? encoding
          : callback;
    const body =
      chunk === undefined || chunk === null || typeof chunk === 'function'
        ? Buffer.alloc(0)
        : redactor.push(toBuffer(chunk, encoding));
    return end(Buffer.concat([body, redactor.flush()]), done);
  }) as typeof res.end;
}
