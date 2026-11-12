import {
  acceptsTypedAnswer,
  type Intervention,
  type WorkflowRun,
} from '../../../packages/shared/src/index.js';

export interface RunSummary {
  id: string;
  status: WorkflowRun['status'];
  stage: WorkflowRun['stage'];
  issue: number;
  repair: number;
  repairLimit: number;
  worktree?: string;
  branch?: string;
  /** Whether the developer agent may be writing to the worktree right now. */
  worktreeBusy: boolean;
  question?: { id: string; text: string; acceptsAnswer: boolean };
  cleanup?: WorkflowRun['cleanup'];
  pr?: number;
}

/** Statuses in which no stage of this run writes to its worktree. */
const QUIET: WorkflowRun['status'][] = [
  'paused',
  'needs_input',
  'cancelled',
  'pr_ready',
  'termination_blocker',
  'queued',
];

export const pendingQuestion = (run: WorkflowRun): Intervention | undefined =>
  run.interventions.find((item) => item.state === 'pending');

export function summarize(run: WorkflowRun): RunSummary {
  const question = pendingQuestion(run);
  return {
    id: run.id,
    status: run.status,
    stage: run.stage,
    issue: run.issue.number,
    repair: run.repairCount,
    repairLimit: run.repairLimit,
    worktree: run.workspace?.path,
    branch: run.workspace?.branch,
    worktreeBusy: !QUIET.includes(run.status),
    ...(question
      ? {
          question: {
            id: question.id,
            text: question.question,
            acceptsAnswer: acceptsTypedAnswer(question),
          },
        }
      : {}),
    ...(run.cleanup ? { cleanup: run.cleanup } : {}),
    ...(run.publication?.prNumber ? { pr: run.publication.prNumber } : {}),
  };
}

/** One line per run, for a terminal. */
export function line(run: RunSummary) {
  const parts = [
    run.id,
    `#${run.issue}`,
    `${run.status}/${run.stage}`,
    run.repair ? `repair ${run.repair}/${run.repairLimit}` : '',
    run.pr ? `PR #${run.pr}` : '',
    run.question ? `? ${run.question.text.split('\n')[0]}` : '',
    run.cleanup ? `cleanup ${run.cleanup.state}: ${run.cleanup.message}` : '',
  ];
  return parts.filter(Boolean).join('  ');
}

/** A short status for a worktree comment. */
export const comment = (run: RunSummary) =>
  run.question
    ? `needs input: ${run.question.text.split('\n')[0]}`.slice(0, 200)
    : `${run.status} / ${run.stage}${run.repair ? ` (repair ${run.repair})` : ''}${run.pr ? ` · PR #${run.pr}` : ''}`;
