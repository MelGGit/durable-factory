import React from 'react';
import { ProjectIssues } from './project-issues.js';
import {
  projectLabel,
  runUpdatedAt,
  type ConversationSummary,
  type ProjectSummary,
  type WorkflowRun,
  type DeletionOperation,
  type WorkflowSnapshot,
} from '../../../packages/shared/src/index.js';
import { Icon } from './icons.js';
import { RunStatusBadge, runNeedsAttention, stageLabel } from './run-status.js';

const when = (at: number) =>
  at
    ? new Date(at).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '';

export function Home({
  projects,
  conversations,
  runs,
  deletions,
  onNew,
  onOpen,
  onRun,
  workflowMode,
}: {
  projects: ProjectSummary[];
  conversations: ConversationSummary[];
  runs: WorkflowRun[];
  deletions: DeletionOperation[];
  onNew: (projectId: string) => void;
  onOpen: (conversationId: string) => void;
  onRun: (run: WorkflowRun) => void;
  workflowMode: WorkflowSnapshot['mode'];
}) {
  const names = new Map(projects.map((p) => [p.id, projectLabel(p)]));
  const blocked = deletions.filter((d) => d.state === 'blocked');
  const deletingIds = new Set(
    deletions
      .filter((d) => d.state !== 'completed')
      .flatMap((d) => d.conversationIds),
  );
  const availableRuns = runs.filter(
    (r) => !deletingIds.has(r.developerConversationId),
  );
  const attention = availableRuns
    .filter(runNeedsAttention)
    .sort((a, b) => runUpdatedAt(b) - runUpdatedAt(a));
  const active = availableRuns
    .filter(
      (r) =>
        !runNeedsAttention(r) &&
        ['running', 'queued', 'pausing', 'cancelling'].includes(r.status),
    )
    .sort((a, b) =>
      a.status === 'queued' && b.status === 'queued'
        ? a.queueOrder - b.queueOrder
        : runUpdatedAt(b) - runUpdatedAt(a),
    );
  const featured = new Set([...attention, ...active].map((r) => r.id));
  const recent = [
    ...conversations
      .filter(
        (c) => c.role === 'planning' && !c.runId && !deletingIds.has(c.id),
      )
      .map((c) => ({
        key: `chat:${c.id}`,
        open: c.id,
        at: Date.parse(c.createdAt) || 0,
        title: c.title,
        project: names.get(c.projectId) ?? '',
        run: undefined as WorkflowRun | undefined,
      })),
    ...availableRuns
      .filter((r) => !featured.has(r.id))
      .map((r) => ({
        key: `run:${r.id}`,
        open: r.developerConversationId,
        at: runUpdatedAt(r),
        title: `#${r.issue.number} · ${r.specification.title}`,
        project: names.get(r.projectId) ?? '',
        run: r,
      })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);
  const returning =
    conversations.length > 0 ||
    runs.length > 0 ||
    blocked.length > 0 ||
    projects.some((project) => Boolean(project.repository.github));
  const queue = new Map(
    runs
      .filter((r) => r.status === 'queued')
      .sort((a, b) => a.queueOrder - b.queueOrder)
      .map((r, i) => [r.id, i + 1]),
  );
  const renderRuns = (items: WorkflowRun[]) => (
    <ul className="home-recent home-work">
      {items.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            onClick={() => onOpen(run.developerConversationId)}
          >
            <Icon name="run" />
            <span className="home-recent-title">
              <strong>
                #{run.issue.number} · {run.specification.title}
              </strong>
              <small>
                {names.get(run.projectId)} ·{' '}
                {run.mode === 'simulation' ? 'Simulation · ' : ''}
                {run.status === 'queued'
                  ? `Queue position ${queue.get(run.id)}`
                  : stageLabel(run.stage)}
              </small>
              {(run.cleanup?.state === 'blocked' || runNeedsAttention(run)) && (
                <span className="home-work-reason">
                  {run.cleanup?.state === 'blocked'
                    ? run.cleanup.message
                    : run.interventions.findLast((i) => i.state === 'pending')
                        ?.reason ||
                      run.activity?.at(-1)?.detail ||
                      'Open this run to review available actions.'}
                </span>
              )}
            </span>
            <RunStatusBadge status={run.status} />
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="home">
      <div className="home-inner">
        <h2>{returning ? 'Your workspace' : 'Start with a conversation.'}</h2>
        <p className="home-lead">
          {returning
            ? 'Choose an issue to implement, refine it with the planning agent, or start a new conversation.'
            : 'Inspect a repository, agree a ticket with the planning agent, then hand it to an implementation run. Everything stays here when you return.'}
        </p>
        {(attention.length > 0 || blocked.length > 0) && (
          <section aria-label="Needs attention">
            <h3 className="home-section">Needs attention</h3>
            {attention.length > 0 && renderRuns(attention)}
            {blocked.length > 0 && (
              <ul className="home-recent home-blocked">
                {blocked.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(d.conversationIds[0])}
                    >
                      <Icon name="trash" />
                      <span className="home-recent-title">
                        <strong>Deletion needs attention</strong>
                        <span className="home-work-reason">{d.message}</span>
                      </span>
                      <span className="run-status-badge status-danger">
                        Blocked
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {active.length > 0 && (
          <section aria-label="In progress">
            <h3 className="home-section">In progress</h3>
            {renderRuns(active)}
          </section>
        )}
        {recent.length > 0 && (
          <section aria-label="Recent activity">
            <h3 className="home-section">Recent activity</h3>
            <ul className="home-recent">
              {recent.map((item) => (
                <li key={item.key}>
                  <button type="button" onClick={() => onOpen(item.open)}>
                    <Icon name={item.run ? 'run' : 'chat'} />
                    <span className="home-recent-title">
                      <strong>{item.title}</strong>
                      <small>
                        {item.run ? 'Implementation' : 'Planning'}
                        {item.project ? ` · ${item.project}` : ''}
                        {item.run?.mode === 'simulation' ? ' · Simulation' : ''}
                      </small>
                    </span>
                    {item.run && <RunStatusBadge status={item.run.status} />}
                    <time>{when(item.at)}</time>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section aria-label="Projects">
          <h3 className="home-section">Projects</h3>
          <div className="home-projects">
            {projects.map((project) => (
              <section
                key={project.id}
                className="home-card home-project"
                aria-label={`${projectLabel(project)} issues`}
              >
                <div className="home-card-head">
                  <Icon name="folder" />
                  <strong>{projectLabel(project)}</strong>
                </div>
                <small>
                  {project.repository.github || 'No repository yet'}
                </small>
                {!!project.missingPrerequisites?.length && (
                  <p className="home-hint">
                    Complete settings: {project.missingPrerequisites.join(', ')}
                  </p>
                )}
                <div className="home-card-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onNew(project.id)}
                  >
                    New chat
                  </button>
                  <a
                    className="secondary"
                    href={`/projects/${encodeURIComponent(project.id)}/settings`}
                  >
                    Project settings
                  </a>
                </div>
                <ProjectIssues
                  project={project}
                  runs={availableRuns}
                  mode={workflowMode}
                  onRun={onRun}
                  onOpen={onOpen}
                />
              </section>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
