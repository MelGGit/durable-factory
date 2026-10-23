import test from 'node:test';
import assert from 'node:assert/strict';
import {
  criteriaFromText,
  validateTicketContract,
  formatTicketBody,
  parseIssueTicket,
  validateImplementation,
  validateAssessments,
  pullRequestBody,
  runTimeline,
  type Ticket,
  type WorkflowRun,
  type CriterionAssessment,
} from '../packages/shared/src/index.js';
const ticket: Ticket = {
  revision: 0,
  title: 'Fix checkout',
  goal: 'Restore checkout.',
  scope: 'Guest checkout.',
  acceptanceCriteria:
    'AC-1: Guest checkout succeeds.\nAC-2: Registered checkout still succeeds.',
  validation: 'Run checkout tests.',
  regression: {
    required: true,
    command: 'node checkout.test.cjs',
    testPaths: ['checkout.test.cjs'],
    expectedFailure: 'guest checkout failed',
  },
};
const report = {
  summary: 'Restore guest checkout.',
  changedFiles: ['checkout.js', 'checkout.test.cjs'],
  criteria: ['AC-1', 'AC-2'],
  validation: ['checkout tests'],
  concerns: [],
  reviewerNotes: 'Inspect guest handling.',
};
const assessments: CriterionAssessment[] = ['AC-1', 'AC-2'].map((id) => ({
  id,
  status: 'met',
  explanation: 'Covered by inspected checkout tests.',
  references: [{ path: 'checkout.test.cjs', line: 1 }],
}));
test('approved issue formatter/parser preserves explicit criteria, commands, paths, signatures and multiline reasons', () => {
  const parsed = parseIssueTicket(
    ticket.title,
    formatTicketBody(ticket) + '\n\n<!-- durable-factory:issue:operation -->',
  );
  assert.equal(formatTicketBody(parsed), formatTicketBody(ticket));
  assert.deepEqual(
    parsed.criteria,
    criteriaFromText(ticket.acceptanceCriteria),
  );
  const noProof: Ticket = {
    ...ticket,
    regression: {
      required: false,
      reason: 'New feature.\nCovered by normal checks.',
    },
  };
  assert.equal(
    formatTicketBody(
      parseIssueTicket(noProof.title, formatTicketBody(noProof)),
    ),
    formatTicketBody(noProof),
  );
});
test('unstructured, duplicate or incomplete specifications are never inferred', () => {
  assert.throws(() => parseIssueTicket('Fix', 'Fix checkout please.'), /AC-N/);
  assert.throws(() => criteriaFromText('AC-1: A\nAC-1: B'), /unique/);
  assert.throws(
    () => validateTicketContract({ ...ticket, regression: undefined }),
    /whether/,
  );
  assert.throws(
    () =>
      validateTicketContract({
        ...ticket,
        regression: {
          ...(ticket.regression as Extract<
            NonNullable<Ticket['regression']>,
            { required: true }
          >),
          testPaths: ['../escape'],
        },
      }),
    /relative/,
  );
  assert.throws(
    () =>
      parseIssueTicket(
        ticket.title,
        formatTicketBody(ticket) +
          '\n\n## Acceptance criteria\n\nAC-3: Injected.',
      ),
    /Duplicate/,
  );
});
test('implementation reports require exact file claims and every approved criterion', () => {
  validateImplementation(report, ticket, report.changedFiles);
  assert.throws(
    () =>
      validateImplementation(
        { ...report, changedFiles: ['checkout.js'] },
        ticket,
        report.changedFiles,
      ),
    /exactly/,
  );
  assert.throws(
    () =>
      validateImplementation(
        { ...report, criteria: ['AC-1'] },
        ticket,
        report.changedFiles,
      ),
    /every/,
  );
  assert.throws(
    () =>
      validateImplementation(
        { ...report, criteria: ['AC-1', 'AC-1'] },
        ticket,
        report.changedFiles,
      ),
    /every/,
  );
  validateImplementation(
    { ...report, changedFiles: ['old.js', 'new.js', 'deleted.js'] },
    ticket,
    ['deleted.js', 'new.js', 'old.js'],
  );
});
test('review approval requires complete, unique, supported assessments and consistent verdicts', () => {
  validateAssessments(assessments, ticket, 'pass');
  for (const invalid of [
    [],
    [assessments[0]],
    [assessments[0], assessments[0]],
    [...assessments, { ...assessments[0], id: 'AC-3' }],
  ])
    assert.throws(() => validateAssessments(invalid, ticket, 'pass'), /every/);
  assert.throws(
    () =>
      validateAssessments(
        [{ ...assessments[0], references: [] }, assessments[1]],
        ticket,
        'pass',
      ),
    /references/,
  );
  assert.throws(
    () =>
      validateAssessments(
        [{ ...assessments[0], status: 'unmet' }, assessments[1]],
        ticket,
        'pass',
      ),
    /every/,
  );
});
test('legacy issue formatting remains unchanged and missing contracts stay unavailable', () => {
  const legacy = { ...ticket, regression: undefined };
  assert.equal(
    formatTicketBody(legacy),
    `## Goal\n\nRestore checkout.\n\n## Scope\n\nGuest checkout.\n\n## Acceptance criteria\n\n${ticket.acceptanceCriteria}\n\n## Validation\n\nRun checkout tests.`,
  );
});
test('PR handoff is deterministic and stale reports cannot supply a new contract PR', () => {
  const run = {
    contractVersion: 2,
    source: 'tree',
    configurationRevision: 1,
    specificationRevision: 1,
    specification: {
      ...ticket,
      criteria: criteriaFromText(ticket.acceptanceCriteria),
    },
    issue: { number: 7 },
    implementations: [
      {
        ...report,
        attemptId: 'build',
        source: 'tree',
        configurationRevision: 1,
        specificationRevision: 1,
      },
    ],
    evidence: [
      {
        kind: 'checks',
        results: [{ command: 'node checkout.test.cjs', exitCode: 0 }],
        regression: { message: 'Base fails; candidate passes.' },
      },
      { kind: 'reviewer', passed: true, assessments },
    ],
  } as unknown as WorkflowRun;
  const body = pullRequestBody(run, '<!-- marker -->');
  assert.equal(body, pullRequestBody(run, '<!-- marker -->'));
  assert.match(body, /Closes #7/);
  assert.match(body, /AC-2/);
  assert.match(body, /Remaining limitations/);
  assert.throws(
    () => pullRequestBody({ ...run, source: 'new-tree' }, 'marker'),
    /current/,
  );
});
test('timeline combines actors and recovery chronologically without inventing legacy timestamps', () => {
  const run = {
    attempts: [
      {
        id: 'a',
        stage: 'developer',
        startedAt: 10,
        repair: 0,
        recoveryCount: 1,
        recoveries: [{ at: 30 }],
      },
    ],
    decisions: [
      { operationId: 'pause', at: 20, action: 'pause', detail: 'pause' },
    ],
    interventions: [{ id: 'legacy', state: 'pending' }],
  } as unknown as WorkflowRun;
  const events = runTimeline(run);
  assert.deepEqual(
    events.map((e) => [e.at, e.actor]),
    [
      [10, 'agent'],
      [20, 'human'],
      [30, 'code'],
    ],
  );
});

test('issue parsing accepts CRLF and mixed line endings with either proof decision and an operation marker', () => {
  const variants: Ticket[] = [
    ticket,
    {
      ...ticket,
      regression: { required: false, reason: 'Normal checks suffice.' },
    },
  ];
  for (const value of variants)
    for (const marker of ['', '\n\n<!-- durable-factory:issue:operation -->']) {
      const original = formatTicketBody(value);
      const body = original + marker;
      for (const encoded of [
        body.replaceAll('\n', '\r\n'),
        body.replaceAll('\n', '\r'),
        body.replace('## Regression proof\n\n', '## Regression proof\r\n\r\n'),
      ]) {
        const parsed = parseIssueTicket(value.title, encoded);
        assert.equal(formatTicketBody(parsed), original);
        assert.deepEqual(
          parsed.criteria,
          criteriaFromText(value.acceptanceCriteria),
        );
      }
    }
  assert.deepEqual(
    criteriaFromText(ticket.acceptanceCriteria.replaceAll('\n', '\r\n')),
    criteriaFromText(ticket.acceptanceCriteria),
  );
});

test('line-ending normalization preserves escaped literal failure signatures and multiline reasons', () => {
  const required: Ticket = {
    ...ticket,
    regression: {
      required: true,
      command: 'node checkout.test.cjs',
      testPaths: ['checkout.test.cjs'],
      expectedFailure: 'first\r\nsecond',
    },
  };
  const optional: Ticket = {
    ...ticket,
    regression: { required: false, reason: 'first\r\nsecond' },
  };
  for (const value of [required, optional])
    assert.deepEqual(
      parseIssueTicket(
        value.title,
        formatTicketBody(value).replaceAll('\n', '\r\n'),
      ).regression,
      value.regression,
    );
});

test('criterion count limits agree across planning, parsing, implementation and review', () => {
  const make = (count: number): Ticket => ({
    ...ticket,
    acceptanceCriteria: Array.from(
      { length: count },
      (_, i) => `AC-${i + 1}: Outcome ${i + 1}`,
    ).join('\n'),
  });
  const maximum = make(100);
  const criteria = validateTicketContract(maximum);
  assert.equal(criteria.length, 100);
  assert.equal(
    parseIssueTicket(maximum.title, formatTicketBody(maximum)).criteria!.length,
    100,
  );
  validateImplementation(
    { ...report, criteria: criteria.map((c) => c.id) },
    maximum,
    report.changedFiles,
  );
  validateAssessments(
    criteria.map((c) => ({ ...assessments[0], id: c.id })),
    maximum,
    'pass',
  );
  const oversized = make(101);
  assert.ok(oversized.acceptanceCriteria.length < 6000);
  assert.throws(() => validateTicketContract(oversized), /at most 100/);
  assert.throws(
    () => parseIssueTicket(oversized.title, formatTicketBody(oversized)),
    /at most 100/,
  );
});
