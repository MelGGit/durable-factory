import React, { useState } from 'react';
import { Icon } from './icons.js';
import {
  projectLabel,
  runUpdatedAt,
  type ConversationSummary,
  type ProjectSummary,
  type WorkflowRun,
} from '../../../packages/shared/src/index.js';

const collapsedKey = 'factory.sidebar.collapsed';
const readCollapsed = (): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]');
    return Array.isArray(value)
      ? value.filter((v) => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
};

/** Projects as collapsible groups, each one list of its planning chats and runs. */
/** Lets a plain left-click navigate inside the app; other clicks keep browser behaviour. */
export function followLink(event: React.MouseEvent, go: () => void) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  go();
}

const settingsPath = (id: string) =>
  `/projects/${encodeURIComponent(id)}/settings`;

export function ProjectTree({
  projects,
  conversations,
  runs,
  workflowDisabled,
  renderConversation,
  renderRun,
  onNew,
  navigate,
  activeSettings,
}: {
  projects: ProjectSummary[];
  conversations: ConversationSummary[];
  runs: WorkflowRun[];
  workflowDisabled: boolean;
  renderConversation: (item: ConversationSummary) => React.ReactNode;
  renderRun: (run: WorkflowRun) => React.ReactNode;
  onNew: (projectId: string) => void;
  navigate: (path: string) => void;
  activeSettings?: string;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (id: string) => {
    const next = collapsed.includes(id)
      ? collapsed.filter((item) => item !== id)
      : [...collapsed, id];
    setCollapsed(next);
    try {
      localStorage.setItem(collapsedKey, JSON.stringify(next));
    } catch {
      /* The tree still works for this page view. */
    }
  };
  return (
    <div className="project-tree">
      {projects.map((project) => {
        // Chats and runs share one list, newest first; a label tells them apart.
        const sessions = [
          ...conversations
            .filter(
              (item) =>
                item.projectId === project.id &&
                item.role === 'planning' &&
                !item.runId,
            )
            .map((item) => ({
              at: Date.parse(item.createdAt) || 0,
              node: renderConversation(item),
            })),
          ...runs
            .filter((run) => run.projectId === project.id)
            .map((run) => ({ at: runUpdatedAt(run), node: renderRun(run) })),
        ].sort((a, b) => b.at - a.at);
        const open = !collapsed.includes(project.id);
        const missing = project.missingPrerequisites ?? [];
        const name = projectLabel(project);
        return (
          <section key={project.id} className="project-group" aria-label={name}>
            <div className="project-header">
              <button
                type="button"
                className="project-toggle"
                aria-expanded={open}
                onClick={() => toggle(project.id)}
              >
                <Icon name="folder" />
                <strong>{name}</strong>
                <small>
                  {project.repository.github || 'No repository yet'}
                </small>
              </button>
              <button
                type="button"
                className="project-new"
                aria-label={`Start a chat in ${name}`}
                title="New conversation"
                onClick={() => onNew(project.id)}
              >
                <Icon name="plus" />
              </button>
              <a
                className="project-settings"
                href={settingsPath(project.id)}
                aria-current={
                  activeSettings === project.id ? 'page' : undefined
                }
                onClick={(event) =>
                  followLink(event, () => navigate(settingsPath(project.id)))
                }
                aria-label={`Settings for ${name}`}
                title="Project settings"
              >
                <Icon name="settings" />
              </a>
            </div>
            {open && (
              <div className="project-body">
                <nav aria-label={`${name} sessions`}>
                  {sessions.map((session) => session.node)}
                </nav>
                {!workflowDisabled && missing.length > 0 && (
                  <p className="navigation-hint">
                    Complete settings: {missing.join(', ')}
                  </p>
                )}
                {workflowDisabled && (
                  <p className="navigation-hint">
                    Implementation starts are unavailable.
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
