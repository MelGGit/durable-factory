import React from 'react';
import type {
  RunStatus,
  WorkflowRun,
} from '../../../packages/shared/src/index.js';

const states: Record<RunStatus, { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'active' },
  pausing: { label: 'Pausing', tone: 'attention' },
  paused: { label: 'Paused', tone: 'attention' },
  needs_input: { label: 'Needs input', tone: 'attention' },
  cancelling: { label: 'Cancelling', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  termination_blocker: { label: 'Unable to stop', tone: 'danger' },
  pr_ready: { label: 'PR ready', tone: 'active' },
};
export function RunStatusBadge({ status }: { status: RunStatus }) {
  const state = states[status];
  return (
    <span className={`run-status-badge status-${state.tone}`}>
      {state.label}
    </span>
  );
}
export const runNeedsAttention = (run: WorkflowRun) =>
  ['paused', 'needs_input', 'termination_blocker'].includes(run.status) ||
  run.cleanup?.state === 'blocked';
export const stageLabel = (stage: WorkflowRun['stage']) =>
  ({
    setup: 'Setup',
    baseline: 'Baseline checks',
    developer: 'Development',
    checks: 'Checks',
    reviewer: 'Review',
    publication: 'Preparing PR',
    publishing: 'Publishing PR',
  })[stage];
