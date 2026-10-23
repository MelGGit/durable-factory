import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type WorkflowRun,
  type RunAction,
} from '../packages/shared/src/index.js';
import {
  simulationAdapter,
  type StageResult,
  type WorkflowClock,
} from '../apps/server/src/workflow.js';
import { until } from './fixtures/chat.js';

import { workflowFixture } from './fixtures/workflow.js';

async function command(
  s: Awaited<ReturnType<typeof workflowFixture>>,
  run: WorkflowRun,
  action: RunAction,
  extra = {},
) {
  return s.client.command(run.id, {
    action,
    operationId: crypto.randomUUID(),
    expectedRevision: run.revision,
    ...extra,
  });
}

test('simulation completes durable Pi stages and deduplicates admission, with captured settings and independent review', async () => {
  const s = await workflowFixture();
  try {
    const id = await s.issue();
    const [a, b] = await Promise.all([
      s.client.startRun(id, 'start-a'),
      s.client.startRun(id, 'start-b'),
    ]);
    assert.equal(a.id, b.id);
    const run = await until(
      () => s.client.run(a.id),
      (r) => r.status === 'pr_ready',
    );
    assert.equal(run.attempts.length, 7);
    assert.equal(run.repairCount, 0);
    assert.deepEqual(
      run.attempts.map((a) => a.stage),
      [
        'setup',
        'baseline',
        'developer',
        'checks',
        'reviewer',
        'publication',
        'publishing',
      ],
    );
    assert.notEqual(
      run.attempts.find((a) => a.stage === 'reviewer')!.conversationId,
      run.developerConversationId,
    );
    assert.match(run.publication!.result!, /Simulated PR/);
    assert.equal((await s.client.workflow()).slot, undefined);
    assert.equal((await s.client.startRun(id, 'start-c')).id, run.id);
    await assert.rejects(
      s.chat.submit(run.developerConversationId, 'late edit', 'late'),
      /closed/,
    );
    await assert.rejects(
      s.chat.submit(
        run.attempts.find((a) => a.stage === 'reviewer')!.conversationId,
        'edit',
        'review-input',
      ),
      /Reviewer/,
    );
    const next = await s.client.startRun(id, 'explicit-new', true);
    assert.notEqual(next.id, run.id);
    await s.restart();
    assert.equal((await s.client.run(run.id)).status, 'pr_ready');
  } finally {
    await s.close();
  }
});

test('failed checks consume three repairs and explicit continuation grants exactly one', async () => {
  const adapter = simulationAdapter();
  const execute = adapter.execute;
  adapter.execute = async (run, attempt, signal) =>
    attempt.stage === 'checks'
      ? { outcome: 'failed', message: 'Required check failed' }
      : execute(run, attempt, signal);
  const s = await workflowFixture(adapter);
  try {
    const admitted = await s.service.workflow.admit({
      conversationId: await s.issue(),
      operationId: 'start',
    });
    let run = await until(
      () => s.client.run(admitted.id),
      (r) => r.status === 'needs_input',
    );
    assert.equal(run.repairCount, 3);
    assert.equal(run.attempts.filter((a) => a.stage === 'checks').length, 4);
    assert.equal(run.attempts.filter((a) => a.stage === 'reviewer').length, 0);
    const pending = run.interventions.find((i) => i.state === 'pending')!;
    assert.equal(pending.reason, 'repair_exhausted');
    await assert.rejects(command(s, run, 'resume'), /pending/);
    await command(s, run, 'continue');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.status === 'needs_input',
    );
    assert.equal(run.repairCount, 4);
    assert.equal(run.repairLimit, 4);
  } finally {
    await s.close();
  }
});

test('durable question answers reject stale/conflicting replies and duplicate answer never resumes twice', async () => {
  const adapter = simulationAdapter();
  const execute = adapter.execute;
  let asked = false;
  adapter.execute = async (run, attempt, signal) => {
    if (attempt.stage === 'developer' && !asked) {
      asked = true;
      return { outcome: 'needs_input', message: 'Which behavior?' };
    }
    return execute(run, attempt, signal);
  };
  const s = await workflowFixture(adapter);
  try {
    const initial = await s.service.workflow.admit({
      conversationId: await s.issue(),
      operationId: 'start',
    });
    const run = await until(
      () => s.client.run(initial.id),
      (r) => r.status === 'needs_input',
    );
    const question = run.interventions[0];
    await s.restart();
    assert.equal((await s.client.run(run.id)).interventions[0].id, question.id);
    const current = await s.client.run(run.id);
    const answer = {
      operationId: 'answer',
      expectedRevision: current.revision,
      action: 'answer' as const,
      interventionId: question.id,
      interventionRevision: question.revision,
      answer: 'Use the default.',
    };
    await s.client.command(run.id, answer);
    await s.client.command(run.id, answer);
    await assert.rejects(
      s.client.command(run.id, {
        ...answer,
        operationId: 'other',
        answer: 'Something else',
      }),
      /changed|answered/,
    );
    const ready = await until(
      () => s.client.run(run.id),
      (r) => r.status === 'pr_ready',
    );
    assert.equal(ready.repairCount, 0);
  } finally {
    await s.close();
  }
});

function controlledAdapter(stage: string = 'developer') {
  const adapter = simulationAdapter();
  const waiting = new Map<string, (result: StageResult) => void>();
  adapter.execute = async (run, attempt) => {
    if (attempt.stage === stage)
      return new Promise<StageResult>((resolve) =>
        waiting.set(run.id, resolve),
      );
    return {
      outcome: 'passed',
      message: `Simulated ${attempt.stage}`,
      ...(attempt.stage === 'reviewer' ? { verdict: 'pass' as const } : {}),
      ...(attempt.stage === 'publishing'
        ? { publicationResult: 'Simulated PR' }
        : {}),
    };
  };
  return { adapter, waiting };
}

test('FIFO slot stays blocked after unconfirmed cancellation; late results cannot advance cancelled work', async () => {
  const { adapter, waiting } = controlledAdapter();
  let confirmed = false;
  adapter.cancel = async () => confirmed;
  adapter.reconcile = async () => ({ quiescent: confirmed });
  const s = await workflowFixture(adapter);
  try {
    const one = await s.issue('one'),
      two = await s.issue('two');
    let a = await s.client.startRun(one, 'start-one');
    a = await until(
      () => s.client.run(a.id),
      (r) => r.stage === 'developer',
    );
    const b = await s.client.startRun(two, 'start-two');
    assert.equal(b.status, 'queued');
    a = await command(s, await s.client.run(a.id), 'cancel');
    assert.equal(a.status, 'termination_blocker');
    assert.equal((await s.client.workflow()).slot, a.id);
    assert.equal((await s.client.run(b.id)).status, 'queued');
    waiting.get(a.id)!({
      outcome: 'passed',
      message: 'late developer response',
      source: 'late-tree',
    });
    assert.equal((await s.client.run(a.id)).status, 'termination_blocker');
    confirmed = true;
    a = await command(s, await s.client.run(a.id), 'reconcile');
    assert.equal(a.status, 'cancelled');
    await until(
      () => s.client.run(b.id),
      (r) => r.stage === 'developer',
    );
    assert.equal((await s.client.workflow()).slot, b.id);
    assert.equal(
      (await s.client.run(a.id)).attempts.filter((a) => a.stage === 'checks')
        .length,
      0,
    );
  } finally {
    confirmed = true;
    await s.close();
  }
});

test('settings are captured, adoption invalidates evidence, setup is repeated, and pause resumes the same attempt', async () => {
  const { adapter } = controlledAdapter('checks');
  const s = await workflowFixture(adapter);
  try {
    let run = await s.client.startRun(await s.issue(), 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.stage === 'checks',
    );
    const firstAttempt = run.attempts.at(-1)!.id;
    const saved = await s.chat.settings();
    saved.settings.setupCommands = ['simulated setup'];
    saved.settings.requiredChecks = ['simulated new checks'];
    await s.chat.saveSettings({
      expectedRevision: saved.revision,
      settings: saved.settings,
    });
    assert.deepEqual(
      (await s.client.run(run.id)).configuration.requiredChecks,
      ['fake test'],
    );
    run = await command(s, run, 'pause');
    assert.equal(run.status, 'paused');
    run = await command(s, run, 'resume');
    assert.equal(run.attempts.at(-1)!.id, firstAttempt);
    run = await command(s, await s.client.run(run.id), 'pause');
    run = await command(s, run, 'adopt_configuration');
    assert.deepEqual(run.configuration.requiredChecks, [
      'simulated new checks',
    ]);
    assert.equal(run.evidence.length, 0);
    assert.equal(run.stage, 'setup');
    await command(s, run, 'resume');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.stage === 'checks' && r.status === 'running',
    );
    assert.equal(run.attempts.filter((a) => a.stage === 'setup').length, 2);
    assert.equal(run.attempts.filter((a) => a.stage === 'baseline').length, 2);
    assert.equal(run.repairCount, 0);
  } finally {
    await s.close();
  }
});

test('guidance during checks returns through development without bypassing failure repair accounting; withdrawal prevents delivery', async () => {
  const { adapter, waiting } = controlledAdapter('checks');
  const s = await workflowFixture(adapter);
  try {
    let run = await s.client.startRun(await s.issue(), 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.stage === 'checks',
    );
    const withdrawn = await s.chat.submit(
      run.developerConversationId,
      'Withdraw me',
      'withdraw',
    );
    await s.chat.withdraw(run.developerConversationId, withdrawn.id);
    await s.chat.submit(
      run.developerConversationId,
      'New guidance',
      'guidance',
      'steer',
    );
    waiting.get(run.id)!({
      outcome: 'failed',
      message: 'Fail with pending guidance',
    });
    run = await until(
      () => s.client.run(run.id),
      (r) => r.repairCount === 1 && r.stage === 'checks',
    );
    assert.equal(
      run.inputs.find((i) => i.requestId === 'withdraw')!.status,
      'withdrawn',
    );
    assert.equal(
      run.inputs.find((i) => i.requestId === 'guidance')!.status,
      'consumed',
    );
    assert.equal(
      (await s.chat.submission(run.developerConversationId, 'guidance')).status,
      'completed',
    );
    await assert.rejects(
      s.chat.withdraw(
        run.developerConversationId,
        run.inputs.find((i) => i.requestId === 'guidance')!.submissionId,
      ),
      /consumed/,
    );
    waiting.get(run.id)!({ outcome: 'passed', message: 'Pass' });
    const ready = await until(
      () => s.client.run(run.id),
      (r) => r.status === 'pr_ready',
    );
    assert.equal(ready.repairCount, 1);
  } finally {
    await s.close();
  }
});

test('review rejection repairs with fresh review; malformed verdict and baseline failure require input', async () => {
  for (const scenario of ['reject', 'malformed', 'baseline'] as const) {
    const adapter = simulationAdapter();
    let reviews = 0;
    adapter.execute = async (_run, attempt) => {
      if (attempt.stage === 'baseline' && scenario === 'baseline')
        return { outcome: 'failed', message: 'Pre-existing test failure' };
      if (attempt.stage === 'reviewer') {
        if (scenario === 'malformed')
          return { outcome: 'passed', message: 'Unstructured approval' };
        if (reviews++ === 0)
          return {
            outcome: 'failed',
            verdict: 'changes_requested',
            message: 'Fix acceptance behavior',
          };
        return { outcome: 'passed', verdict: 'pass', message: 'Reviewed' };
      }
      return {
        outcome: 'passed',
        message: 'Passed',
        ...(attempt.stage === 'publishing'
          ? { publicationResult: 'Simulated PR' }
          : {}),
      };
    };
    const s = await workflowFixture(adapter);
    try {
      const start = await s.client.startRun(await s.issue(), 'start');
      const run = await until(
        () => s.client.run(start.id),
        (r) => ['needs_input', 'pr_ready'].includes(r.status),
      );
      if (scenario === 'reject') {
        assert.equal(run.status, 'pr_ready');
        assert.equal(run.repairCount, 1);
        const ids = run.attempts
          .filter((a) => a.stage === 'reviewer')
          .map((a) => a.conversationId);
        assert.equal(new Set(ids).size, 2);
      } else {
        assert.equal(run.status, 'needs_input');
        assert.equal(run.publication, undefined);
        assert.equal(run.repairCount, 0);
      }
    } finally {
      await s.close();
    }
  }
});

test('explicit planning chat start uses shared admission and unapproved tool calls cannot start a run', async () => {
  const s = await workflowFixture();
  try {
    const id = await s.issue();
    await s.chat.submit(id, 'force start', 'force-start');
    await until(
      () => s.chat.submission(id, 'force-start'),
      (s) => s.status === 'completed',
    );
    assert.equal((await s.client.workflow()).runs.length, 0);
    await s.chat.submit(id, 'start implementation', 'authorized-start');
    await until(
      () => s.chat.submission(id, 'authorized-start'),
      (s) => s.status === 'completed',
    );
    const snapshot = await s.client.workflow();
    assert.equal(snapshot.runs.length, 1);
    assert.equal(
      (await s.client.startRun(id, 'manual-start')).id,
      snapshot.runs[0].id,
    );
  } finally {
    await s.close();
  }
});

class ManualClock implements WorkflowClock {
  time = 1000;
  timers = new Set<{ at: number; callback: () => void }>();
  now() {
    return this.time;
  }
  timer(callback: () => void, ms: number) {
    const item = { at: this.time + Math.max(0, ms), callback };
    this.timers.add(item);
    return () => {
      this.timers.delete(item);
    };
  }
  advance(ms: number) {
    this.time += ms;
    for (const item of [...this.timers])
      if (item.at <= this.time) {
        this.timers.delete(item);
        item.callback();
      }
  }
}

test('deterministic deadline fences late provider results; human-answer waits have no active deadline', async () => {
  const { adapter, waiting } = controlledAdapter();
  const clock = new ManualClock();
  const s = await workflowFixture(adapter, clock);
  try {
    let run = await s.client.startRun(await s.issue(), 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.stage === 'developer',
    );
    await until(async () => waiting.has(run.id), Boolean);
    clock.advance(run.configuration.timeouts.provider * 1000 + 1);
    run = await until(
      () => s.client.run(run.id),
      (r) => r.status === 'needs_input',
    );
    assert.match(run.interventions[0].question, /Deadline/);
    assert.equal((await s.client.workflow()).slot, undefined);
    waiting.get(run.id)!({
      outcome: 'passed',
      message: 'late',
      source: 'late-tree',
    });
    clock.advance(999999999);
    assert.equal((await s.client.run(run.id)).status, 'needs_input');
    assert.equal((await s.client.run(run.id)).repairCount, 0);
  } finally {
    await s.close();
  }
});

test('source and base changes invalidate validation; publication admission resolves pending guidance atomically', async () => {
  const { adapter, waiting } = controlledAdapter('publication');
  let changed = false;
  adapter.inspect = async (run) => {
    if (run.stage === 'reviewer' && !changed) {
      changed = true;
      return {
        source: 'generated-file-tree',
        base: 'updated-base',
        quiescent: true,
      };
    }
    return { source: run.source, base: run.currentBase, quiescent: true };
  };
  const s = await workflowFixture(adapter);
  try {
    let run = await s.client.startRun(await s.issue(), 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.stage === 'publication',
    );
    assert.equal(run.source, 'generated-file-tree');
    assert.equal(run.base, 'updated-base');
    assert.equal(run.attempts.filter((a) => a.stage === 'checks').length, 2);
    assert.equal(run.repairCount, 0);
    await s.chat.submit(
      run.developerConversationId,
      'Before publication',
      'before',
    );
    const count = run.attempts.length;
    waiting.get(run.id)!({ outcome: 'passed', message: 'Admission inspected' });
    run = await until(
      () => s.client.run(run.id),
      (r) => r.stage === 'publication' && r.attempts.length > count,
    );
    assert.equal(run.inputs[0].status, 'consumed');
    waiting.get(run.id)!({ outcome: 'passed', message: 'Admission inspected' });
    run = await until(
      () => s.client.run(run.id),
      (r) => r.status === 'pr_ready',
    );
    await assert.rejects(
      s.chat.submit(run.developerConversationId, 'After publication', 'after'),
      /closed/,
    );
  } finally {
    await s.close();
  }
});

test('ambiguous publication stays pending; reconciliation records one result and late cancelled publication is retained', async () => {
  const adapter = simulationAdapter();
  const execute = adapter.execute;
  let effects = 0;
  adapter.execute = async (run, attempt, signal) => {
    if (attempt.stage === 'publishing') {
      effects++;
      return { outcome: 'uncertain', message: 'Publication response lost' };
    }
    return execute(run, attempt, signal);
  };
  adapter.reconcile = async () => ({
    quiescent: true,
    publicationResult: effects ? 'Simulated reconciled PR' : undefined,
  });
  const s = await workflowFixture(adapter);
  try {
    let run = await s.client.startRun(await s.issue(), 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.status === 'needs_input',
    );
    await assert.rejects(command(s, run, 'resume'), /pending/);
    run = await command(s, run, 'reconcile');
    assert.equal(run.status, 'pr_ready');
    assert.equal(effects, 1);
  } finally {
    await s.close();
  }
  const controlled = controlledAdapter('publishing');
  const next = await workflowFixture(controlled.adapter);
  try {
    let run = await next.client.startRun(await next.issue(), 'start');
    run = await until(
      () => next.client.run(run.id),
      (r) => r.stage === 'publishing',
    );
    run = await command(next, run, 'cancel');
    assert.equal(run.status, 'cancelled');
    controlled.waiting.get(run.id)!({
      outcome: 'passed',
      message: 'Late external effect',
      publicationResult: 'Simulated late PR',
    });
    run = await until(
      () => next.client.run(run.id),
      (r) => r.publication?.state === 'confirmed',
    );
    assert.equal(run.status, 'cancelled');
  } finally {
    await next.close();
  }
});

test('normal mode rejects starts and incompatible recovery retains the slot until compatible inspection', async () => {
  const { adapter } = controlledAdapter();
  const s = await workflowFixture(adapter);
  try {
    const issue = await s.issue();
    let run = await s.client.startRun(issue, 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.stage === 'developer',
    );
    await s.restart(false);
    assert.equal((await s.client.workflow()).enabled, false);
    await assert.rejects(s.client.startRun(issue, 'disabled'), /unavailable/);
    // Graceful shutdown already confirmed quiescence; disabled mode preserves the paused run.
    assert.equal((await s.client.run(run.id)).status, 'paused');
    await s.restart(true);
    assert.equal((await s.client.run(run.id)).mode, 'simulation');
  } finally {
    await s.close();
  }
});

test('adopting specification and setup at exhaustion preserves budget and validates the adopted revision', async () => {
  const adapter = simulationAdapter();
  const execute = adapter.execute;
  adapter.execute = async (run, attempt, signal) =>
    attempt.stage === 'checks'
      ? { outcome: 'failed', message: 'Still failing' }
      : execute(run, attempt, signal);
  adapter.specification = async (run) => ({
    ...run.specification,
    revision: 2,
    goal: 'Explicitly updated goal',
  });
  const s = await workflowFixture(adapter);
  try {
    let run = await s.client.startRun(await s.issue(), 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.status === 'needs_input',
    );
    run = await command(s, run, 'adopt_specification');
    assert.equal(run.specification.goal, 'Explicitly updated goal');
    assert.equal(run.specificationRevision, 1);
    assert.equal(run.repairCount, 3);
    const saved = await s.chat.settings();
    saved.settings.setupCommands = ['updated setup'];
    await s.chat.saveSettings({
      expectedRevision: saved.revision,
      settings: saved.settings,
    });
    run = await command(s, run, 'adopt_configuration');
    assert.equal(run.stage, 'setup');
    await command(s, run, 'continue');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.status === 'needs_input',
    );
    assert.equal(run.repairCount, 4);
    assert.equal(run.attempts.filter((a) => a.stage === 'setup').length, 2);
    assert.ok(
      run.evidence.every(
        (e) =>
          e.specificationRevision === 1 &&
          e.configurationRevision === run.configurationRevision,
      ),
    );
  } finally {
    await s.close();
  }
});

test('bounded cancellation times out to a termination blocker and cannot release the slot', async () => {
  const { adapter, waiting } = controlledAdapter();
  const clock = new ManualClock();
  adapter.cancel = async () => new Promise(() => {});
  const s = await workflowFixture(adapter, clock);
  try {
    let run = await s.client.startRun(await s.issue(), 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.stage === 'developer',
    );
    await until(async () => waiting.has(run.id), Boolean);
    const cancelling = command(s, run, 'cancel');
    await until(
      () => s.client.run(run.id),
      (r) => r.status === 'cancelling',
    );
    clock.advance(run.configuration.timeouts.cancellation * 1000 + 1);
    run = await cancelling;
    assert.equal(run.status, 'termination_blocker');
    assert.equal((await s.client.workflow()).slot, run.id);
    adapter.reconcile = async () => ({ quiescent: true });
    run = await command(s, run, 'reconcile');
    assert.equal(run.status, 'cancelled');
  } finally {
    await s.close();
  }
});

test('publication content mismatch never becomes PR ready, including through reconciliation', async () => {
  const adapter = simulationAdapter();
  adapter.inspect = async (run) => ({
    source:
      run.stage === 'publishing' ? 'unexpected-committed-tree' : run.source,
    base: run.currentBase,
    quiescent: true,
  });
  adapter.reconcile = async () => ({
    quiescent: true,
    publicationResult: 'Simulated existing PR',
  });
  const s = await workflowFixture(adapter);
  try {
    let run = await s.client.startRun(await s.issue(), 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.status === 'needs_input',
    );
    assert.equal(run.stage, 'publishing');
    assert.equal(run.evidence.length, 0);
    run = await command(s, run, 'reconcile');
    assert.equal(run.status, 'needs_input');
  } finally {
    await s.close();
  }
});

test('provider failure pauses without repair or fallback; resumed work reacquires the serial slot', async () => {
  const { adapter, waiting } = controlledAdapter();
  const execute = adapter.execute;
  let fail = true;
  adapter.execute = async (run, attempt, signal) => {
    if (attempt.stage === 'developer' && fail) {
      fail = false;
      throw new Error('Simulated provider authentication failure');
    }
    return execute(run, attempt, signal);
  };
  const s = await workflowFixture(adapter);
  try {
    const firstIssue = await s.issue('provider-one'),
      secondIssue = await s.issue('provider-two');
    let first = await s.client.startRun(firstIssue, 'first');
    first = await until(
      () => s.client.run(first.id),
      (r) => r.status === 'needs_input',
    );
    assert.equal(first.repairCount, 0);
    assert.match(first.interventions[0].question, /authentication/);
    let second = await s.client.startRun(secondIssue, 'second');
    second = await until(
      () => s.client.run(second.id),
      (r) => r.stage === 'developer',
    );
    const question = first.interventions[0];
    first = await command(s, first, 'answer', {
      interventionId: question.id,
      interventionRevision: question.revision,
      answer: 'Credentials repaired; retry the captured provider.',
    });
    assert.equal(first.status, 'queued');
    assert.equal((await s.client.workflow()).slot, second.id);
    waiting.get(second.id)!({ outcome: 'passed', message: 'Second completed' });
    first = await until(
      () => s.client.run(first.id),
      (r) => r.status === 'running',
    );
    assert.equal(first.repairCount, 0);
  } finally {
    await s.close();
  }
});

for (const stage of ['setup', 'baseline'] as const) {
  for (const adoption of [
    'adopt_specification',
    'adopt_configuration',
  ] as const) {
    test(`${adoption} preserves outstanding ${stage} before development`, async () => {
      const { adapter, waiting } = controlledAdapter(stage);
      const s = await workflowFixture(adapter);
      try {
        let run = await s.client.startRun(await s.issue(), 'start');
        run = await until(
          () => s.client.run(run.id),
          (r) => r.stage === stage,
        );
        await until(async () => waiting.has(run.id), Boolean);
        run = await command(s, run, 'pause');
        run = await command(s, run, adoption);
        assert.equal(run.stage, stage);
        assert.equal(run.setupRequired, true);
        adapter.execute = simulationAdapter().execute;
        await command(s, run, 'resume');
        run = await until(
          () => s.client.run(run.id),
          (r) => r.status === 'pr_ready',
        );
        const setup = run.attempts.findIndex(
          (a) => a.stage === 'setup' && a.outcome === 'passed',
        );
        const baseline = run.attempts.findIndex(
          (a) => a.stage === 'baseline' && a.outcome === 'passed',
        );
        const developer = run.attempts.findIndex(
          (a) => a.stage === 'developer',
        );
        assert.ok(setup >= 0 && baseline > setup && developer > baseline);
        assert.equal(run.setupRequired, false);
        assert.equal(run.repairCount, 0);
      } finally {
        await s.close();
      }
    });
  }
}

test('chat interruption cannot downgrade pending cancellation or its termination blocker', async () => {
  const { adapter, waiting } = controlledAdapter();
  let finishCancellation!: (confirmed: boolean) => void;
  let cancelCalls = 0;
  adapter.cancel = async () => {
    cancelCalls++;
    return new Promise<boolean>((resolve) => {
      finishCancellation = resolve;
    });
  };
  const s = await workflowFixture(adapter);
  try {
    let run = await s.client.startRun(await s.issue(), 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.stage === 'developer',
    );
    await until(async () => waiting.has(run.id), Boolean);
    const cancelling = command(s, run, 'cancel');
    await until(async () => Boolean(finishCancellation), Boolean);
    await s.chat.interrupt(run.developerConversationId);
    run = await s.client.run(run.id);
    assert.equal(run.status, 'cancelling');
    assert.equal(run.stopTarget, 'cancelled');
    assert.equal(cancelCalls, 1);
    finishCancellation(false);
    run = await cancelling;
    assert.equal(run.status, 'termination_blocker');
    await s.chat.interrupt(run.developerConversationId);
    run = await s.client.run(run.id);
    assert.equal(run.status, 'termination_blocker');
    assert.equal(run.stopTarget, 'cancelled');
    assert.equal(cancelCalls, 1);
    run = await command(s, run, 'reconcile');
    assert.equal(run.status, 'cancelled');
    await assert.rejects(command(s, run, 'resume'), /finished/);
  } finally {
    await s.close();
  }
});

for (const shutdown of [false, true]) {
  for (const result of ['absent', 'confirmed'] as const) {
    test(`${shutdown ? 'shutdown' : 'pause'} during publication reconciles ${result} effect without resuming`, async () => {
      const { adapter, waiting } = controlledAdapter('publishing');
      adapter.reconcile = async () => ({
        quiescent: true,
        ...(result === 'confirmed'
          ? { publicationResult: 'Simulated existing PR' }
          : { publicationAbsent: true }),
      });
      const s = await workflowFixture(adapter);
      try {
        let run = await s.client.startRun(await s.issue(), 'start');
        run = await until(
          () => s.client.run(run.id),
          (r) => r.stage === 'publishing',
        );
        await until(async () => waiting.has(run.id), Boolean);
        const publicationId = run.publication!.id;
        if (shutdown) {
          await s.restart();
          run = await s.client.run(run.id);
        } else run = await command(s, run, 'pause');
        assert.equal(run.status, 'paused');
        assert.ok(
          run.interventions.some(
            (i) => i.reason === 'uncertain' && i.state === 'pending',
          ),
        );
        run = await command(s, run, 'reconcile');
        assert.equal(run.status, 'paused');
        assert.equal(
          run.publication!.state,
          result === 'confirmed' ? 'confirmed' : 'prepared',
        );
        assert.equal(
          run.interventions.filter((i) => i.state === 'pending').length,
          0,
        );
        assert.equal((await s.client.workflow()).slot, undefined);
        adapter.execute = async (current, attempt, signal) => {
          assert.equal(
            result,
            'absent',
            'A confirmed effect must not execute publication again',
          );
          return simulationAdapter().execute(current, attempt, signal);
        };
        await command(s, run, 'resume');
        run = await until(
          () => s.client.run(run.id),
          (r) => r.status === 'pr_ready',
        );
        assert.equal(run.publication!.id, publicationId);
      } finally {
        await s.close();
      }
    });
  }
}

test('publication termination reconciliation does not recreate resolved uncertainty', async () => {
  const { adapter, waiting } = controlledAdapter('publishing');
  adapter.cancel = async () => false;
  const s = await workflowFixture(adapter);
  try {
    let run = await s.client.startRun(await s.issue(), 'start');
    run = await until(
      () => s.client.run(run.id),
      (r) => r.stage === 'publishing',
    );
    await until(async () => waiting.has(run.id), Boolean);
    run = await command(s, run, 'pause');
    assert.equal(run.status, 'termination_blocker');
    run = await command(s, run, 'reconcile');
    assert.equal(run.status, 'paused');
    assert.equal(run.publication!.state, 'prepared');
    assert.equal(
      run.interventions.filter((i) => i.state === 'pending').length,
      0,
    );
  } finally {
    await s.close();
  }
});
