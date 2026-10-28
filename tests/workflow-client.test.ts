import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowReducer,
  type WorkflowFrame,
} from '../packages/shared/src/index.js';
test('workflow stream reducer deduplicates updates, rejects gaps/version mismatches and accepts reconnect snapshots', () => {
  const reducer = new WorkflowReducer();
  const frame: WorkflowFrame = {
    apiVersion: 'v1',
    streamId: 'stream-a',
    sequence: 1,
    type: 'snapshot',
    snapshot: {
      mode: 'simulation',
      enabled: true,
      revision: 1,
      runners: 1,
      slots: [],
      runs: [],
    },
  };
  assert.equal(reducer.apply(frame), true);
  assert.equal(reducer.apply(frame), false);
  assert.throws(
    () => reducer.apply({ ...frame, type: 'update', sequence: 3 }),
    /fresh snapshot/,
  );
  assert.equal(reducer.apply({ ...frame, type: 'update', sequence: 2 }), true);
  assert.equal(reducer.apply({ ...frame, streamId: 'stream-b' }), true);
  assert.throws(
    () => reducer.apply({ ...frame, apiVersion: 'v2' as never }),
    /Reload/,
  );
});
