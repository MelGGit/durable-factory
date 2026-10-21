import { acquireOwnership } from '../apps/server/src/runtime.js';
import { openConfiguration } from '../apps/server/src/storage.js';
const owner = await acquireOwnership(process.argv[2]);
const configuration = await openConfiguration(owner.dataDir);
process.send?.({ phase: 'ready' });
process.on('message', async (command) => {
  if (command === 'stall') {
    process.send?.({ phase: 'stalled' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
    const state = await configuration.read();
    state.settings.repository.github = 'original-owner/after-stall';
    await configuration.save(state.revision, state.settings);
    process.send?.({ phase: 'saved' });
  }
  if (command === 'close') {
    await configuration.close();
    await owner.release();
    process.exit(0);
  }
});
