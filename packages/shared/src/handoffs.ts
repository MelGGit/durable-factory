import type { Ticket } from './planning.js';
import type { WorkflowRun, RunEvidence } from './workflow.js';

export const MAX_ACCEPTANCE_CRITERIA = 100;

export function normalizeLineEndings(text: string) {
  return text.replace(/\r\n?/g, '\n');
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
}
export type RegressionRequirement =
  | { required: false; reason: string }
  | {
      required: true;
      command: string;
      testPaths: string[];
      expectedFailure: string;
    };
export interface ImplementationReport {
  summary: string;
  changedFiles: string[];
  criteria: string[];
  validation: string[];
  concerns: string[];
  reviewerNotes: string;
  /** Changes beyond the ticket, each one approved by the user. Empty when none. */
  outOfScope?: string[];
}
export interface CriterionAssessment {
  id: string;
  status: 'met' | 'unmet' | 'needs_input';
  explanation: string;
  references: { path: string; line?: number }[];
}
export interface BoundImplementation extends ImplementationReport {
  id?: string;
  attemptId: string;
  source: string;
  configurationRevision: number;
  specificationRevision: number;
}
export interface RegressionEvidence {
  base: string;
  source: string;
  configurationRevision: number;
  specificationRevision: number;
  passed: boolean;
  message: string;
  results: NonNullable<RunEvidence['results']>;
}
export function criteriaFromText(text: string): AcceptanceCriterion[] {
  const lines = normalizeLineEndings(text).trim().split('\n');
  if (lines.length > MAX_ACCEPTANCE_CRITERIA)
    throw new Error(
      `Provide at most ${MAX_ACCEPTANCE_CRITERIA} acceptance criteria.`,
    );
  const criteria = lines.map((line) =>
    /^\s*(?:-\s*(?:\[[ x]\]\s*)?)?(AC-[1-9]\d*):\s*(\S.*)$/.exec(line),
  );
  if (!criteria.length || criteria.some((c) => !c))
    throw new Error('Provide one explicit AC-N: criterion per line.');
  const result = criteria.map((c) => ({ id: c![1], text: c![2] }));
  if (new Set(result.map((c) => c.id)).size !== result.length)
    throw new Error('Acceptance criterion identifiers must be unique.');
  return result;
}
export function relativeFile(path: string) {
  return (
    !!path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/[\0\r\n]/.test(path) &&
    !path
      .split('/')
      .some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
  );
}
export function validateTicketContract(ticket: Ticket): AcceptanceCriterion[] {
  const criteria = criteriaFromText(ticket.acceptanceCriteria);
  for (const field of ['title', 'goal', 'scope', 'validation'] as const)
    if (typeof ticket[field] !== 'string' || !ticket[field].trim())
      throw new Error(`Issue needs an explicit ${field} section.`);
  if (
    ticket.criteria &&
    JSON.stringify(criteria) !== JSON.stringify(ticket.criteria)
  )
    throw new Error(
      'Structured criteria differ from the approved acceptance text.',
    );
  const proof = ticket.regression;
  if (!proof || typeof proof.required !== 'boolean')
    throw new Error('Specify whether regression proof is required.');
  if (proof.required) {
    if (
      !proof.command?.trim() ||
      !proof.expectedFailure?.trim() ||
      !proof.testPaths?.length ||
      !proof.testPaths.every(relativeFile) ||
      new Set(proof.testPaths).size !== proof.testPaths.length
    )
      throw new Error(
        'Required regression proof needs a command, literal expected failure signature, and unique relative test/fixture paths.',
      );
    if (
      proof.command.length > 4000 ||
      proof.expectedFailure.length > 2000 ||
      proof.testPaths.length > 100
    )
      throw new Error('Regression proof instructions exceed supported limits.');
  } else if (!proof.reason?.trim())
    throw new Error('Explain why regression proof is not required.');
  return criteria;
}
export function formatTicketBody(ticket: Ticket) {
  const base = `## Goal\n\n${ticket.goal}\n\n## Scope\n\n${ticket.scope}\n\n## Acceptance criteria\n\n${ticket.acceptanceCriteria}\n\n## Validation\n\n${ticket.validation}`;
  if (!ticket.regression) return base; // Previously approved legacy payloads stay byte-for-byte stable.
  const p = ticket.regression;
  return `${base}\n\n## Regression proof\n\n${p.required ? `Required: yes\nCommand: ${JSON.stringify(p.command)}\nTest paths: ${JSON.stringify(p.testPaths)}\nExpected failure: ${JSON.stringify(p.expectedFailure)}` : `Required: no\nReason: ${JSON.stringify(p.reason)}`}`;
}
/** Parse only explicit sections. Never infer requirements from issue prose. */
export function parseIssueTicket(
  title: string,
  body: string,
  revision = 0,
): Ticket {
  const clean = normalizeLineEndings(body).replace(
    /\n\n<!-- durable-factory:issue:[^>]+-->\s*$/,
    '',
  );
  const sections = new Map<string, string>();
  const parts = clean.split(
    /^## (Goal|Scope|Acceptance criteria|Validation|Regression proof)\s*$/m,
  );
  for (let i = 1; i < parts.length; i += 2) {
    if (sections.has(parts[i]))
      throw new Error(`Duplicate issue section: ${parts[i]}.`);
    sections.set(parts[i], parts[i + 1].trim());
  }
  const ticket: Ticket = {
    revision,
    title,
    goal: sections.get('Goal') ?? '',
    scope: sections.get('Scope') ?? '',
    acceptanceCriteria: sections.get('Acceptance criteria') ?? '',
    validation: sections.get('Validation') ?? '',
  };
  const proof = sections.get('Regression proof');
  if (proof) {
    const values = new Map<string, string>();
    for (const line of proof.split('\n')) {
      const match =
        /^(Required|Reason|Command|Test paths|Expected failure): (.+)$/.exec(
          line,
        );
      if (!match || values.has(match[1]))
        throw new Error('Malformed regression proof section.');
      values.set(match[1], match[2]);
    }
    if (values.size !== (values.get('Required') === 'no' ? 2 : 4))
      throw new Error(
        'Regression proof contains missing or unexpected fields.',
      );
    if (values.get('Required') === 'no')
      ticket.regression = {
        required: false,
        reason: JSON.parse(values.get('Reason') ?? 'null'),
      };
    else if (values.get('Required') === 'yes')
      ticket.regression = {
        required: true,
        command: JSON.parse(values.get('Command') ?? 'null'),
        testPaths: JSON.parse(values.get('Test paths') ?? 'null'),
        expectedFailure: JSON.parse(values.get('Expected failure') ?? 'null'),
      };
    else
      throw new Error(
        'Regression proof must explicitly say Required: yes or no.',
      );
  }
  ticket.criteria = validateTicketContract(ticket);
  return ticket;
}
export function currentImplementation(run: WorkflowRun) {
  return run.implementations?.findLast(
    (r) =>
      r.source === run.source &&
      r.configurationRevision === run.configurationRevision &&
      r.specificationRevision === run.specificationRevision,
  );
}
export function validateImplementation(
  report: ImplementationReport,
  ticket: Ticket,
  changed: string[],
) {
  if (!report.summary.trim() || !report.reviewerNotes.trim())
    throw new Error('Implementation summary and reviewer notes are required.');
  const expected = validateTicketContract(ticket)
    .map((c) => c.id)
    .sort();
  if (JSON.stringify([...report.criteria].sort()) !== JSON.stringify(expected))
    throw new Error(
      'Implementation must reference every approved criterion exactly once.',
    );
  if (
    JSON.stringify([...report.changedFiles].sort()) !==
    JSON.stringify([...changed].sort())
  )
    throw new Error(
      `Changed files must exactly match the candidate diff: ${JSON.stringify(changed)}.`,
    );
}
const FILE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|css|scss|json|md|txt|html|ya?ml|toml|lock|sh|py|go|rs|java|rb|sql)$/i;
/** Repository paths and file names a ticket mentions anywhere in its text. */
export function namedPaths(ticket: Ticket) {
  const text = [
    ticket.goal,
    ticket.scope,
    ticket.acceptanceCriteria,
    ticket.validation,
  ].join('\n');
  // Approved test paths are exact, so they need no guessing from prose.
  const found = new Set<string>(
    ticket.regression?.required ? ticket.regression.testPaths : [],
  );
  for (const [match] of text.matchAll(
    /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\/?|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.[A-Za-z]{1,5}\b/g,
  )) {
    // A sentence's closing period or comma is not part of the path.
    const token = match.replace(/[.,;:-]+$/, '');
    if (token.includes('/') || FILE_EXTENSION.test(token)) found.add(token);
  }
  return [...found];
}
const TEST_FILE = /^(.+)\.(?:test|spec)\.[A-Za-z0-9]+$/;
const dirOf = (path: string) => path.split('/').slice(0, -1).join('/');
const under = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/**
 * A test file that obviously belongs to a named source file: same base name
 * with `.test.` or `.spec.`, next to it, in its `__tests__`, or in a
 * top-level `tests`/`test` directory (mirroring the source path or not).
 */
function pairedTest(file: string, named: string[], changed: string[]) {
  const stem = TEST_FILE.exec(file.split('/').pop()!)?.[1];
  if (!stem) return false;
  const dir = dirOf(file);
  return named.some((path) => {
    const name = path.split('/').pop()!;
    if (!FILE_EXTENSION.test(name) || TEST_FILE.test(name)) return false;
    if (name.replace(/\.[^.]+$/, '') !== stem) return false;
    // A bare file name stands for wherever the change has that file.
    const sources = path.includes('/')
      ? [dirOf(path)]
      : changed.filter((f) => f === path || f.endsWith(`/${path}`)).map(dirOf);
    const roots = ['tests', 'test'];
    return sources.some((source) => {
      const bare = source.replace(/^(?:src|lib)(?:\/|$)/, '');
      return [
        source,
        under(source, '__tests__'),
        ...roots,
        ...roots.map((root) => under(root, source)),
        ...roots.map((root) => under(root, bare)),
      ].includes(dir);
    });
  });
}
/**
 * Changed files the ticket never names. Only meaningful when the ticket names
 * files at all; a ticket without any leaves scope to the agents and reviewer.
 * Tests that obviously pair with a named source file are not extras.
 */
export function unnamedFiles(ticket: Ticket, changed: string[]) {
  const named = namedPaths(ticket);
  if (!named.length) return [];
  return changed.filter(
    (file) =>
      !named.some((path) =>
        path.includes('/')
          ? file === path ||
            file.startsWith(path.endsWith('/') ? path : `${path}/`)
          : file === path || file.endsWith(`/${path}`),
      ) && !pairedTest(file, named, changed),
  );
}
/** Out-of-scope changes the user was asked about and answered, by path and by description. */
export interface ApprovedScope {
  paths: string[];
  changes: string[];
}
const NOTHING_APPROVED: ApprovedScope = { paths: [], changes: [] };
/**
 * What the user's answers approve. Only a resolved developer question that
 * named its out-of-scope change and paths approves anything; answering any
 * other question, or a record from before questions named paths, does not.
 */
export function approvedScope(
  run: Pick<WorkflowRun, 'interventions'>,
): ApprovedScope {
  const asked = run.interventions.filter(
    (i) => i.state === 'resolved' && i.reason === 'developer' && i.outOfScope,
  );
  return {
    paths: asked.flatMap((i) => i.outOfScope!.paths),
    changes: asked.map((i) => i.outOfScope!.change),
  };
}
const covers = (approved: string, file: string) =>
  file === approved ||
  file.startsWith(approved.endsWith('/') ? approved : `${approved}/`);
/**
 * Why a report may not go forward: every change beyond the ticket must be
 * declared in `outOfScope` and approved by an answer that named its paths.
 */
export function scopeProblem(
  report: Pick<ImplementationReport, 'outOfScope'>,
  ticket: Ticket,
  changed: string[],
  approved: ApprovedScope = NOTHING_APPROVED,
) {
  const declared = report.outOfScope ?? [];
  const unnamed = unnamedFiles(ticket, changed);
  const undeclared = unnamed.filter(
    (file) =>
      !declared.some(
        (entry) =>
          entry.includes(file) ||
          approved.paths.some(
            (path) => covers(path, file) && entry.includes(path),
          ),
      ),
  );
  if (undeclared.length)
    return `These files are not named in the ticket: ${undeclared.join(', ')}. Revert them, or call workflow_question with outOfScope {change, paths} to ask the user, and list them in outOfScope once approved.`;
  const unapproved = unnamed.filter(
    (file) => !approved.paths.some((path) => covers(path, file)),
  );
  if (unapproved.length)
    return `The user has not approved changing: ${unapproved.join(', ')}. Revert them, or call workflow_question with outOfScope {change, paths} naming them and wait for the answer. An answer to another question does not approve them.`;
  const unlisted = declared.filter(
    (entry) =>
      !approved.paths.some((path) => entry.includes(path)) &&
      !approved.changes.some(
        (change) => entry.includes(change) || change.includes(entry),
      ),
  );
  if (unlisted.length)
    return `Out-of-scope changes need the user's approval before they are made: ${unlisted.join('; ')}. Revert them, or call workflow_question with outOfScope {change, paths} to ask and wait for the answer; then mention an approved path or the approved change in the outOfScope entry.`;
  return undefined;
}
export function validateAssessments(
  assessments: CriterionAssessment[],
  ticket: Ticket,
  verdict: string,
) {
  const expected = validateTicketContract(ticket)
    .map((c) => c.id)
    .sort();
  if (
    JSON.stringify(assessments.map((a) => a.id).sort()) !==
    JSON.stringify(expected)
  )
    throw new Error(
      'Review must assess every approved criterion exactly once, with no unknown criteria.',
    );
  for (const a of assessments) {
    if (
      !a.explanation.trim() ||
      (a.status === 'met' && !a.references.length) ||
      a.references.some((r) => !relativeFile(r.path))
    )
      throw new Error(
        `${a.id} needs an explanation and inspectable references when met.`,
      );
  }
  if (verdict === 'pass' && assessments.some((a) => a.status !== 'met'))
    throw new Error('Approval requires every acceptance criterion to be met.');
  if (assessments.some((a) => a.status === 'needs_input')) {
    if (verdict !== 'needs_input')
      throw new Error(
        'Unresolved requirement ambiguity needs an input verdict.',
      );
  } else if (
    assessments.some((a) => a.status === 'unmet') &&
    verdict !== 'changes_requested'
  )
    throw new Error('Unmet criteria require changes_requested.');
}
export function pullRequestBody(run: WorkflowRun, marker: string) {
  const report = currentImplementation(run);
  if (run.contractVersion !== 2)
    return `${run.specification.goal}\n\nCloses #${run.issue.number}\n\n## Validation\n${run.evidence.map((e) => `- ${e.kind}: ${e.passed ? 'passed' : 'failed'} (${e.source})\n${e.output}`).join('\n')}\n\n${marker}`;
  if (!report)
    throw new Error(
      'A current implementation report is required for publication.',
    );
  const review = run.evidence.findLast(
    (e) => e.kind === 'reviewer' && e.passed,
  );
  return `## Implementation\n\n${report.summary}\n\nCloses #${run.issue.number}\n\n## Acceptance criteria\n\n${review?.assessments?.map((a) => `- [x] ${a.id}: ${run.specification.criteria?.find((c) => c.id === a.id)?.text ?? a.id}\n  ${a.explanation} (${a.references.map((r) => `${r.path}${r.line ? ':' + r.line : ''}`).join(', ')})`).join('\n')}\n\n## Validation\n\n${run.evidence
    .filter((e) => e.kind === 'checks')
    .flatMap((e) => e.results ?? [])
    .map((r) => `- ${r.command}: exit ${r.exitCode}`)
    .join(
      '\n',
    )}\n\n## Regression proof\n\n${run.specification.regression?.required ? run.evidence.findLast((e) => e.regression)?.regression?.message : `Not required: ${run.specification.regression?.reason}`}\n\n## Remaining limitations\n\n${report.concerns.length ? report.concerns.map((c) => `- ${c}`).join('\n') : 'None reported.'}\n\n${marker}`;
}

export function runTimeline(run: WorkflowRun) {
  const events: {
    id: string;
    at: number;
    actor: 'code' | 'agent' | 'human';
    title: string;
    detail: string;
    attemptId?: string;
    conversationId?: string;
  }[] = [];
  for (const a of run.attempts) {
    events.push({
      id: a.id,
      at: a.startedAt,
      actor: ['developer', 'reviewer'].includes(a.stage) ? 'agent' : 'code',
      title: `${a.stage} · ${a.outcome ?? 'active'} · repair ${a.repair}`,
      detail: `${a.message ?? ''}${a.recoveryCount ? ` · ${a.recoveryCount} recovery event(s)` : ''}`,
      attemptId: a.id,
      conversationId: a.conversationId,
    });
    for (const [i, r] of (a.recoveries ?? []).entries())
      events.push({
        id: `${a.id}-recovery-${i}`,
        at: r.at,
        actor: 'code',
        title: `Recovered ${a.stage}`,
        detail: 'Existing attempt retained.',
        attemptId: a.id,
      });
  }
  for (const d of run.decisions)
    events.push({
      id: `decision-${d.operationId}`,
      at: d.at,
      actor: 'human',
      title: d.action.replaceAll('_', ' '),
      detail: d.detail,
    });
  for (const q of run.interventions)
    if (q.createdAt !== undefined)
      events.push({
        id: `question-${q.id}`,
        at: q.createdAt,
        actor: 'code',
        title: `Question · ${q.state}`,
        detail: q.question,
        attemptId: q.attemptId,
      });
  return events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** Best available durable update time, including legacy runs without activity records. */
export function runUpdatedAt(run: WorkflowRun) {
  return Math.max(
    run.createdAt,
    ...(run.activity ?? []).map((event) => event.at),
    ...run.decisions.map((decision) => decision.at),
    ...run.attempts.flatMap((attempt) => [
      attempt.startedAt,
      attempt.finishedAt ?? 0,
    ]),
    ...run.interventions.flatMap((question) => [
      question.createdAt ?? 0,
      question.resolvedAt ?? 0,
    ]),
  );
}
