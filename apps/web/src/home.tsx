import React from 'react';
import {
  projectLabel,
  runUpdatedAt,
  type ConversationSummary,
  type ProjectSummary,
  type WorkflowRun,
} from '../../../packages/shared/src/index.js';
import { Icon } from './icons.js';

const when = (at: number) =>
  at
    ? new Date(at).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '';

/** Landing view: where to start in each project, and what happened recently. */
export function Home({
  projects,
  conversations,
  runs,
  onNew,
  onOpen,
}: {
  projects: ProjectSummary[];
  conversations: ConversationSummary[];
  runs: WorkflowRun[];
  onNew: (projectId: string) => void;
  onOpen: (conversationId: string) => void;
}) {
  const names = new Map(projects.map((p) => [p.id, projectLabel(p)]));
  const recent = [
    ...conversations
      .filter((item) => item.role === 'planning' && !item.runId)
      .map((item) => ({
        key: item.id,
        open: item.id,
        at: Date.parse(item.createdAt) || 0,
        kind: 'Planning',
        title: item.title,
        project: names.get(item.projectId) ?? '',
        status: '',
      })),
    ...runs.map((run) => ({
      key: run.id,
      open: run.developerConversationId,
      at: runUpdatedAt(run),
      kind: 'Implementation',
      title: `#${run.issue.number} · ${run.specification.title}`,
      project: names.get(run.projectId) ?? '',
      status: run.status.replaceAll('_', ' '),
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);
  return (
    <div className="home">
      <div className="home-inner">
        <h2>Start with a conversation.</h2>
        <p className="home-lead">
          Inspect a repository, agree a ticket with the planning agent, then
          hand it to an implementation run. Everything stays here when you
          return.
        </p>
        <h3 className="home-section">Projects</h3>
        <div className="home-projects">
          {projects.map((project) => {
            const missing = project.missingPrerequisites ?? [];
            return (
              <article key={project.id} className="home-card">
                <div className="home-card-head">
                  <Icon name="folder" />
                  <strong>{projectLabel(project)}</strong>
                </div>
                <small>
                  {project.repository.github || 'No repository yet'}
                </small>
                {missing.length > 0 && (
                  <p className="home-hint">
                    Complete settings: {missing.join(', ')}
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
                    href={`/settings?project=${encodeURIComponent(project.id)}`}
                  >
                    Project settings
                  </a>
                </div>
              </article>
            );
          })}
        </div>
        {recent.length > 0 && (
          <>
            <h3 className="home-section">Recent activity</h3>
            <ul className="home-recent">
              {recent.map((item) => (
                <li key={item.key}>
                  <button type="button" onClick={() => onOpen(item.open)}>
                    <Icon name={item.kind === 'Planning' ? 'chat' : 'run'} />
                    <span className="home-recent-title">
                      <strong>{item.title}</strong>
                      <small>
                        {item.kind}
                        {item.project ? ` · ${item.project}` : ''}
                        {item.status ? ` · ${item.status}` : ''}
                      </small>
                    </span>
                    <time>{when(item.at)}</time>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
