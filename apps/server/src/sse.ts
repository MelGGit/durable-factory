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
