import React, { useEffect, useMemo, useState } from 'react';
import { ModelSelection } from './model-selection.js';
import { OAuthConnection } from './oauth-connection.js';
import { useTheme, type ThemePreference } from './hooks/use-theme.js';
import {
  discardUnsavedChanges,
  useUnsavedChanges,
} from './hooks/use-unsaved-changes.js';
import {
  FactoryClient,
  ApiError,
  ROLES,
  type Settings,
  type SettingsResponse,
  type ProjectSummary,
  projectLabel,
  type CredentialId,
  type ProviderId,
  type RoleSettings,
  type TitleGeneratorSettings,
} from '../../../packages/shared/src/index.js';
export const names: Record<string, string> = {
  requesty: 'Requesty',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  github: 'GitHub',
  planning: 'Planning',
  development: 'Development',
  review: 'Review',
};
const descriptions: Record<string, string> = {
  planning: 'Shape the ticket and agree on the outcome.',
  development: 'Implement the agreed change and tests.',
  review: 'Independently inspect the result.',
};
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];
function AppearanceOptions() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="theme-options" role="radiogroup" aria-label="Theme">
      {THEME_OPTIONS.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={theme === option.value}
            onChange={() => setTheme(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
export function Settings({
  projectId,
  onChanged,
  onDeleted,
}: {
  projectId?: string;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const client = useMemo(
    () => new FactoryClient(undefined, undefined, projectId),
    [projectId],
  );
  const [saved, setSaved] = useState<SettingsResponse>();
  const [draft, setDraft] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [githubValidation, setGitHubValidation] = useState('');
  const [githubError, setGitHubError] = useState('');
  const [credentialInputs, setCredentialInputs] = useState({
    requesty: '',
    github: '',
  });
  const [credentialBusy, setCredentialBusy] = useState<CredentialId | null>(
    null,
  );
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [renaming, setRenaming] = useState<string>();
  const [runners, setRunners] = useState<number>();
  const [runnersDraft, setRunnersDraft] = useState('');
  const [runnersBusy, setRunnersBusy] = useState(false);
  const [titleSaved, setTitleSaved] = useState<TitleGeneratorSettings>();
  const [titleDraft, setTitleDraft] = useState<RoleSettings | null>(null);
  const [titleBusy, setTitleBusy] = useState(false);
  const titleDirty = Boolean(
    titleSaved &&
      JSON.stringify(titleSaved.selection) !== JSON.stringify(titleDraft),
  );
  const runnersDirty =
    runners !== undefined && String(runners) !== runnersDraft;
  const dirty = Boolean(
    saved && draft && JSON.stringify(saved.settings) !== JSON.stringify(draft),
  );
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      await client.connect();
      const response = await client.settings();
      setSaved(response);
      setDraft(response.settings);
      setProjects((await client.projects()).projects);
      const shared = await client.runners();
      setRunners(shared.runners);
      setRunnersDraft(String(shared.runners));
      const titles = await client.titleGenerator();
      setTitleSaved(titles);
      setTitleDraft(titles.selection);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the service.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [client]);
  useUnsavedChanges(
    dirty || (projectId === undefined && (titleDirty || runnersDirty)),
  );
  const change = (work: (next: Settings) => void) => {
    setDraft((previous) => {
      const next = structuredClone(previous!);
      work(next);
      return next;
    });
    setNotice('');
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || !saved) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await client.saveSettings({
        expectedRevision: saved.revision,
        settings: {
          ...draft,
          setupCommands: draft.setupCommands.filter((line) => line.trim()),
          requiredChecks: draft.requiredChecks.filter((line) => line.trim()),
        },
      });
      setSaved(response);
      setDraft(response.settings);
      setNotice('Settings saved.');
      onChanged();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Connection lost. Your edits are still here; reload to check whether the save completed.',
      );
    } finally {
      setBusy(false);
    }
  };
  const refreshCredentials = async () => {
    const response = await client.settings();
    setSaved((previous) =>
      previous
        ? {
            ...previous,
            credentials: response.credentials,
            credentialErrors: response.credentialErrors,
            credentialStorage: response.credentialStorage,
            providers: response.providers,
          }
        : response,
    );
  };
  const credential = async (id: CredentialId, remove = false) => {
    setCredentialBusy(id);
    setError('');
    setNotice('');
    try {
      if (remove) await client.deleteCredential(id);
      else
        await client.saveCredential(
          id,
          credentialInputs[id as 'requesty' | 'github'],
        );
      if (id === 'requesty' || id === 'github')
        setCredentialInputs((previous) => ({ ...previous, [id]: '' }));
      const response = await client.settings();
      setSaved((previous) =>
        previous
          ? {
              ...previous,
              credentials: response.credentials,
              credentialErrors: response.credentialErrors,
              credentialStorage: response.credentialStorage,
              providers: response.providers,
            }
          : response,
      );
      setNotice(
        `${names[id]} ${remove ? 'disconnected' : 'token saved privately'}.`,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not update the connection.',
      );
    } finally {
      setCredentialBusy(null);
    }
  };
  const projectName = saved
    ? projectLabel({
        name: saved.name,
        repository: draft?.repository ?? saved.settings.repository,
      })
    : 'Loading…';
  const project = projectId !== undefined;
  return (
    <div className="view settings-view">
      {error && (
        <div className="alert error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} disabled={busy}>
            Reload settings
          </button>
        </div>
      )}
      {notice && (
        <div className="alert success" role="status">
          ✓ {notice}
        </div>
      )}
      {!draft && !error && (
        <div className="loading" role="status">
          Opening your workspace…
        </div>
      )}
      {draft && saved && (
        <>
          {project && (
            <>
              <form onSubmit={save} id="settings-form">
                <fieldset className="settings-fields" disabled={busy}>
                  <section id="repository" className="settings-section">
                    <div className="section-heading">
                      <div>
                        <h2>Repository</h2>
                        <p>
                          Choose the checkout and base branch for future runs.
                        </p>
                      </div>
                    </div>
                    <div className="settings-content">
                      <label>
                        Local repository path
                        <input
                          value={draft.repository.path}
                          onChange={(e) =>
                            change((next) => {
                              next.repository.path = e.target.value;
                            })
                          }
                          placeholder="/Users/you/projects/your-repository"
                          autoComplete="off"
                        />
                        <small>
                          Absolute path to an existing Git repository on this
                          computer.
                        </small>
                      </label>
                      <div className="two-columns">
                        <label>
                          GitHub repository
                          <input
                            value={draft.repository.github}
                            onChange={(e) =>
                              change((next) => {
                                next.repository.github = e.target.value;
                              })
                            }
                            placeholder="owner/repository"
                            autoComplete="off"
                          />
                          <small>Use owner/repository, without spaces.</small>
                        </label>
                        <label>
                          Base branch
                          <input
                            value={draft.repository.baseBranch}
                            onChange={(e) =>
                              change((next) => {
                                next.repository.baseBranch = e.target.value;
                              })
                            }
                            placeholder="main"
                          />
                          <small>
                            The starting branch for future development runs.
                          </small>
                        </label>
                      </div>
                    </div>
                  </section>
                  <section className="settings-section">
                    <div className="section-heading">
                      <div>
                        <h2>Commit identity</h2>
                        <p>The author used for commits in future runs.</p>
                      </div>
                    </div>
                    <div className="two-columns">
                      <label>
                        Commit author name
                        <input
                          value={draft.commitIdentity.name}
                          onChange={(e) =>
                            change((next) => {
                              next.commitIdentity.name = e.target.value;
                            })
                          }
                        />
                      </label>
                      <label>
                        Commit author email
                        <input
                          type="email"
                          value={draft.commitIdentity.email}
                          onChange={(e) =>
                            change((next) => {
                              next.commitIdentity.email = e.target.value;
                            })
                          }
                        />
                      </label>
                    </div>
                  </section>
                  <section id="models" className="settings-section">
                    <div className="section-heading">
                      <div>
                        <h2>Models</h2>
                        <p>Set the provider and model for each role.</p>
                      </div>
                    </div>
                    <div className="role-grid">
                      {ROLES.map((role) => {
                        const selection = draft.roles[role];
                        const provider = saved.providers.find(
                          (item) => item.id === selection.provider,
                        );
                        const model = provider?.models.find(
                          (item) => item.id === selection.model,
                        );
                        return (
                          <article className="role-row" key={role}>
                            <div className="role-heading">
                              <h3>{names[role]}</h3>
                              <p>{descriptions[role]}</p>
                            </div>
                            <div className="role-controls">
                              <div>
                                <label htmlFor={`${role}-provider`}>
                                  Provider
                                </label>
                                <select
                                  id={`${role}-provider`}
                                  value={selection.provider ?? ''}
                                  onChange={(e) =>
                                    change((next) => {
                                      next.roles[role] = {
                                        provider: (e.target.value ||
                                          null) as ProviderId | null,
                                        model: '',
                                        reasoning: null,
                                      };
                                    })
                                  }
                                >
                                  <option value="">Choose a provider</option>
                                  {saved.providers.map((item) => (
                                    <option key={item.id} value={item.id}>
                                      {names[item.id]}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label htmlFor={`${role}-model`}>Model</label>
                                {selection.provider === 'requesty' ? (
                                  <input
                                    id={`${role}-model`}
                                    value={selection.model}
                                    placeholder="Exact Requesty model ID"
                                    onChange={(e) =>
                                      change((next) => {
                                        next.roles[role].model = e.target.value;
                                        next.roles[role].reasoning = null;
                                      })
                                    }
                                  />
                                ) : (
                                  <select
                                    id={`${role}-model`}
                                    disabled={!selection.provider}
                                    value={selection.model}
                                    onChange={(e) =>
                                      change((next) => {
                                        next.roles[role].model = e.target.value;
                                        next.roles[role].reasoning = null;
                                      })
                                    }
                                  >
                                    <option value="">Choose a model</option>
                                    {provider?.models.map((item) => (
                                      <option value={item.id} key={item.id}>
                                        {item.name}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </div>
                              <div>
                                <label htmlFor={`${role}-reasoning`}>
                                  Reasoning
                                </label>
                                <select
                                  id={`${role}-reasoning`}
                                  disabled={!model?.reasoning.length}
                                  value={selection.reasoning ?? ''}
                                  onChange={(e) =>
                                    change((next) => {
                                      next.roles[role].reasoning =
                                        e.target.value || null;
                                    })
                                  }
                                >
                                  <option value="">
                                    {model?.reasoning.length
                                      ? 'Provider default'
                                      : 'No verified options'}
                                  </option>
                                  {model?.reasoning.map((level) => (
                                    <option key={level} value={level}>
                                      {level}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="role-status">
                                <span
                                  className={`status-dot ${provider?.configured ? '' : 'unconfigured'}`}
                                />
                                {provider?.status === 'error'
                                  ? 'Connection needs attention'
                                  : provider?.configured
                                    ? 'Credentials stored'
                                    : 'Connection not configured'}
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                    <p className="section-footnote">
                      Model availability depends on your account. Reasoning
                      options appear when the model supports them.
                    </p>
                  </section>
                  <section id="execution" className="settings-section">
                    <div className="section-heading">
                      <div>
                        <h2>Commands</h2>
                        <p>
                          Run setup before development and required checks
                          before review.
                        </p>
                      </div>
                    </div>
                    <div className="settings-content">
                      <div className="two-columns">
                        <label>
                          Setup commands
                          <textarea
                            value={draft.setupCommands.join('\n')}
                            onChange={(e) =>
                              change((next) => {
                                next.setupCommands =
                                  e.target.value === ''
                                    ? []
                                    : e.target.value.split('\n');
                              })
                            }
                            placeholder={'bun install\nbun run build'}
                            rows={4}
                          />
                          <small>
                            One command per line. Leave empty if no setup is
                            needed.
                          </small>
                        </label>
                        <label>
                          Required checks
                          <textarea
                            value={draft.requiredChecks.join('\n')}
                            onChange={(e) =>
                              change((next) => {
                                next.requiredChecks =
                                  e.target.value === ''
                                    ? []
                                    : e.target.value.split('\n');
                              })
                            }
                            placeholder={'bun run check\nbun test'}
                            rows={4}
                          />
                          <small>
                            Every required check must pass before review.
                          </small>
                        </label>
                      </div>
                    </div>
                  </section>
                  <section className="settings-section">
                    <div className="section-heading">
                      <div>
                        <h2>Timeouts</h2>
                        <p>Maximum duration of each operation, in seconds.</p>
                      </div>
                    </div>
                    <div className="settings-content">
                      <div className="timeout-grid">
                        {Object.entries(draft.timeouts).map(([key, value]) => (
                          <label key={key}>
                            {key === 'cancellation'
                              ? 'Stop attempt'
                              : key.charAt(0).toUpperCase() + key.slice(1)}
                            <input
                              aria-label={`${key} timeout`}
                              type="number"
                              min={1}
                              max={86400}
                              required
                              value={value}
                              onChange={(e) =>
                                change((next) => {
                                  next.timeouts[
                                    key as keyof Settings['timeouts']
                                  ] = Number(e.target.value);
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  </section>
                </fieldset>
              </form>
              <div className="settings-section github-section">
                <div className="section-heading">
                  <div>
                    <h2>GitHub</h2>
                    <p>Check access to the saved repository.</p>
                  </div>
                </div>
                <div className="github-validation">
                  <p>
                    Use a token with Issues, Contents and Pull requests
                    read/write permissions. Save changes before validating;
                    validation only checks read access.
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || dirty}
                    onClick={() => {
                      setBusy(true);
                      setError('');
                      setGitHubValidation('');
                      setGitHubError('');
                      void client
                        .validateGitHub()
                        .then((result) => setGitHubValidation(result.message))
                        .catch((e) => setGitHubError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Validate GitHub repository
                  </button>
                  {githubValidation && <p role="status">{githubValidation}</p>}
                  {githubError && <p role="alert">{githubError}</p>}
                </div>
              </div>
              <section className="settings-section project-management">
                <div className="section-heading">
                  <div>
                    <h2>Project</h2>
                    <p>{projectName}</p>
                  </div>
                </div>
                <div className="project-actions">
                  {renaming === undefined ? (
                    <>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setRenaming(saved.name)}
                      >
                        Rename
                      </button>
                      {projects.length > 1 && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Delete project “${projectName}”? This only works once it has no conversations or runs.`,
                              )
                            )
                              return;
                            void client
                              .deleteProject(saved.projectId)
                              .then(() => {
                                discardUnsavedChanges();
                                onChanged();
                                onDeleted();
                              })
                              .catch((e) =>
                                setError(
                                  e instanceof Error
                                    ? e.message
                                    : 'Could not delete the project.',
                                ),
                              );
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </>
                  ) : (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void client
                          .renameProject(saved.projectId, renaming)
                          .then(() => {
                            setRenaming(undefined);
                            onChanged();
                            return load();
                          })
                          .catch((e) =>
                            setError(
                              e instanceof Error
                                ? e.message
                                : 'Could not rename the project.',
                            ),
                          );
                      }}
                    >
                      <label className="sr-only" htmlFor="rename-project">
                        Project name
                      </label>
                      <input
                        id="rename-project"
                        autoFocus
                        maxLength={80}
                        placeholder="Project name"
                        title="Leave empty to use the name of the project folder"
                        value={renaming}
                        onChange={(e) => setRenaming(e.target.value)}
                      />
                      <button className="secondary">Save name</button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setRenaming(undefined)}
                      >
                        Cancel
                      </button>
                    </form>
                  )}
                </div>
              </section>
              <footer className="save-bar">
                <div>
                  <strong>
                    {dirty ? 'Unsaved changes' : 'All changes saved'}
                  </strong>
                </div>
                <div>
                  <button
                    className="text-button"
                    type="button"
                    disabled={!dirty || busy}
                    onClick={() => {
                      setDraft(structuredClone(saved.settings));
                      setError('');
                      setNotice('');
                    }}
                  >
                    Discard edits
                  </button>
                  <button
                    className="primary"
                    type="submit"
                    form="settings-form"
                    disabled={!dirty || busy}
                  >
                    {busy ? 'Saving…' : 'Save settings'}
                  </button>
                </div>
              </footer>
            </>
          )}
          {!project && (
            <>
              <section id="appearance" className="settings-section">
                <div className="section-heading">
                  <div>
                    <h2>Appearance</h2>
                    <p>Choose a light or dark look, or follow your system.</p>
                  </div>
                </div>
                <div className="settings-content">
                  <AppearanceOptions />
                </div>
              </section>
              <section id="connections" className="settings-section">
                <div className="section-heading">
                  <div>
                    <h2>Your connections</h2>
                    <p>
                      Model and GitHub connections shared across all projects.
                    </p>
                  </div>
                </div>
                <div className="connections-list">
                  {(['requesty', 'openai', 'anthropic', 'github'] as const).map(
                    (id) => (
                      <div className="connection-row" key={id}>
                        <div className="connection-name">
                          <div>
                            <h3>{names[id]}</h3>
                            <span>
                              {id === 'github'
                                ? 'Repository token'
                                : id === 'requesty'
                                  ? 'API connection'
                                  : 'Subscription sign-in'}
                            </span>
                          </div>
                        </div>
                        <span
                          className={`connection-state ${saved.credentialErrors[id] ? 'needs-attention' : saved.credentials[id] ? 'configured' : ''}`}
                        >
                          {saved.credentialErrors[id]
                            ? 'Needs attention'
                            : saved.credentials[id]
                              ? 'Credentials stored'
                              : 'Not connected'}
                        </span>
                        {saved.credentialErrors[id] && (
                          <p className="connection-error" role="alert">
                            {saved.credentialErrors[id]}
                          </p>
                        )}
                        <div className="connection-actions">
                          {id === 'requesty' || id === 'github' ? (
                            <form
                              className="credential-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void credential(id);
                              }}
                            >
                              <label
                                className="sr-only"
                                htmlFor={`${id}-token`}
                              >
                                {names[id]} token
                              </label>
                              <input
                                id={`${id}-token`}
                                disabled={credentialBusy !== null}
                                type="password"
                                autoComplete="new-password"
                                value={credentialInputs[id]}
                                placeholder={
                                  saved.credentials[id]
                                    ? 'Replace token'
                                    : 'Enter token'
                                }
                                onChange={(e) =>
                                  setCredentialInputs((previous) => ({
                                    ...previous,
                                    [id]: e.target.value,
                                  }))
                                }
                              />
                              <button
                                type="submit"
                                className="secondary"
                                disabled={
                                  !credentialInputs[id] ||
                                  credentialBusy !== null
                                }
                              >
                                {credentialBusy === id
                                  ? 'Saving…'
                                  : 'Store token'}
                              </button>
                            </form>
                          ) : (
                            <OAuthConnection
                              client={client}
                              provider={id}
                              configured={saved.credentials[id]}
                              changed={refreshCredentials}
                            />
                          )}
                          {(saved.credentials[id] ||
                            saved.credentialErrors[id]) && (
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => void credential(id, true)}
                              disabled={credentialBusy !== null}
                            >
                              {saved.credentialErrors[id]
                                ? 'Remove connection'
                                : 'Disconnect'}
                            </button>
                          )}
                        </div>
                      </div>
                    ),
                  )}
                  <div className="connection-help">
                    <p>
                      Stored in {saved.credentialStorage.backend} on this
                      computer.{' '}
                      {saved.credentialStorage.status === 'ready'
                        ? 'Secure storage is ready.'
                        : 'Unlock your system vault and retry secure storage.'}{' '}
                      Saving a connection does not verify model access.
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={credentialBusy !== null}
                      onClick={() => {
                        setCredentialBusy('openai');
                        setError('');
                        void client
                          .retryCredentialStorage()
                          .then(refreshCredentials)
                          .catch((error) =>
                            setError(
                              error instanceof Error
                                ? error.message
                                : 'Could not retry secure storage.',
                            ),
                          )
                          .finally(() => setCredentialBusy(null));
                      }}
                    >
                      Retry secure storage
                    </button>
                  </div>
                </div>
              </section>
              {runners !== undefined && (
                <form
                  className="settings-section runners-block"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setRunnersBusy(true);
                    setError('');
                    void client
                      .saveRunners(Number(runnersDraft))
                      .then((result) => {
                        setRunners(result.runners);
                        setRunnersDraft(String(result.runners));
                        setNotice(
                          `Up to ${result.runners} run${result.runners === 1 ? '' : 's'} will work at once.`,
                        );
                      })
                      .catch((e) =>
                        setError(
                          e instanceof Error
                            ? e.message
                            : 'Could not save parallel runs.',
                        ),
                      )
                      .finally(() => setRunnersBusy(false));
                  }}
                >
                  <div>
                    <h2>Execution</h2>
                    <p>Runs start oldest first across every project.</p>
                  </div>
                  <label>
                    Parallel runs
                    <input
                      type="number"
                      min="1"
                      max="16"
                      step="1"
                      required
                      disabled={runnersBusy}
                      value={runnersDraft}
                      onChange={(e) => setRunnersDraft(e.target.value)}
                    />
                    <small>
                      1–16 at once. Active runs continue if this is lowered.
                    </small>
                  </label>
                  <button
                    className="secondary"
                    disabled={!runnersDirty || runnersBusy}
                  >
                    {runnersBusy ? 'Saving…' : 'Save'}
                  </button>
                </form>
              )}
              {titleSaved && (
                <form
                  className="settings-section title-generator"
                  aria-label="Title generator"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setTitleBusy(true);
                    setError('');
                    setNotice('');
                    void client
                      .saveTitleGenerator({
                        revision: titleSaved.revision,
                        selection: titleDraft,
                      })
                      .then((value) => {
                        setTitleSaved(value);
                        setTitleDraft(value.selection);
                        setNotice('Title generator saved.');
                      })
                      .catch((e) =>
                        setError(
                          e instanceof Error
                            ? e.message
                            : 'Could not save title generator.',
                        ),
                      )
                      .finally(() => setTitleBusy(false));
                  }}
                >
                  <h2>Title generator</h2>
                  <p>
                    Automatically name new planning chats. A small model works
                    well.
                  </p>
                  <fieldset disabled={titleBusy} className="settings-fields">
                    <ModelSelection
                      selection={titleDraft}
                      providers={saved.providers}
                      onChange={(value) => {
                        setTitleDraft(value);
                        setNotice('');
                      }}
                    />
                  </fieldset>
                  <div className="title-generator-footer">
                    <p>
                      Uses the first message when no model is selected or
                      available. Existing titles stay unchanged.
                    </p>
                    <button
                      type="submit"
                      className="secondary"
                      disabled={
                        !titleDirty ||
                        titleBusy ||
                        Boolean(titleDraft && !titleDraft.model.trim())
                      }
                    >
                      {titleBusy ? 'Saving…' : 'Save title generator'}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
