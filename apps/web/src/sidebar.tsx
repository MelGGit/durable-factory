import React, { useState } from 'react';
import {
  FactoryClient,
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
export function ProjectTree({
  projects,
  conversations,
  runs,
  workflowDisabled,
  renderConversation,
  renderRun,
  onNew,
}: {
  projects: ProjectSummary[];
  conversations: ConversationSummary[];
  runs: WorkflowRun[];
  workflowDisabled: boolean;
  renderConversation: (item: ConversationSummary) => React.ReactNode;
  renderRun: (run: WorkflowRun) => React.ReactNode;
  onNew: (projectId: string) => void;
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
                <span aria-hidden="true">{open ? '▾' : '▸'}</span>
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
                ＋
              </button>
              <a
                className="project-settings"
                href={`/settings?project=${encodeURIComponent(project.id)}`}
                aria-label={`Settings for ${name}`}
                title="Project settings"
              >
                ⚙
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

/** Creates a project, then opens its settings to point it at a repository. */
export function AddProject({ client }: { client: FactoryClient }) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (!open)
    return (
      <button
        type="button"
        className="text-button add-project"
        onClick={() => setOpen(true)}
      >
        Add project ＋
      </button>
    );
  return (
    <form
      className="add-project-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        void client
          .createProject(name)
          .then((project) =>
            window.location.assign(
              `/settings?project=${encodeURIComponent(project.id)}`,
            ),
          )
          .catch((e) => {
            setError(e instanceof Error ? e.message : 'Could not add project.');
            setBusy(false);
          });
      }}
    >
      <label className="sr-only" htmlFor="project-name">
        Project name
      </label>
      <input
        id="project-name"
        autoFocus
        placeholder="Project name"
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button className="secondary" disabled={busy || !name.trim()}>
        {busy ? 'Adding…' : 'Create project'}
      </button>
      <button
        type="button"
        className="text-button"
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
