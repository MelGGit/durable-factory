import test from 'node:test';
import assert from 'node:assert/strict';
import { realFixture } from './fixtures/real.js';
import { until } from './fixtures/chat.js';
import {
  formatTicketBody,
  type RegressionRequirement,
} from '../packages/shared/src/index.js';
import { ticket } from './fixtures/planning.js';
const proof: RegressionRequirement = {
  required: true,
  command: 'node regression.test.cjs',
  testPaths: ['regression.test.cjs'],
  expectedFailure: 'REGRESSION: expected implemented',
};
const proofTest = `const fs=require('node:fs'); if(fs.readFileSync('value.txt','utf8')!=='implemented\\n'){ console.error('REGRESSION: expected implemented'); process.exit(1); }`;
async function settled(f: Awaited<ReturnType<typeof realFixture>>, id: string) {
  return until(
    () => f.client.run(id),
    (r) =>
      ['pr_ready', 'needs_input', 'termination_blocker'].includes(r.status),
    30000,
  );
}
test('required regression proof demonstrates base failure and candidate success with a frozen PR handoff', async () => {
  const f = await realFixture({ regression: proof, proofTest });
  try {
    const run = await settled(
      f,
      (await f.client.startIssue(7, 'proof-success')).id,
    );
    assert.equal(run.status, 'pr_ready', JSON.stringify(run));
    assert.equal(run.contractVersion, 2);
    assert.equal(run.implementations?.length, 1);
    const evidence = run.evidence.find((e) => e.kind === 'checks')!;
    assert.equal(evidence.regression?.passed, true);
    assert.equal(evidence.regression?.results.length, 2);
    assert.deepEqual(
      evidence.regression?.results.map((r) => r.exitCode),
      [1, 0],
    );
    assert.ok(run.proofWorkspaces?.every((r) => r.state === 'removed'));
    assert.match(run.publication!.payload!.body, /AC-1/);
    assert.match(run.publication!.payload!.body, /Regression demonstrated/);
    const payload = run.publication!.payload;
    await f.restart();
    assert.deepEqual(
      (await f.client.run(run.id)).publication!.payload,
      payload,
    );
    assert.equal(f.creates, 1);
    // A substituted proof path must block merged-run cleanup, even after its original snapshot was removed.
    const { mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const substituted = run.proofWorkspaces![0].root;
    await mkdir(substituted);
    await writeFile(join(substituted, 'preserve.txt'), 'unexpected');
    const originalIssue = f.github.getIssue;
    f.github.getIssue = async (...args) => ({
      ...(await originalIssue(...args)),
      state: 'closed',
    });
    const batch = await f.github.pulls('example/project', '', 1);
    batch.pulls[0].merged = true;
    batch.pulls[0].state = 'closed';
    await f.service.pollCompletedRuns();
    assert.equal((await f.client.run(run.id)).cleanup?.state, 'blocked');
    assert.equal(
      await readFile(join(substituted, 'preserve.txt'), 'utf8'),
      'unexpected',
    );
    await rm(substituted, { recursive: true });
    await until(
      async () => {
        await f.service.pollCompletedRuns();
        return f.client.workflow();
      },
      (state) => !state.runs.length,
      15000,
    );
  } finally {
    await f.close();
  }
});
for (const [name, options] of [
  ['missing implementation', { omitImplementation: true }],
  ['false changed-file claims', { reportFiles: ['value.txt'] }],
  ['missing criterion assessments', { assessments: [] }],
  [
    'nonexistent review reference',
    {
      assessments: [
        {
          id: 'AC-1',
          status: 'met' as const,
          explanation: 'Claimed.',
          references: [{ path: 'missing.ts' }],
        },
      ],
    },
  ],
] as const)
  test(`${name} cannot publish`, async () => {
    const f = await realFixture(JSON.parse(JSON.stringify(options)));
    try {
      const run = await settled(
        f,
        (await f.client.startIssue(7, name.replaceAll(' ', '-'))).id,
      );
      assert.equal(run.status, 'needs_input');
      assert.equal(f.creates, 0);
    } finally {
      await f.close();
    }
  });
test('direct issues without criteria pause before setup; only explicit adoption repairs the contract', async () => {
  const f = await realFixture({ issueBody: 'Please implement something.' });
  try {
    let run = await settled(
      f,
      (await f.client.startIssue(7, 'missing-contract')).id,
    );
    assert.equal(run.attempts.length, 0);
    assert.equal(run.interventions[0].reason, 'specification_contract');
    const q = run.interventions[0];
    await assert.rejects(
      f.client.command(run.id, {
        operationId: 'bypass',
        expectedRevision: run.revision,
        action: 'answer',
        interventionId: q.id,
        interventionRevision: q.revision,
        answer: 'go ahead',
      }),
      /explicit/,
    );
    const previous = f.github.getIssue;
    f.github.getIssue = async (...args) => ({
      ...(await previous(...args)),
      body: formatTicketBody({ ...ticket, revision: 0 }).replaceAll(
        '\n',
        '\r\n',
      ),
    });
    run = await f.client.command(run.id, {
      operationId: 'adopt-complete',
      expectedRevision: run.revision,
      action: 'adopt_specification',
    });
    assert.equal(run.interventions[0].state, 'resolved');
    run = await f.client.command(run.id, {
      operationId: 'resume-complete',
      expectedRevision: run.revision,
      action: 'resume',
    });
    run = await settled(f, run.id);
    assert.equal(run.status, 'pr_ready', JSON.stringify(run));
  } finally {
    await f.close();
  }
});
for (const [name, content, signature] of [
  [
    'tests pass on both trees',
    'process.exit(0)',
    'REGRESSION: expected implemented',
  ],
  ['unrelated base failure', proofTest, 'a different expected failure'],
  [
    'candidate failure',
    `console.error('REGRESSION: expected implemented');process.exit(1);`,
    'REGRESSION: expected implemented',
  ],
] as const)
  test(`regression rejects ${name} and consumes only the existing repair budget`, async () => {
    const f = await realFixture({
      regression: { ...proof, expectedFailure: signature },
      proofTest: content,
    });
    try {
      const run = await settled(
        f,
        (await f.client.startIssue(7, `proof-${name.replaceAll(' ', '-')}`)).id,
      );
      assert.equal(run.status, 'needs_input');
      assert.equal(run.repairCount, 3);
      assert.equal(run.interventions.at(-1)?.reason, 'repair_exhausted');
      assert.equal(f.creates, 0);
      assert.ok(
        run.evidenceHistory?.some((e) => e.regression && !e.regression.passed),
      );
    } finally {
      await f.close();
    }
  });

test('new-contract hook changes cannot publish using a stale implementation report', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const f = await realFixture();
  try {
    await writeFile(
      join(f.repo, '.git/hooks/pre-commit'),
      '#!/bin/sh\nprintf "hook generated\\n" > hook.txt\ngit add hook.txt\n',
      { mode: 0o700 },
    );
    let run = await settled(
      f,
      (await f.client.startIssue(7, 'new-hook-contract')).id,
    );
    assert.equal(run.stage, 'publishing');
    assert.equal(run.publicationLocked, true);
    assert.equal(f.creates, 0);
    run = await f.client.command(run.id, {
      operationId: 'repeat-hook-validation',
      expectedRevision: run.revision,
      action: 'revalidate',
    });
    run = await settled(f, run.id);
    assert.equal(run.status, 'needs_input');
    assert.equal(run.stage, 'publication');
    assert.match(
      run.interventions.at(-1)!.question,
      /report no longer matches/,
    );
    assert.equal(f.creates, 0);
  } finally {
    await f.close();
  }
});
for (const scenario of [
  'setup',
  'missing-file',
  'timeout',
  'source-mutation',
] as const)
  test(`regression ${scenario} is infrastructure failure, never proof or a repair`, async () => {
    const f = await realFixture({
      regression:
        scenario === 'missing-file'
          ? { ...proof, testPaths: ['missing.test.cjs'] }
          : proof,
      proofTest:
        scenario === 'timeout'
          ? `setTimeout(()=>{},10000);`
          : scenario === 'source-mutation'
            ? `const f=require('node:fs');if(f.readFileSync('value.txt','utf8')!=='implemented\\n'){console.error('REGRESSION: expected implemented');process.exit(1);}f.writeFileSync('value.txt','hidden mutation');require('node:child_process').execFileSync('git',['update-index','--assume-unchanged','value.txt']);`
            : proofTest,
    });
    try {
      const saved = await f.client.settings();
      if (scenario === 'setup')
        saved.settings.setupCommands = [
          `node -e "if(process.cwd().includes('/proofs/'))process.exit(2)"`,
        ];
      if (scenario === 'timeout') saved.settings.timeouts.check = 1;
      await f.client.saveSettings({
        expectedRevision: saved.revision,
        settings: saved.settings,
      });
      const run = await settled(
        f,
        (await f.client.startIssue(7, `proof-infra-${scenario}`)).id,
      );
      assert.equal(run.status, 'needs_input');
      assert.equal(run.stage, 'checks');
      assert.equal(run.repairCount, 0);
      assert.equal(f.creates, 0);
      assert.equal(
        run.evidence.some((e) => e.regression?.passed),
        false,
      );
    } finally {
      await f.close();
    }
  });

test('direct admission accepts a CRLF issue with an operation marker', async () => {
  const body = (
    formatTicketBody({ ...ticket, revision: 0 }) +
    '\n\n<!-- durable-factory:issue:crlf -->'
  ).replaceAll('\n', '\r\n');
  const f = await realFixture({ issueBody: body });
  try {
    const run = await settled(
      f,
      (await f.client.startIssue(7, 'crlf-admission')).id,
    );
    assert.equal(run.status, 'pr_ready', JSON.stringify(run));
    assert.equal(run.issueSnapshot!.body, body);
    assert.equal(run.specification.criteria!.length, 1);
  } finally {
    await f.close();
  }
});

test('oversized direct-issue checklists pause before setup with an actionable limit', async () => {
  const f = await realFixture({
    issueBody: formatTicketBody({
      ...ticket,
      revision: 0,
      acceptanceCriteria: Array.from(
        { length: 101 },
        (_, i) => `AC-${i + 1}: Outcome ${i + 1}`,
      ).join('\n'),
    }),
  });
  try {
    const run = await settled(
      f,
      (await f.client.startIssue(7, 'oversized-checklist')).id,
    );
    assert.equal(run.status, 'needs_input');
    assert.equal(run.attempts.length, 0);
    assert.match(run.interventions[0].question, /at most 100/);
    assert.equal(f.creates, 0);
  } finally {
    await f.close();
  }
});

test('linked admission tolerates transport line-ending normalization without rewriting the approved ticket', async () => {
  const { ChatClient, normalizeLineEndings } = await import(
    '../packages/shared/src/index.js'
  );
  const f = await realFixture();
  try {
    const chat = new ChatClient(f.service.url);
    const conversation = await chat.createConversation(
      'CRLF approved issue',
      'crlf-linked-conversation',
    );
    const approved = { ...ticket, goal: 'First line\r\nSecond line' };
    await f.service.planning.save(
      conversation.id,
      approved,
      'crlf-linked-save',
    );
    await f.service.planning.propose(conversation.id);
    await chat.submit(conversation.id, 'yes', 'crlf-linked-approval');
    const planning = await until(
      () => f.service.planning.read(conversation.id),
      (p) => p?.operation?.state === 'created',
    );
    const issue = f.github.issues[0];
    const original = f.github.getIssue;
    f.github.getIssue = async (...args) => ({
      ...(await original(...args)),
      number: issue.number,
      url: issue.url,
      title: approved.title,
      body: normalizeLineEndings(issue.body).replaceAll('\n', '\r\n'),
    });
    const run = await settled(
      f,
      (await f.client.startRun(conversation.id, 'crlf-linked-start')).id,
    );
    assert.equal(run.status, 'pr_ready', JSON.stringify(run));
    assert.equal(run.specification.goal, approved.goal);
    assert.deepEqual(run.specification, planning!.operation!.ticket);
  } finally {
    await f.close();
  }
});
