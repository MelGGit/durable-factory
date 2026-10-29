import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// A real pseudo-terminal verifies both readline's raw-mode handling and echo suppression.
const driver = String.raw`
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], '--import', 'tsx', sys.argv[2], sys.argv[3]], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
deadline = time.monotonic() + 15
def wait_for(needle):
    global output
    while needle not in output:
        if time.monotonic() > deadline: raise RuntimeError('Terminal fixture timed out')
        if select.select([master], [], [], .1)[0]:
            try: data = os.read(master, 65536)
            except OSError: data = b''
            if not data: raise RuntimeError('Terminal fixture ended early: ' + output.decode(errors='replace'))
            output += data
try:
    wait_for(b'Choose a sign-in method: ')
    if sys.argv[4] == 'cancel':
        os.write(master, b'\x03')
    elif sys.argv[4] == 'eof':
        os.write(master, b'\x04')
    else:
        os.write(master, b'wrong\r')
        wait_for(b'Choose an option number or ID')
        os.write(master, b'\r')
        wait_for(b'Paste the authorization code or final redirect URL: ')
        os.write(master, b'sentinel-manual-code\r')
    wait_for(b'credentials stored securely.' if sys.argv[4] == 'success' else b'Terminal sign-in cancelled.')
    result = child.wait(timeout=5)
    assert result == (0 if sys.argv[4] == 'success' else 1)
    assert b'sentinel-manual-code' not in output, 'Authorization code was echoed'
    assert b'sentinel-terminal-' not in output, 'OAuth tokens were printed'
    print('Fake terminal flow verified')
finally:
    if child.poll() is None: child.kill()
    child.wait()
    os.close(master)
`;
for (const mode of ['success', 'cancel', 'eof']) {
  test(
    `terminal OAuth ${mode} uses fake credentials and suppresses authorization-code echo`,
    { timeout: 25000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'terminal-oauth-'));
      try {
        const result = await promisify(execFile)(
          'python3',
          [
            '-c',
            driver,
            process.execPath,
            resolve('tests/helpers/oauth-terminal-worker.ts'),
            directory,
            mode,
          ],
          { timeout: 22000 },
        );
        assert.match(result.stdout, /Fake terminal flow verified/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
