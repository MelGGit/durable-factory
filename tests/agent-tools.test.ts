import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from './fixtures/chat.js';
import { realFixture } from './fixtures/real.js';

type Fixture = Awaited<ReturnType<typeof realFixture>>;
async function finish(f: Fixture, id: string, status = 'pr_ready') {
  const started = await f.client.startIssue(7, id);
  return until(
    () => f.client.run(started.id),
    (r) => [status, 'needs_input', 'termination_blocker'].includes(r.status),
    30000,
  );
}
const artifactOf = (text: string) =>
  /command artifact ([^;\]\s]+)/.exec(text)![1];

test('the developer sees command output and a nonzero exit is an error result', async () => {
  const f = await realFixture({
    developerCalls: [
      {
        name: 'worktree_command',
        args: { command: 'echo out-line; echo err-line >&2; exit 3' },
      },
      { name: 'worktree_command', args: { command: 'echo fine' } },
    ],
  });
  try {
    assert.equal((await finish(f, 'command-output')).status, 'pr_ready');
    const [failed, passed] = f.seen.filter(
      (r) => r.toolName === 'worktree_command',
    );
    assert.equal(failed.isError, true);
    assert.match(failed.text, /out-line/);
    assert.match(failed.text, /err-line/);
    assert.match(failed.text, /exit code 3/);
    assert.match(failed.text, /command artifact \S+/);
    assert.equal(passed.isError, false);
    assert.match(passed.text, /^fine\n\[exit code 0;/);
  } finally {
    await f.close();
  }
});

test('check_output pages and searches a stored command log and rejects unknown artifacts', async () => {
  const id = (results: { text: string }[]) => artifactOf(results[0].text);
  const f = await realFixture({
    developerCalls: [
      { name: 'worktree_command', args: { command: 'seq 1 300' } },
      {
        name: 'check_output',
        args: (r) => ({ artifact: id(r), lines: 3 }),
      },
      {
        name: 'check_output',
        args: (r) => ({
          artifact: id(r),
          mode: 'range',
          startLine: 10,
          endLine: 12,
        }),
      },
      {
        name: 'check_output',
        args: (r) => ({
          artifact: id(r),
          mode: 'grep',
          pattern: '^29[0-9]$',
          context: 1,
          maxMatches: 4,
        }),
      },
      { name: 'check_output', args: { artifact: '../../etc/passwd' } },
      { name: 'check_output', args: {} },
      {
        name: 'check_output',
        args: (r) => ({ artifact: id(r), mode: 'grep', pattern: '(' }),
      },
    ],
  });
  try {
    assert.equal((await finish(f, 'check-output')).status, 'pr_ready');
    const [tail, range, grep, unknown, list, invalid] = f.seen.filter(
      (r) => r.toolName === 'check_output',
    );
    assert.match(tail.text, /^298\t298\n299\t299\n300\t300\n\[/);
    assert.match(tail.text, /lines 298-300 of 300; read earlier lines/);
    assert.equal(range.text.split('\n')[0], '10\t10');
    assert.match(range.text, /lines 10-12 of 300; continue with startLine=13/);
    assert.match(grep.text, /290\t290/);
    assert.match(grep.text, /4 match\(es\)|10 match\(es\)/);
    assert.match(grep.text, /showing the first 4/);
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Unknown artifact/);
    assert.match(list.text, /seq 1 300/);
    assert.equal(invalid.isError, true);
    assert.match(invalid.text, /Invalid regular expression/);
  } finally {
    await f.close();
  }
});

test('a repair attempt starts with the failing check output', async () => {
  const f = await realFixture({
    checkCommand: 'echo MARKER-FAIL-42 >&2; exit 2',
  });
  try {
    const started = await f.client.startIssue(7, 'repair-tail');
    const run = await until(
      () => f.client.run(started.id),
      (r) =>
        r.attempts.filter((a) => a.stage === 'developer').length >= 2 ||
        r.status === 'needs_input',
      30000,
    );
    assert.ok(f.prompts.filter((p) => p.role === 'developer').length >= 2);
    const [, repair] = f.prompts.filter((p) => p.role === 'developer');
    assert.match(repair.text, /MARKER-FAIL-42/);
    assert.match(repair.text, /Failed: echo MARKER-FAIL-42/);
    const checks = [...run.evidence, ...(run.evidenceHistory ?? [])].find(
      (e) => e.kind === 'checks',
    )!;
    assert.match(checks.output, /MARKER-FAIL-42/);
    assert.match(checks.output, /-check-0 ---/);
  } finally {
    await f.close();
  }
});
