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

test('deletes and renames are changed files and both rename paths are reported', async () => {
  const f = await realFixture({
    baselineFiles: { 'legacy.txt': 'old\n', 'obsolete.txt': 'gone\n' },
    scopeNote: 'Rename legacy.txt to renamed.txt and remove obsolete.txt.',
    developerCalls: [
      {
        name: 'worktree_move',
        args: { from: 'legacy.txt', to: 'renamed.txt' },
      },
      { name: 'worktree_delete', args: { path: 'obsolete.txt' } },
      { name: 'worktree_move', args: { from: '../x', to: 'y' } },
      { name: 'worktree_delete', args: { path: '/etc/passwd' } },
    ],
  });
  try {
    const run = await finish(f, 'delete-move');
    assert.equal(run.status, 'pr_ready', JSON.stringify(run.attempts));
    assert.deepEqual(run.implementations![0].changedFiles, [
      'generated/result.txt',
      'legacy.txt',
      'obsolete.txt',
      'renamed.txt',
      'value.txt',
    ]);
    const tree = f
      .git(f.remote, ['ls-tree', '-r', '--name-only', run.workspace!.branch])
      .split('\n');
    assert.ok(tree.includes('renamed.txt'));
    assert.ok(!tree.includes('legacy.txt') && !tree.includes('obsolete.txt'));
    const [moved, deleted, escapedMove, escapedDelete] = f.seen.filter(
      (r) => r.role === 'developer' && /move|delete/.test(r.toolName),
    );
    assert.equal(moved.isError, false);
    assert.equal(deleted.isError, false);
    assert.equal(escapedMove.isError, true);
    assert.match(escapedMove.text, /relative path inside the repository/);
    assert.equal(escapedDelete.isError, true);
  } finally {
    await f.close();
  }
});

test('both roles search, find, read and diff; the reviewer sees the candidate tree', async () => {
  const f = await realFixture({
    developerCalls: [
      { name: 'worktree_find', args: { glob: '*.txt' } },
      { name: 'worktree_search', args: { pattern: 'baseline' } },
      {
        name: 'worktree_edit',
        args: {
          path: 'value.txt',
          edits: [{ before: 'baseline', after: 'draft' }],
        },
      },
      { name: 'worktree_read', args: { path: 'value.txt', revision: 'base' } },
    ],
    reviewerCalls: [
      { name: 'worktree_search', args: { pattern: 'implemented' } },
      { name: 'worktree_find', args: { glob: '**' } },
      { name: 'worktree_diff', args: { mode: 'stat' } },
      {
        name: 'worktree_read',
        args: { path: 'value.txt', revision: 'base', startLine: 1 },
      },
      { name: 'check_output', args: {} },
    ],
  });
  try {
    assert.equal((await finish(f, 'both-roles')).status, 'pr_ready');
    const of = (role: string, tool: string) =>
      f.seen.find((r) => r.role === role && r.toolName === tool)!;
    assert.match(of('developer', 'worktree_find').text, /value\.txt/);
    assert.match(
      of('developer', 'worktree_search').text,
      /value\.txt:1:baseline/,
    );
    assert.match(of('developer', 'worktree_edit').text, /1 replacement/);
    assert.match(of('developer', 'worktree_read').text, /baseline/);
    assert.match(
      of('reviewer', 'worktree_search').text,
      /value\.txt:1:implemented/,
    );
    assert.match(
      of('reviewer', 'worktree_find').text,
      /generated\/result\.txt/,
    );
    assert.match(of('reviewer', 'worktree_diff').text, /value\.txt/);
    assert.match(of('reviewer', 'worktree_read').text, /1\tbaseline/);
    assert.equal(of('reviewer', 'check_output').isError, false);
  } finally {
    await f.close();
  }
});

test('answering an unrelated question does not approve a change beyond the ticket', async () => {
  const f = await realFixture({
    extraFile: 'notes.md',
    ask: { question: 'Which style do you prefer?' },
    declareOutOfScope: ['notes.md: extra notes'],
  });
  try {
    const run = await answered(f, 'unrelated-answer');
    assert.equal(run.status, 'needs_input');
    assert.match(rejection(f), /has not approved changing: notes\.md/);
    assert.equal(
      run.attempts.some((a) => a.stage === 'checks'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('an approved change passes while an unapproved one in the same report does not', async () => {
  const outOfScope = { change: 'Add notes', paths: ['notes.md'] };
  const declared = ['notes.md: Add notes', 'extra.md: another note'];
  const f = await realFixture({
    extraFile: ['notes.md', 'extra.md'],
    ask: { question: 'May I add notes?', outOfScope },
    declareOutOfScope: declared,
  });
  const g = await realFixture({
    extraFile: 'notes.md',
    ask: { question: 'May I add notes?', outOfScope },
    declareOutOfScope: [declared[0]],
  });
  try {
    const refused = await answered(f, 'approve-partly');
    assert.equal(refused.status, 'needs_input');
    assert.match(rejection(f), /has not approved changing: extra\.md/);
    const run = await answered(g, 'approve-notes', 'pr_ready');
    assert.equal(run.status, 'pr_ready', JSON.stringify(run.attempts));
    assert.deepEqual(run.interventions[0].outOfScope, outOfScope);
  } finally {
    await f.close();
    await g.close();
  }
});

/** What the report check last told the developer. */
const rejection = (f: Fixture) =>
  f.seen
    .filter((r) => r.toolName === 'submit_implementation' && r.isError)
    .at(-1)!.text;

/** Run until the developer asks, answer, and run on until the run settles again. */
async function answered(f: Fixture, id: string, status = 'needs_input') {
  const started = await f.client.startIssue(7, id);
  let run = await until(
    () => f.client.run(started.id),
    (r) => r.interventions.some((i) => i.state === 'pending'),
    30000,
  );
  const question = run.interventions.find((i) => i.state === 'pending')!;
  run = await f.client.command(run.id, {
    action: 'answer',
    operationId: `${id}-answer`,
    expectedRevision: run.revision,
    interventionId: question.id,
    interventionRevision: question.revision,
    answer: 'Yes, go ahead.',
  });
  return until(
    () => f.client.run(started.id),
    (r) =>
      r.status === status ||
      (r.interventions.filter((i) => i.state === 'pending').length > 0 &&
        r.interventions.length > 1),
    30000,
  );
}
