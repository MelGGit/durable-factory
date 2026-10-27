import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { writeSse } from '../apps/server/src/sse.js';

test('large batches and transcript snapshots drain without exceeding the socket ceiling or corrupting UTF-8', async () => {
  const emitter = new EventEmitter();
  const packets: Buffer[] = [];
  const response = Object.assign(emitter, {
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    write(packet: string | Uint8Array) {
      packets.push(Buffer.from(packet));
      response.writableLength += Buffer.byteLength(packet);
      assert.ok(response.writableLength <= 1024 * 1024);
      setImmediate(() => {
        response.writableLength = 0;
        response.emit('drain');
      });
      return false;
    },
  });
  const batch = `data: ${'x'.repeat(200000)}\n\n`.repeat(8);
  assert.equal(
    await writeSse(response as unknown as ServerResponse, batch),
    true,
  );
  assert.equal(Buffer.concat(packets).toString(), batch);
  packets.length = 0;
  const snapshot = `data: ${JSON.stringify({ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'large', role: 'assistant', content: '😀'.repeat(400000) }] })}\n\n`;
  assert.equal(
    await writeSse(response as unknown as ServerResponse, snapshot),
    true,
  );
  assert.equal(Buffer.concat(packets).toString(), snapshot);
  assert.equal(response.listenerCount('drain'), 0);
});

test('a disconnected or stalled consumer releases the SSE drain wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    write: () => false,
  });
  const disconnected = writeSse(
    response as unknown as ServerResponse,
    'data: {}\n\n',
  );
  response.emit('close');
  assert.equal(await disconnected, false);
  const stalled = writeSse(
    response as unknown as ServerResponse,
    'data: {}\n\n',
  );
  t.mock.timers.tick(45000);
  assert.equal(await stalled, false);
  assert.equal(response.listenerCount('close'), 0);
  assert.equal(response.listenerCount('drain'), 0);
});
