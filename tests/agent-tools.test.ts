import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from './fixtures/chat.js';
import { realFixture } from './fixtures/real.js';
import { AgentOperations } from '../apps/server/src/real-workflow.js';
import { context } from '../apps/server/src/storage.js';

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

test('a transient provider failure is retried instead of pausing the run', async () => {
  const f = await realFixture({
    transientFailures: 2,
    retry: { maxRetries: 3, baseDelayMs: 10 },
  });
  try {
    const run = await finish(f, 'transient');
    assert.equal(run.status, 'pr_ready', JSON.stringify(run.attempts));
    assert.equal(run.repairCount, 0);
    assert.equal(run.attempts.filter((a) => a.stage === 'developer').length, 1);
  } finally {
    await f.close();
  }
});

test('without a retry budget the same failure pauses the run', async () => {
  const f = await realFixture({ transientFailures: 1 });
  try {
    assert.equal((await finish(f, 'no-retry')).status, 'needs_input');
  } finally {
    await f.close();
  }
});

test('a forgotten implementation report is requested again before the user is asked', async () => {
  const f = await realFixture({ forgetReport: 1 });
  try {
    const run = await finish(f, 'nudge');
    assert.equal(run.status, 'pr_ready', JSON.stringify(run.attempts));
    assert.equal(run.implementations?.length, 1);
    assert.deepEqual(f.finals, ['developer']);
    assert.equal(run.attempts.filter((a) => a.stage === 'developer').length, 1);
  } finally {
    await f.close();
  }
});

test('the reminder limit survives a restart and then the user is asked', async () => {
  const f = await realFixture({ forgetReport: 9 });
  try {
    const run = await finish(f, 'nudge-limit', 'never');
    assert.equal(run.status, 'needs_input');
    assert.match(
      run.attempts.find((a) => a.stage === 'developer')!.message ?? '',
      /valid implementation report/,
    );
    // The first stop plus two reminders, each answered without a report.
    assert.equal(f.finals.filter((r) => r === 'developer').length, 3);
    await f.restart();
    const op = (await f.service.workflow['harness'].snapshot(
      AgentOperations,
      context,
    ))!.items[run.attempts.find((a) => a.stage === 'developer')!.id];
    assert.equal(op.nudges, 2);
  } finally {
    await f.close();
  }
});

test('a submission ends the run at the handoff', async () => {
  const f = await realFixture();
  try {
    assert.equal((await finish(f, 'terminate')).status, 'pr_ready');
    assert.deepEqual(f.finals, []);
  } finally {
    await f.close();
  }
});

test('run_required_checks shows output to the developer and records no evidence', async () => {
  const f = await realFixture({
    checkCommand: 'echo SELF-FAIL-9 >&2; exit 4',
    developerCalls: [{ name: 'run_required_checks', args: {} }],
  });
  try {
    const started = await f.client.startIssue(7, 'self-check');
    const run = await until(
      () => f.client.run(started.id),
      (r) => [...r.evidence, ...(r.evidenceHistory ?? [])].length > 0,
      30000,
    );
    const [result] = f.seen.filter((r) => r.toolName === 'run_required_checks');
    assert.equal(result.isError, true);
    assert.match(result.text, /FAILED check: echo SELF-FAIL-9/);
    assert.match(result.text, /SELF-FAIL-9/);
    assert.match(result.text, /exit code 4/);
    for (const evidence of [...run.evidence, ...(run.evidenceHistory ?? [])])
      assert.doesNotMatch(JSON.stringify(evidence), /selfcheck/);
    assert.match(f.prompts[0].text, /"requiredChecks":\["echo SELF-FAIL-9/);
  } finally {
    await f.close();
  }
});
