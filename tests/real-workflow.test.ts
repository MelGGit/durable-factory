import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './fixtures/chat.js';
import { realFixture } from './fixtures/real.js';
test('real tools, exact candidate review and local push produce one ready PR without changing the user checkout', async () => {
  const f = await realFixture();
  try {
    const started = await f.client.startIssue(7, 'real-start');
    const run = await until(
      () => f.client.run(started.id),
      (r) =>
        ['pr_ready', 'needs_input', 'termination_blocker'].includes(r.status),
      30000,
    );
    assert.equal(run.status, 'pr_ready', JSON.stringify(run));
    assert.equal(f.creates, 1);
    assert.equal(
      run.attempts.some((a) => a.stage === 'baseline'),
      false,
    );
    assert.equal(run.mode, 'real');
    assert.equal(run.evidence.filter((e) => e.passed).length, 2);
    assert.equal(
      f.git(f.remote, [
        'show',
        `${run.workspace!.branch}:generated/result.txt`,
      ]),
      'generated',
    );
    assert.equal(
      await readFile(join(f.repo, 'value.txt'), 'utf8'),
      'baseline\n',
    );
    assert.equal(
      await readFile(join(f.repo, 'user-draft.txt'), 'utf8'),
      'untouched',
    );
    assert.equal((await f.client.startIssue(7, 'duplicate')).id, run.id);
    assert.equal(f.creates, 1);
  } finally {
    await f.close();
  }
});
test('required check failures are evaluated after development and still block publication', async () => {
  const f = await realFixture({ checkFailure: true });
  try {
    const started = await f.client.startIssue(7, 'failed-check-start');
    const run = await until(
      () => f.client.run(started.id),
      (r) => r.status === 'needs_input',
      20000,
    );
    assert.ok(
      run.attempts.findIndex((a) => a.stage === 'checks') >
        run.attempts.findIndex((a) => a.stage === 'developer'),
    );
    assert.equal(
      [...run.evidence, ...(run.evidenceHistory ?? [])].find(
        (e) => e.kind === 'checks',
      )!.results![0].exitCode,
      2,
    );
    assert.equal(
      run.attempts.some((a) => a.stage === 'baseline'),
      false,
    );
    assert.equal(run.repairCount, 3);
    assert.equal(
      run.attempts.some((a) => a.stage === 'developer'),
      true,
    );
    assert.equal(f.creates, 0);
  } finally {
    await f.close();
  }
});
const proofRequirement = {
  required: true as const,
  command: 'node regression.test.cjs',
  testPaths: ['regression.test.cjs'],
  expectedFailure: 'REGRESSION',
};
// Fails on the base with the expected signature; `ok` decides whether it also passes on the candidate.
const proofTest = (ok: boolean) =>
  `if(require('node:fs').readFileSync('value.txt','utf8')!=='implemented\\n'){console.error('REGRESSION');process.exit(1);}${ok ? '' : "console.error('BROKEN');process.exit(1);"}`;
const markerCheck = (marker: string) =>
  `node -e "require('node:fs').writeFileSync('${marker}','ran')"`;
test('a failing regression proof skips the required checks', async () => {
  const marker = join(tmpdir(), `factory-checks-ran-${randomUUID()}`);
  const f = await realFixture({
    regression: proofRequirement,
    proofTest: proofTest(false),
    checkCommand: markerCheck(marker),
  });
  try {
    const started = await f.client.startIssue(7, 'failing-proof-start');
    const run = await until(
      () => f.client.run(started.id),
      (r) => r.status === 'needs_input',
      30000,
    );
    const checks = [...run.evidence, ...(run.evidenceHistory ?? [])].find(
      (e) => e.kind === 'checks',
    )!;
    assert.equal(checks.passed, false);
    assert.equal(checks.results?.length ?? 0, 0);
    assert.equal(checks.regression?.passed, false);
    assert.equal(existsSync(marker), false);
    assert.equal(f.creates, 0);
  } finally {
    await f.close();
    await rm(marker, { force: true });
  }
});
test('a passing regression proof still runs the required checks', async () => {
  const marker = join(tmpdir(), `factory-checks-ran-${randomUUID()}`);
  const f = await realFixture({
    regression: proofRequirement,
    proofTest: proofTest(true),
    checkCommand: markerCheck(marker),
  });
  try {
    const started = await f.client.startIssue(7, 'passing-proof-start');
    const run = await until(
      () => f.client.run(started.id),
      (r) => ['pr_ready', 'needs_input'].includes(r.status),
      30000,
    );
    const checks = [...run.evidence, ...(run.evidenceHistory ?? [])].find(
      (e) => e.kind === 'checks',
    )!;
    assert.equal(checks.regression?.passed, true);
    assert.equal(checks.results?.length, 1);
    assert.equal(existsSync(marker), true);
  } finally {
    await f.close();
    await rm(marker, { force: true });
  }
});
test('unstructured reviewer prose cannot publish', async () => {
  const f = await realFixture({ malformedReview: true });
  try {
    const started = await f.client.startIssue(7, 'review-start');
    const run = await until(
      () => f.client.run(started.id),
      (r) => r.status === 'needs_input',
      20000,
    );
    assert.equal(run.stage, 'reviewer');
    assert.equal(f.creates, 0);
  } finally {
    await f.close();
  }
});
test('lost PR response reconciles the same PR without repeating creation', async () => {
  const f = await realFixture({ lostPr: true });
  try {
    const started = await f.client.startIssue(7, 'lost-start');
    let run = await until(
      () => f.client.run(started.id),
      (r) => r.status === 'needs_input',
      30000,
    );
    assert.equal(f.creates, 1);
    run = await f.client.command(run.id, {
      action: 'reconcile',
      operationId: 'reconcile',
      expectedRevision: run.revision,
    });
    assert.equal(f.creates, 1);
    assert.equal(run.publication?.state, 'confirmed');
  } finally {
    await f.close();
  }
});

test('legacy commit-hook changes block push; explicit checks and review preserve closed implementation input', async () => {
  const f = await realFixture();
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(f.repo, '.git/hooks/pre-commit'),
      '#!/bin/sh\nprintf "hook generated\\n" > hook.txt\ngit add hook.txt\n',
      { mode: 0o700 },
    );
    const started = await f.client.startIssue(7, 'hook-start');
    // The existing service-only hook revalidation path remains supported for legacy contracts.
    await f.service.workflow['harness'].commit(
      async (tx) => {
        const { Workflow } = await import('../apps/server/src/workflow.js');
        const doc = await tx.doc(Workflow);
        delete doc.runs[started.id].contractVersion;
      },
      (await import('../apps/server/src/storage.js')).context,
    );
    let run = await until(
      () => f.client.run(started.id),
      (r) => r.status === 'needs_input',
      20000,
    );
    assert.equal(run.stage, 'publishing');
    assert.equal(run.publicationLocked, true);
    assert.equal(f.creates, 0);
    const { ChatClient } = await import('../packages/shared/src/index.js');
    await assert.rejects(
      new ChatClient(f.service.url).submit(
        run.developerConversationId,
        'edit again',
        'late-guidance',
      ),
      /closed/,
    );
    run = await f.client.command(run.id, {
      action: 'revalidate',
      operationId: 'validate-hook-content',
      expectedRevision: run.revision,
    });
    run = await until(
      () => f.client.run(started.id),
      (r) => ['pr_ready', 'needs_input'].includes(r.status),
      20000,
    );
    assert.equal(run.status, 'pr_ready', JSON.stringify(run));
    assert.equal(run.attempts.filter((a) => a.stage === 'developer').length, 1);
    assert.equal(run.attempts.filter((a) => a.stage === 'reviewer').length, 2);
    assert.equal(
      f.git(f.remote, ['show', `${run.workspace!.branch}:hook.txt`]),
      'hook generated',
    );
  } finally {
    await f.close();
  }
});
test('source edits during review invalidate evidence while ignored disposable output does not', async () => {
  for (const disposable of [false, true]) {
    let f: Awaited<ReturnType<typeof realFixture>>,
      changed = false;
    f = await realFixture({
      beforeReview: async () => {
        if (changed) return;
        changed = true;
        const run = (await f.client.workflow()).runs[0];
        const { writeFile } = await import('node:fs/promises');
        await writeFile(
          join(
            run.workspace!.path,
            disposable ? 'generated/noise.txt' : 'value.txt',
          ),
          'external change\n',
        );
      },
    });
    try {
      const started = await f.client.startIssue(7, 'source-start');
      const run = await until(
        () => f.client.run(started.id),
        (r) => ['pr_ready', 'needs_input'].includes(r.status),
        30000,
      );
      assert.equal(run.status, 'pr_ready', JSON.stringify(run));
      assert.equal(
        run.attempts.filter((a) => a.stage === 'developer').length,
        disposable ? 1 : 2,
      );
    } finally {
      await f.close();
    }
  }
});
test('base movement before publication integrates and repeats full validation', async () => {
  let f: Awaited<ReturnType<typeof realFixture>>,
    changed = false;
  f = await realFixture({
    beforeReview: async () => {
      if (changed) return;
      changed = true;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(f.repo, 'base-change.txt'), 'new base\n');
      f.git(f.repo, ['add', 'base-change.txt']);
      f.git(f.repo, ['commit', '-qm', 'Move base']);
      f.git(f.repo, ['push', '-q', f.remote, 'main']);
    },
  });
  try {
    const started = await f.client.startIssue(7, 'base-start');
    const run = await until(
      () => f.client.run(started.id),
      (r) => ['pr_ready', 'needs_input'].includes(r.status),
      30000,
    );
    assert.equal(run.status, 'pr_ready', JSON.stringify(run));
    assert.equal(run.attempts.filter((a) => a.stage === 'checks').length, 2);
    assert.equal(run.repairCount, 0);
    assert.equal(
      f.git(f.remote, ['show', `${run.workspace!.branch}:base-change.txt`]),
      'new base',
    );
  } finally {
    await f.close();
  }
});
test('startup label discovery and manual start converge; persistent labels cannot restart a finished run', async () => {
  const initial = await realFixture();
  await initial.service.close();
  const f = await realFixture({
    directory: initial.directory,
    labelReady: true,
  });
  try {
    const manual = await f.client.startIssue(7, 'manual-with-label');
    const run = await until(
      () => f.client.run(manual.id),
      (r) => ['pr_ready', 'needs_input'].includes(r.status),
      30000,
    );
    assert.equal(run.status, 'pr_ready');
    assert.equal((await f.client.workflow()).runs.length, 1);
    assert.equal(f.creates, 1);
    await f.service.close();
    const restarted = await realFixture({
      directory: f.directory,
      labelReady: true,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal((await restarted.client.workflow()).runs.length, 1);
      assert.equal(restarted.creates, 1);
    } finally {
      await restarted.close();
    }
  } finally {
    await f.service.close();
  }
});

test('real steering waits for a tool boundary and withdrawn guidance is never consumed', async () => {
  const f = await realFixture({
    developerCommand: 'echo ready > tool-boundary.txt; sleep 1',
  });
  try {
    const started = await f.client.startIssue(7, 'steer-start');
    let run = await until(
      () => f.client.run(started.id),
      (r) => r.stage === 'developer',
      15000,
    );
    await until(
      async () => {
        try {
          return await readFile(
            join(run.workspace!.path, 'tool-boundary.txt'),
            'utf8',
          );
        } catch {
          return '';
        }
      },
      (value) => value === 'ready\n',
    );
    const { ChatClient } = await import('../packages/shared/src/index.js');
    const chat = new ChatClient(f.service.url);
    await chat.submit(
      run.developerConversationId,
      'Finish this attempt after the current tool.',
      'steer-boundary',
      'steer',
    );
    const withdrawal = await chat.submit(
      run.developerConversationId,
      'Withdraw me.',
      'withdraw-boundary',
      'steer',
    );
    await chat.withdraw(run.developerConversationId, withdrawal.id);
    run = await until(
      () => f.client.run(started.id),
      (r) => ['pr_ready', 'needs_input'].includes(r.status),
      20000,
    );
    assert.equal(run.status, 'pr_ready', JSON.stringify(run));
    assert.equal(
      run.inputs.find((i) => i.requestId === 'steer-boundary')?.status,
      'consumed',
    );
    assert.equal(
      run.inputs.find((i) => i.requestId === 'withdraw-boundary')?.status,
      'withdrawn',
    );
    assert.equal(run.attempts.filter((a) => a.stage === 'developer').length, 1);
  } finally {
    await f.close();
  }
});
test('real provider deadlines pause without repairs and late replies cannot publish', async () => {
  const f = await realFixture({ reviewDelay: 2500 });
  try {
    const saved = await f.client.settings();
    saved.settings.timeouts.provider = 1;
    await f.client.saveSettings({
      expectedRevision: saved.revision,
      settings: saved.settings,
    });
    const started = await f.client.startIssue(7, 'provider-deadline');
    const run = await until(
      () => f.client.run(started.id),
      (r) => ['needs_input', 'termination_blocker'].includes(r.status),
      20000,
    );
    assert.equal(run.stage, 'reviewer');
    assert.equal(run.repairCount, 0);
    assert.equal(f.creates, 0);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.notEqual((await f.client.run(run.id)).status, 'pr_ready');
  } finally {
    await f.close();
  }
});

test('command artifacts paginate complete UTF-8 output without accepting arbitrary paths', async () => {
  const f = await realFixture({
    checkCommand: 'node -e "process.stdout.write(\'🙂\'.repeat(20000))"',
  });
  try {
    const started = await f.client.startIssue(7, 'unicode-output');
    const run = await until(
      () => f.client.run(started.id),
      (r) => ['pr_ready', 'needs_input'].includes(r.status),
      20000,
    );
    assert.equal(run.status, 'pr_ready');
    const command = run.evidence.find((e) => e.kind === 'checks')!.results![0];
    let offset: number | undefined = 0,
      output = '';
    while (offset !== undefined) {
      const response: Response = await fetch(
        `${f.service.url}/api/v1/runs/${run.id}/artifacts/${command.artifact}?offset=${offset}`,
      );
      assert.equal(response.status, 200);
      const page: { text: string; nextOffset?: number } = await response.json();
      output += page.text;
      offset = page.nextOffset;
    }
    assert.equal(output, '🙂'.repeat(20000));
    assert.equal(
      (
        await fetch(
          `${f.service.url}/api/v1/runs/${run.id}/artifacts/${command.artifact}?offset=1`,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          `${f.service.url}/api/v1/runs/${run.id}/artifacts/not-a-command`,
        )
      ).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test('cancelled admission lookup cannot create a run after the start tool is interrupted', async () => {
  const f = await realFixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const original = f.github.getIssue;
  f.github.getIssue = async (...args) => {
    entered();
    await waiting;
    return original(...args);
  };
  try {
    const controller = new AbortController();
    const admission = f.service.workflow.admit(
      { issueNumber: 7, operationId: 'interrupted-admission' },
      controller.signal,
    );
    await started;
    controller.abort();
    release();
    await assert.rejects(admission, /abort/i);
    assert.equal((await f.client.workflow()).runs.length, 0);
  } finally {
    release();
    await f.close();
  }
});
test('shutdown closes admission before draining an in-flight issue lookup', async () => {
  const f = await realFixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const original = f.github.getIssue;
  f.github.getIssue = async (...args) => {
    entered();
    await waiting;
    return original(...args);
  };
  try {
    const admission = f.client.startIssue(7, 'shutdown-admission');
    await started;
    const closing = f.service.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await assert.rejects(admission, /closing/);
    await closing;
    const { stat } = await import('node:fs/promises');
    await assert.rejects(stat(join(f.dataDir, 'worktrees')));
  } finally {
    release();
    await f.close();
  }
});

test('label discovery cannot admit an old repository issue after settings change', async () => {
  const { startService } = await import('./helpers/credentials.js');
  const { fixture } = await import('./fixtures/chat.js');
  const { WorkflowClient } = await import('../packages/shared/src/index.js');
  const f = await realFixture();
  await f.service.close();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queried = '',
    returned = false,
    issueReads = 0;
  const getIssue = f.github.getIssue;
  f.github.getIssue = async (...args) => {
    issueReads++;
    return getIssue(...args);
  };
  f.github.readyIssues = async (repository) => {
    queried = repository;
    await gate;
    const issue = await getIssue(repository, 7);
    returned = true;
    return { issues: [issue], hasNext: false };
  };
  const service = await startService({
    dataDir: f.dataDir,
    port: 0,
    chat: fixture(),
    github: f.github,
    workflowRemote: f.remote,
  });
  try {
    await until(async () => queried, Boolean);
    const client = new WorkflowClient(service.url);
    const saved = await client.settings();
    saved.settings.repository.github = 'example/other-project';
    await client.saveSettings({
      expectedRevision: saved.revision,
      settings: saved.settings,
    });
    release();
    await until(async () => returned, Boolean);
    // Wait for the rejected admission and its poll error handler to settle.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(queried, 'example/project');
    assert.equal(issueReads, 0);
    assert.equal((await client.workflow()).runs.length, 0);
  } finally {
    release();
    await service.close();
    await f.close();
  }
});

test('a retargeted PR cannot be reconciled as ready after a lost creation response', async () => {
  const f = await realFixture({ lostPr: true });
  try {
    const started = await f.client.startIssue(7, 'retarget-start');
    let run = await until(
      () => f.client.run(started.id),
      (r) => r.status === 'needs_input',
      30000,
    );
    const pulls = await f.github.pulls(
      run.repository.github,
      run.workspace!.branch,
      1,
    );
    assert.equal(pulls.pulls.length, 1);
    pulls.pulls[0].baseBranch = 'release';
    run = await f.client.command(run.id, {
      action: 'reconcile',
      operationId: 'retarget-reconcile',
      expectedRevision: run.revision,
    });
    assert.equal(run.status, 'needs_input');
    assert.notEqual(run.publication?.state, 'confirmed');
    assert.equal(f.creates, 1);
    // Restoring the captured target permits reconciliation of the same PR.
    pulls.pulls[0].baseBranch = 'main';
    run = await f.client.command(run.id, {
      action: 'reconcile',
      operationId: 'target-restored',
      expectedRevision: run.revision,
    });
    assert.equal(run.status, 'pr_ready');
    assert.equal(f.creates, 1);
  } finally {
    await f.close();
  }
});

test('a creation response with a different target cannot approve publication', async () => {
  const f = await realFixture({
    afterCreate: async () => {
      const pulls = await f.github.pulls('example/project', '', 1);
      pulls.pulls[0].baseRepository = 'example/other-project';
    },
  });
  try {
    const started = await f.client.startIssue(7, 'wrong-target-response');
    const run = await until(
      () => f.client.run(started.id),
      (r) => ['pr_ready', 'needs_input'].includes(r.status),
      30000,
    );
    assert.equal(run.status, 'needs_input');
    assert.equal(run.stage, 'publishing');
    assert.equal(f.creates, 1);
  } finally {
    await f.close();
  }
});
