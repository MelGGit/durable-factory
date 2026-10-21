import { spawn } from 'node:child_process';
const children = [
  spawn('node', ['--import', 'tsx', '--watch', 'apps/server/src/main.ts'], {
    stdio: 'inherit',
  }),
  spawn('bun', ['run', '--cwd', 'apps/web', 'dev'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', (code) => stop(code ?? 1));
}
