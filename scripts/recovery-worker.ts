import {
  recoveryWorker,
  type RecoveryScenario,
} from '../apps/server/src/recovery.js';
await recoveryWorker(
  process.argv[2],
  process.argv[3] as RecoveryScenario,
  process.argv[4] as 'crash' | 'resume',
  (value) => {
    process.send?.(value);
  },
);
