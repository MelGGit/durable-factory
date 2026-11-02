import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The version a reconnecting client says it already holds, if it sent one. */
export function lastEventId(req: IncomingMessage) {
  const value = req.headers['last-event-id'];
  return typeof value === 'string' && value && value.length <= 128
    ? value
    : undefined;
}

/** An opaque id for a snapshot that has no revision counter of its own. */
export const contentVersion = (json: string) =>
  createHash('sha256').update(json).digest('base64url').slice(0, 22);

/** Bound socket writes without imposing a size limit on a transcript snapshot.
 * Callers must keep heartbeats outside this write, including its drain waits. */
export async function writeSse(
  res: ServerResponse,
  payload: string,
): Promise<boolean> {
  const bytes = Buffer.from(payload);
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    if (res.destroyed || res.writableEnded) return false;
    const packet = bytes.subarray(offset, offset + 64 * 1024);
    if (res.writableLength + packet.length > 1024 * 1024) return false;
    if (!res.write(packet)) {
      const drained = await new Promise<boolean>((resolve) => {
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          res.off('drain', onDrain);
          res.off('close', onClose);
          res.off('error', onClose);
          resolve(ok);
        };
        const onDrain = () => finish(true);
        const onClose = () => finish(false);
        const timer = setTimeout(() => finish(false), 45000);
        res.once('drain', onDrain);
        res.once('close', onClose);
        res.once('error', onClose);
      });
      if (!drained) return false;
    }
  }
  return true;
}

/** Where a stream's text goes: a response of its own, or a channel of the
 * project stream. */
export interface StreamSink {
  /** Whether the consumer is already gone. */
  closed(): boolean;
  open(): void;
  /** False when the consumer is gone or too far behind. */
  write(payload: string): Promise<boolean>;
  /** Best-effort, never waits. False when the consumer is too far behind. */
  heartbeat(): boolean;
  /** A final payload, written only if it fits. */
  last(payload: string): void;
  end(graceful: boolean): void;
  onClose(callback: () => void): void;
}

/** A stream that owns its response. */
export function responseSink(
  res: ServerResponse,
  headers: Record<string, string> = {},
  heartbeat = ': heartbeat\n\n',
): StreamSink {
  let writing = false;
  return {
    closed: () => res.destroyed,
    open() {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...headers,
      });
      res.flushHeaders();
    },
    async write(payload) {
      writing = true;
      try {
        return await writeSse(res, payload);
      } finally {
        writing = false;
      }
    },
    heartbeat() {
      if (writing || res.destroyed || res.writableEnded) return true;
      if (res.writableLength + Buffer.byteLength(heartbeat) > 1024 * 1024)
        return false;
      res.write(heartbeat);
      return true;
    },
    last(payload) {
      if (
        !res.destroyed &&
        res.writableLength + Buffer.byteLength(payload) <= 1024 * 1024
      )
        res.write(payload);
    },
    end(graceful) {
      res.end();
      if (!graceful && res.writableLength > 0) res.destroy();
    },
    onClose: (callback) => void res.once('close', callback),
  };
}
