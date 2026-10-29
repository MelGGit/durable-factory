import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startService } from './helpers/credentials.js';

test(
  'shutdown closes a speculative connection after draining accepted actions',
  { timeout: 5000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-shutdown-'));
    const service = await startService({ dataDir, port: 0 });
    const accepted = once(service.server, 'connection');
    const socket = connect(service.port, '127.0.0.1');
    const connected = once(socket, 'connect');
    try {
      await Promise.all([accepted, connected]);
      const closed = once(socket, 'close');
      await service.close();
      await closed;
      assert.equal(service.server.listening, false);
    } finally {
      socket.destroy();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
