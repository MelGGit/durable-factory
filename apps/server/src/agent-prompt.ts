import {
  currentImplementation,
  type RunEvidence,
  type StageAttempt,
  type WorkflowRun,
} from '../../../packages/shared/src/index.js';
import { tailText } from './agent-output.js';

/** Longest evidence output or answer text a prompt carries. */
const TEXT_BYTES = 8 * 1024;
const GUIDANCE_CHARS = 2000;
const POINTERS =
  'Nothing else is repeated here: workflow_evidence (current evidence, history on request), check_output (full command logs) and workflow_history (this conversation) hold the rest.';

export interface PromptScope {
  namedInTicket: string[];
  changedFiles?: string[];
  notNamedInTicket?: string[];
}
/** How this developer attempt relates to the earlier ones of the run. */
export type AttemptKind = 'first' | 'repair' | 'continue';

const bounded = (text: string, bytes = TEXT_BYTES) => {
  const tail = tailText(text, bytes);
  return tail.truncated ? `[earlier output dropped]\n${tail.text}` : tail.text;
};
const compact = (value: unknown) => JSON.stringify(value);
const answersOf = (run: WorkflowRun, since: number) =>
  run.interventions
    .filter((i) => i.state === 'resolved' && (i.resolvedAt ?? 0) >= since)
    .map((i) => ({
      question: bounded(i.question, GUIDANCE_CHARS),
      answer: bounded(i.answer ?? '', GUIDANCE_CHARS),
      ...(i.outOfScope ? { outOfScope: i.outOfScope } : {}),
    }));
const evidenceOf = (run: WorkflowRun) => [
  ...(run.evidenceHistory ?? []),
  ...run.evidence,
];
/** A check or review result in the form agents need: what ran, whether it passed, and why not. */
function summarize(evidence: RunEvidence) {
  return {
    kind: evidence.kind,
    passed: evidence.passed,
    ...(evidence.verdict ? { verdict: evidence.verdict } : {}),
    output: bounded(evidence.output),
    ...(evidence.results
      ? {
          commands: evidence.results.map((r) => ({
            command: r.command,
            exitCode: r.exitCode,
            artifact: r.artifact,
          })),
        }
      : {}),
    ...(evidence.regression
      ? {
          regression: {
            passed: evidence.regression.passed,
            message: evidence.regression.message,
            artifacts: evidence.regression.results.map((r) => r.artifact),
          },
        }
      : {}),
    ...(evidence.findings?.length ? { findings: evidence.findings } : {}),
  };
}

/** Where this developer attempt stands against the run's earlier developer attempts. */
export function attemptKind(run: WorkflowRun, attempt: StageAttempt) {
  const index = run.attempts.findIndex((a) => a.id === attempt.id),
    earlier = run.attempts.slice(0, index < 0 ? undefined : index);
  const previous = earlier.findLast((a) => a.stage === 'developer');
  const kind: AttemptKind = !previous
    ? 'first'
    : attempt.repair > previous.repair
      ? 'repair'
      : 'continue';
  return { kind, previous, earlier };
}

/**
 * The developer's input. The first attempt gets the ticket and the gate; a
 * repair gets the cause and what changed since; a continuation gets the
 * answers. Earlier attempts are already in the conversation and are never
 * resent.
 */
export function developerPrompt(
  run: WorkflowRun,
  attempt: StageAttempt,
  scope: PromptScope,
) {
  const { kind, previous, earlier } = attemptKind(run, attempt);
  const since = previous?.startedAt ?? 0;
  const base = {
    role: 'developer',
    contractVersion: run.contractVersion ?? 1,
    requiredChecks: run.configuration.requiredChecks,
    regressionProof: run.specification.regression?.required
      ? {
          command: run.specification.regression.command,
          expectedFailure: run.specification.regression.expectedFailure,
          testPaths: run.specification.regression.testPaths,
        }
      : undefined,
    base: run.base,
    workspace: run.workspace,
    answers: answersOf(run, since),
    guidance: run.inputs
      .filter((i) => i.status === 'consumed' && (i.at ?? 0) >= since)
      .map((i) => bounded(i.content, GUIDANCE_CHARS)),
  };
  const title = `issue #${run.issue.number} "${run.specification.title}"`;
  if (kind === 'first')
    return `You are the developer for ${title}. Implement the ticket below in the worktree, stay within its scope, check your work with run_required_checks, then call submit_implementation. The ticket and gate follow as JSON. Read AGENTS.md and repository instructions if present.\n\n${compact(
      {
        ...base,
        ticket: run.specification,
        issueUrl: run.issue.url,
        source: run.source,
        scope: { namedInTicket: scope.namedInTicket },
      },
    )}`;
  if (kind === 'continue')
    return `Continue the work on ${title}. You were paused or stopped; the user's answers and guidance since then follow as JSON. Finish the change, run run_required_checks, and submit an updated report. ${POINTERS}\n\n${compact(
      { ...base, source: run.source },
    )}`;
  const causes = (attempt.repairCauses ?? [])
    .flatMap((id) => {
      const found = evidenceOf(run).filter((e) => e.attemptId === id);
      const stage = run.attempts.find((a) => a.id === id);
      return found.length
        ? found.filter((e) => !e.passed).map(summarize)
        : stage?.message
          ? [
              {
                kind: stage.stage,
                passed: false,
                output: bounded(stage.message),
              },
            ]
          : [];
    })
    // A repair with no recorded cause came from the attempts since the last developer turn.
    .concat(
      attempt.repairCauses?.length
        ? []
        : earlier
            .slice(earlier.findLastIndex((a) => a.stage === 'developer') + 1)
            .filter((a) => a.outcome === 'failed' && a.message)
            .map((a) => ({
              kind: a.stage,
              passed: false,
              output: bounded(a.message!),
            })),
    );
  return `Repair ${attempt.repair} of ${run.repairLimit} for ${title}. Validation did not accept your last result; the failing checks or the reviewer's blocking findings follow as JSON, with output tails. Fix the causes, run run_required_checks, and submit an updated report that describes the complete change from the base. ${POINTERS}\n\n${compact(
    { ...base, causes, source: run.source },
  )}`;
}

/**
 * The reviewer's input: the ticket, the current report and evidence, and its
 * own earlier findings. Developer attempts, guidance and superseded reports
 * stay out; tools reach them if needed.
 */
export function reviewerPrompt(run: WorkflowRun, scope: PromptScope) {
  const evidence = run.evidence.filter((e) => e.kind !== 'reviewer');
  const earlier = evidenceOf(run)
    .filter((e) => e.kind === 'reviewer')
    .slice(-3)
    .map((e) => ({
      verdict: e.verdict,
      output: bounded(e.output, 4096),
      findings: e.findings,
    }));
  return `You are the independent reviewer for issue #${run.issue.number} "${run.specification.title}". Judge the candidate against the ticket using the tools; do not trust the developer's report. The ticket, the developer's current report, the check evidence and your earlier findings follow as JSON. Verify that each earlier blocking finding was resolved. ${POINTERS}\n\n${compact(
    {
      role: 'reviewer',
      contractVersion: run.contractVersion ?? 1,
      specification: run.specification,
      implementation: currentImplementation(run),
      base: run.base,
      source: run.source,
      evidence: evidence.map(summarize),
      earlierReviews: earlier,
      answers: answersOf(run, 0),
      scope,
    },
  )}`;
}
