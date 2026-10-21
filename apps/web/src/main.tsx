import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FactoryClient,
  ApiError,
  ROLES,
  type Settings,
  type SettingsResponse,
  type CredentialId,
  type ProviderId,
} from '../../../packages/shared/src/index.js';
import './style.css';
const client = new FactoryClient();
const names: Record<string, string> = {
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
function App() {
  const [saved, setSaved] = useState<SettingsResponse>();
  const [draft, setDraft] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [credentialInputs, setCredentialInputs] = useState({
    requesty: '',
    github: '',
  });
  const [credentialBusy, setCredentialBusy] = useState<CredentialId | null>(
    null,
  );
  const [tab, setTab] = useState('repository');
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the service.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
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
      setNotice('Settings saved. They will be here when you return.');
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
  const links = [
    ['repository', '01', 'Repository'],
    ['models', '02', 'Agent models'],
    ['execution', '03', 'Execution'],
    ['connections', '04', 'Connections'],
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="Durable Factory home">
          <span className="brand-mark">
            df<span>↗</span>
          </span>
          <span>
            durable
            <br />
            factory<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="sidebar-label">YOUR WORKSPACE</div>
        <div className="workspace">
          <span className="workspace-icon">⌘</span>
          <div>
            Personal workspace<small>Local · single repository</small>
          </div>
        </div>
        <div className="sidebar-label nav-heading">FOUNDATION</div>
        <nav aria-label="Settings sections">
          {links.map(([id, number, label]) => (
            <a
              key={id}
              href={`#${id}`}
              onClick={() => setTab(id)}
              className={tab === id ? 'active' : ''}
            >
              <span>{number}</span>
              {label}
              <b>↗</b>
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          <span>
            Built to keep going<small>Durable state. Local ownership.</small>
          </span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span> <strong>Settings</strong>
          </span>
          <span className="local-badge">
            <span className={`status-dot ${saved ? '' : 'offline'}`} />
            {saved ? 'Local service connected' : 'Connecting to local service'}
          </span>
        </header>
        <div className="content">
          <div className="eyebrow">A SOLID START</div>
          <div className="page-heading">
            <div>
              <h1>Make room for good work.</h1>
              <p>
                Set up the repository, models, and checks your agents will work
                with.
              </p>
            </div>
            <span className="stage-badge">
              FOUNDATION <span>01–02 / 08</span>
            </span>
          </div>
          <div className="foundation-note">
            <span className="note-icon">↳</span>
            <p>
              <strong>Your factory starts here.</strong> Configure the
              essentials now. Planning chat and development runs arrive in the
              next stages.
            </p>
            <span className="note-tag">Setup only</span>
          </div>
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
              <form onSubmit={save} id="settings-form">
                <fieldset className="settings-fields" disabled={busy}>
                  <section id="repository" className="settings-section">
                    <div className="section-heading">
                      <span className="section-number">01</span>
                      <div>
                        <h2>The repository</h2>
                        <p>
                          One project. A dedicated place for every future run.
                        </p>
                      </div>
                      <span className="section-meta">LOCAL + GITHUB</span>
                    </div>
                    <div className="panel">
                      <div className="panel-topline">
                        <span className="mini-icon">⌑</span>
                        <div>
                          <h3>Project location</h3>
                          <p>Your existing checkout stays in your control.</p>
                        </div>
                      </div>
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
                            placeholder="owner / repository"
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
                  <section id="models" className="settings-section">
                    <div className="section-heading">
                      <span className="section-number">02</span>
                      <div>
                        <h2>The right model for each role</h2>
                        <p>
                          Choose explicitly. Your factory never switches
                          providers on its own.
                        </p>
                      </div>
                    </div>
                    <div className="role-grid">
                      {ROLES.map((role, i) => {
                        const selection = draft.roles[role];
                        const provider = saved.providers.find(
                          (item) => item.id === selection.provider,
                        );
                        const model = provider?.models.find(
                          (item) => item.id === selection.model,
                        );
                        return (
                          <article className="panel role-card" key={role}>
                            <div className={`role-icon role-${role}`}>
                              {['✳', '⌘', '◎'][i]}
                            </div>
                            <h3>{names[role]}</h3>
                            <p>{descriptions[role]}</p>
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
                              {saved.providers.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {names[item.id]}
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
                                  <option value={item.id} key={item.id}>
                                    {item.name}
                                  </option>
                                ))}
                              </select>
                            )}
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
                            <div className="role-status">
                              <span
                                className={`status-dot ${provider?.configured ? '' : 'unconfigured'}`}
                              />
                              {provider?.configured
                                ? 'Credentials stored · access untested'
                                : 'Connection not configured'}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                    <p className="section-footnote">
                      Model lists describe catalog capabilities, not verified
                      account access. Requesty reasoning stays unset until its
                      capabilities are verified.
                    </p>
                  </section>
                  <section id="execution" className="settings-section">
                    <div className="section-heading">
                      <span className="section-number">03</span>
                      <div>
                        <h2>How work gets checked</h2>
                        <p>
                          Define the commands and time limits for future runs.
                        </p>
                      </div>
                      <span className="section-meta">
                        NOT EXECUTED DURING SETUP
                      </span>
                    </div>
                    <div className="panel">
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
                      <div className="divider" />
                      <h3>
                        Operation timeouts{' '}
                        <span className="unit-label">SECONDS</span>
                      </h3>
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
              <section id="connections" className="settings-section">
                <div className="section-heading">
                  <span className="section-number">04</span>
                  <div>
                    <h2>Your connections</h2>
                    <p>
                      Credentials stay on this computer, outside your
                      repository.
                    </p>
                  </div>
                </div>
                <div className="panel connections-panel">
                  {(['requesty', 'openai', 'anthropic', 'github'] as const).map(
                    (id) => (
                      <div className="connection-row" key={id}>
                        <div className="connection-name">
                          <span className="connection-monogram">
                            {id === 'github' ? 'gh' : names[id][0]}
                          </span>
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
                          className={`connection-state ${saved.credentials[id] ? 'configured' : ''}`}
                        >
                          {saved.credentials[id]
                            ? 'Stored · untested'
                            : 'Not connected'}
                        </span>
                        {id === 'requesty' || id === 'github' ? (
                          <form
                            className="credential-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void credential(id);
                            }}
                          >
                            <label className="sr-only" htmlFor={`${id}-token`}>
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
                                !credentialInputs[id] || credentialBusy !== null
                              }
                            >
                              {credentialBusy === id
                                ? 'Saving…'
                                : 'Store token'}
                            </button>
                          </form>
                        ) : (
                          <code className="login-command">
                            bun run diagnose login {id}
                          </code>
                        )}
                        {saved.credentials[id] && (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => void credential(id, true)}
                            disabled={credentialBusy !== null}
                          >
                            Disconnect
                          </button>
                        )}
                      </div>
                    ),
                  )}
                  <div className="connection-help">
                    Subscription sign-in uses an interactive terminal command.
                    Stop the local service first, sign in, then restart it.
                    Storing a token does not test it or make a model call.
                  </div>
                </div>
              </section>
              <footer className="save-bar">
                <div>
                  <span className={`status-dot ${dirty ? 'unsaved' : ''}`} />
                  <strong>
                    {dirty
                      ? 'You have unsaved changes'
                      : 'Your settings are up to date'}
                  </strong>
                  <span className="revision">Revision {saved.revision}</span>
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
                    {busy ? 'Saving…' : 'Save settings'} <span>↗</span>
                  </button>
                </div>
              </footer>
            </>
          )}
          <div className="page-footer">
            <span>DURABLE FACTORY</span>
            <span>Thoughtful plans. Recoverable work.</span>
          </div>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
