import React, { useEffect, useState } from 'react';
import {
  FactoryClient,
  ROLES,
  type ProviderId,
  type Settings,
  type SettingsResponse,
} from '../../../packages/shared/src/index.js';

const client = new FactoryClient();
const roleNames = {
  planning: 'Planning',
  development: 'Development',
  review: 'Review',
} as const;
const providerNames: Record<string, string> = {
  requesty: 'Requesty',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};
const lines = (value: string) => (value === '' ? [] : value.split('\n'));

/** Creates a project with its repository, models and checks in one step. */
export function AddProjectPage() {
  const [name, setName] = useState(''),
    [defaults, setDefaults] = useState<SettingsResponse>(),
    [draft, setDraft] = useState<Settings>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    // Providers and their models are shared; a new project starts from the defaults.
    client
      .connect()
      .then(() => client.settings())
      .then((response) => {
        setDefaults(response);
        setDraft(response.settings);
      })
      .catch((e) =>
        setError(
          e instanceof Error ? e.message : 'Could not reach the service.',
        ),
      );
  }, []);
  const change = (work: (next: Settings) => void) =>
    setDraft((previous) => {
      const next = structuredClone(previous!);
      work(next);
      return next;
    });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const project = await client.createProject(name);
      const scoped = new FactoryClient(undefined, undefined, project.id);
      const current = await scoped.settings();
      await scoped.saveSettings({
        expectedRevision: current.revision,
        settings: {
          ...current.settings,
          repository: draft.repository,
          roles: draft.roles,
          setupCommands: draft.setupCommands.filter((line) => line.trim()),
          requiredChecks: draft.requiredChecks.filter((line) => line.trim()),
        },
      });
      window.location.assign('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the project.');
      setBusy(false);
    }
  };
  return (
    <main className="add-project-page">
      <form className="add-project-card" onSubmit={submit}>
        <a className="text-button" href="/">
          ← Back to Home
        </a>
        <h1>Add project</h1>
        <p>
          A project is one repository with its own conversations and runs. You
          can change everything later in its settings.
        </p>
        <fieldset disabled={busy || !draft}>
          <h2>Project</h2>
          <label htmlFor="project-name">Project name</label>
          <input
            id="project-name"
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <small>Leave empty to use the name of the repository folder.</small>
          <h2>Repository</h2>
          <label htmlFor="project-path">Local repository path</label>
          <input
            id="project-path"
            autoComplete="off"
            placeholder="/Users/you/projects/your-repository"
            value={draft?.repository.path ?? ''}
            onChange={(e) =>
              change((next) => {
                next.repository.path = e.target.value;
              })
            }
          />
          <div className="add-project-columns">
            <div>
              <label htmlFor="project-github">GitHub repository</label>
              <input
                id="project-github"
                autoComplete="off"
                placeholder="owner/repository"
                value={draft?.repository.github ?? ''}
                onChange={(e) =>
                  change((next) => {
                    next.repository.github = e.target.value;
                  })
                }
              />
            </div>
            <div>
              <label htmlFor="project-branch">Base branch</label>
              <input
                id="project-branch"
                placeholder="main"
                value={draft?.repository.baseBranch ?? ''}
                onChange={(e) =>
                  change((next) => {
                    next.repository.baseBranch = e.target.value;
                  })
                }
              />
            </div>
          </div>
          <h2>Models</h2>
          <div className="add-project-roles">
            {draft &&
              defaults &&
              ROLES.map((role) => {
                const selection = draft.roles[role];
                const provider = defaults.providers.find(
                  (item) => item.id === selection.provider,
                );
                const model = provider?.models.find(
                  (item) => item.id === selection.model,
                );
                return (
                  <div key={role} className="add-project-role">
                    <h3>{roleNames[role]}</h3>
                    <label htmlFor={`${role}-provider`}>Provider</label>
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
                      {defaults.providers.map((item) => (
                        <option key={item.id} value={item.id}>
                          {providerNames[item.id] ?? item.id}
                        </option>
                      ))}
                    </select>
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
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <label htmlFor={`${role}-reasoning`}>Reasoning</label>
                    <select
                      id={`${role}-reasoning`}
                      disabled={!model?.reasoning.length}
                      value={selection.reasoning ?? ''}
                      onChange={(e) =>
                        change((next) => {
                          next.roles[role].reasoning = e.target.value || null;
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
                );
              })}
          </div>
          <small>
            Provider tokens are shared by every project and are managed in
            Settings.
          </small>
          <h2>Checks</h2>
          <div className="add-project-columns">
            <div>
              <label htmlFor="project-setup">Setup commands</label>
              <textarea
                id="project-setup"
                rows={3}
                placeholder={'bun install'}
                value={draft?.setupCommands.join('\n') ?? ''}
                onChange={(e) =>
                  change((next) => {
                    next.setupCommands = lines(e.target.value);
                  })
                }
              />
            </div>
            <div>
              <label htmlFor="project-checks">Required checks</label>
              <textarea
                id="project-checks"
                rows={3}
                placeholder={'bun run check\nbun test'}
                value={draft?.requiredChecks.join('\n') ?? ''}
                onChange={(e) =>
                  change((next) => {
                    next.requiredChecks = lines(e.target.value);
                  })
                }
              />
            </div>
          </div>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <div className="add-project-actions">
          <button className="primary" disabled={busy || !draft}>
            {busy ? 'Adding…' : 'Create project'}
          </button>
          <a className="secondary" href="/">
            Cancel
          </a>
        </div>
      </form>
    </main>
  );
}
