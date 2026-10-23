import React, { useEffect, useState } from 'react';
import {
  WorkflowClient,
  runTimeline,
  currentImplementation,
  ChatClient,
  type WorkflowSnapshot,
  type WorkflowRun,
  type RunAction,
  type RunInspection,
} from '../../../packages/shared/src/index.js';
const client = new WorkflowClient();
const chat = new ChatClient();
export function StartRun({ conversationId }: { conversationId: string }) {
  const [mode, setMode] = useState('simulation');
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [operationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    void client
      .workflow()
      .then((s) => {
        setEnabled(s.enabled);
        setMode(s.mode);
      })
      .catch(() => {});
  }, []);
  if (!enabled) return null;
  return (
    <span className="run-start">
      <button
        className="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void client
            .startRun(conversationId, operationId)
            .then((run) => {
              window.location.href = `/runs#${run.id}`;
            })
            .catch((e) => {
              setError(e.message);
              setBusy(false);
            });
        }}
      >
        {mode === 'simulation' ? 'Start simulated run' : 'Start implementation'}
      </button>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
function CommandLog({
  runId,
  commandId,
}: {
  runId: string;
  commandId: string;
}) {
  const [output, setOutput] = useState(''),
    [offset, setOffset] = useState<number | undefined>(0),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async () => {
    if (offset === undefined) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
          `/api/v1/runs/${runId}/artifacts/${commandId}?offset=${offset}`,
        ),
        page = await response.json();
      if (!response.ok)
        throw new Error(page.error?.message ?? 'Unable to load output.');
      setOutput((previous) => previous + page.text);
      setOffset(page.nextOffset);
      setLoaded(true);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to load output.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {(!loaded || offset !== undefined) && (
        <button disabled={busy} onClick={() => void load()}>
          {loaded ? 'Load more output' : 'View command output'}
        </button>
      )}
      {loaded && <pre>{output || 'Command produced no output.'}</pre>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function Inspector({
  run,
  onRun,
  startMode,
}: {
  startMode: WorkflowSnapshot['mode'];
  run: WorkflowRun;
  onRun: (run: WorkflowRun) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [answer, setAnswer] = useState(''),
    [guidance, setGuidance] = useState('');
  const [inspection, setInspection] = useState<RunInspection>();
  const [inspectionError, setInspectionError] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setInspection(undefined);
    const refresh = async () => {
      try {
        const value = await client.inspection(run.id);
        if (!stopped) {
          setInspection(value);
          setInspectionError('');
        }
      } catch {
        if (!stopped)
          setInspectionError('Live inspection unavailable. Reconnecting…');
      }
      if (!stopped) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [run.id]);
  const [operation, setOperation] = useState<{
    key: string;
    id: string;
    revision: number;
  }>();
  const act = async (action: RunAction, extra = {}) => {
    const key = JSON.stringify({ action, extra });
    const receipt =
      operation?.key === key
        ? operation
        : { key, id: crypto.randomUUID(), revision: run.revision };
    setOperation(receipt);
    setBusy(true);
    setError('');
    try {
      onRun(
        await client.command(run.id, {
          action,
          operationId: receipt.id,
          expectedRevision: receipt.revision,
          ...extra,
        }),
      );
      setOperation(undefined);
      setAnswer('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update run.');
      if (e instanceof Error && 'code' in e && e.code === 'CONFLICT')
        setOperation(undefined);
    } finally {
      setBusy(false);
    }
  };
  const pending = run.interventions.filter((i) => i.state === 'pending');
  const ended = ['pr_ready', 'cancelled'].includes(run.status);
  const publishing =
    run.publicationLocked || run.stage === 'publishing' || ended;
  return (
    <article className="run-inspector" aria-label="Run inspector">
      <h2>{run.specification.title}</h2>
      <p>
        <strong>
          {run.mode === 'simulation' ? 'Simulation' : 'Real execution'}
        </strong>{' '}
        · Issue #{run.issue.number} · {run.status} · {run.stage}
      </p>
      <p>
        Repairs: {run.repairCount} / {run.repairLimit} · Configuration revision:{' '}
        {run.configurationRevision} ·{' '}
        {run.quiescent ? 'Work stopped' : 'Execution held'}
      </p>
      <p className="run-identity">
        Run: {run.id}
        <br />
        Source: {run.source}
        <br />
        Base: {run.base}
      </p>
      {run.cleanup && (
        <p role="status">
          Cleanup {run.cleanup.state}: {run.cleanup.message}
        </p>
      )}
      <section aria-label="Live run inspection">
        <h3>Models and usage</h3>
        {Object.entries(run.configuration.roles).map(([role, model]) => (
          <p key={role}>
            {role}: {model.provider} / {model.model}
          </p>
        ))}
        {inspectionError && <p role="status">{inspectionError}</p>}
        {inspection?.conversations.map((c) => (
          <div key={c.id}>
            <p>
              {c.role} conversation {c.id}:{' '}
              {c.usage.messages
                ? `Reported tokens: ${c.usage.input} input · ${c.usage.output} output · ${c.usage.cacheRead} cache read · ${c.usage.cacheWrite} cache write${c.usage.partial ? ' (partial history)' : ''}`
                : 'Token usage unavailable.'}
            </p>
            <p>
              {c.usage.estimatedCost === undefined
                ? 'Cost estimate unavailable.'
                : `Available cost estimates (USD): $${c.usage.estimatedCost.toFixed(4)}`}
            </p>
            {c.tools.map((t) => (
              <p key={t.id}>
                Active tool: {t.name} · {t.status}
              </p>
            ))}
          </div>
        ))}
        <p>Subscription token usage does not represent per-token billing.</p>
        <h3>Active commands and checks</h3>
        {inspection?.commands.length ? (
          inspection.commands.map((c) => (
            <div key={c.id}>
              <p>
                <code>{c.command}</code> · {c.state}
              </p>
              <CommandLog runId={run.id} commandId={c.id} />
            </div>
          ))
        ) : (
          <p>
            {inspection ? 'No active commands.' : 'Loading active commands…'}
          </p>
        )}
        <h3>Recovery events</h3>
        {run.attempts.some((a) => a.recoveryCount) ? (
          run.attempts
            .filter((a) => a.recoveryCount)
            .map((a) => (
              <p key={a.id}>
                {a.stage}: recovered {a.recoveryCount} time(s). {a.message}
              </p>
            ))
        ) : (
          <p>No recovered attempts.</p>
        )}
      </section>
      <div className="run-controls">
        {!ended &&
          !['pausing', 'cancelling', 'termination_blocker'].includes(
            run.status,
          ) && (
            <button disabled={busy} onClick={() => void act('cancel')}>
              Cancel run
            </button>
          )}
        {['running', 'queued'].includes(run.status) && (
          <button disabled={busy} onClick={() => void act('pause')}>
            Pause run
          </button>
        )}
        {['paused', 'needs_input'].includes(run.status) && !pending.length && (
          <button disabled={busy} onClick={() => void act('resume')}>
            Resume run
          </button>
        )}
        {run.status === 'termination_blocker' ||
        pending.some((i) => ['uncertain', 'publication'].includes(i.reason)) ? (
          <button disabled={busy} onClick={() => void act('reconcile')}>
            Reconcile run
          </button>
        ) : null}
        {!publishing &&
          ['paused', 'needs_input', 'queued'].includes(run.status) && (
            <>
              <button
                disabled={busy}
                onClick={() => void act('adopt_configuration')}
              >
                Adopt saved configuration
              </button>
              <button
                disabled={busy}
                onClick={() => void act('adopt_specification')}
              >
                Adopt saved specification
              </button>
            </>
          )}
        {ended && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError('');
              void (async () => {
                try {
                  const key = `factory.workflow.newRun.${run.id}`;
                  const operationId =
                    localStorage.getItem(key) ?? crypto.randomUUID();
                  localStorage.setItem(key, operationId);
                  const admitted = await client.newRun(run.id, operationId);
                  if (localStorage.getItem(key) === operationId)
                    localStorage.removeItem(key);
                  onRun(admitted);
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : 'Unable to start a new run.',
                  );
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {startMode === 'simulation'
              ? 'Start explicit new simulated run'
              : 'Start explicit new run'}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {pending.map((q) => (
        <section className="run-question" key={q.id}>
          <h3>{q.reason}</h3>
          <p>{q.question}</p>
          {q.reason === 'repair_exhausted' ? (
            <button disabled={busy} onClick={() => void act('continue')}>
              Authorize one additional repair
            </button>
          ) : (
            ![
              'termination',
              'uncertain',
              'publication',
              'adapter',
              'specification_contract',
            ].includes(q.reason) && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('answer', {
                    interventionId: q.id,
                    interventionRevision: q.revision,
                    answer,
                  });
                }}
              >
                <label>
                  Answer
                  <textarea
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    required
                    maxLength={16000}
                  />
                </label>
                <button disabled={busy}>Answer and resume</button>
              </form>
            )
          )}
        </section>
      ))}
      {!publishing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void chat
              .submit(
                run.developerConversationId,
                guidance,
                crypto.randomUUID(),
                'followUp',
              )
              .then(() => setGuidance(''))
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            Developer guidance
            <textarea
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              required
            />
          </label>
          <button disabled={busy}>Queue guidance</button>
        </form>
      )}
      {run.workspace && (
        <p>
          Worktree: <code>{run.workspace.path}</code>
          <br />
          Branch: <code>{run.workspace.branch}</code>
        </p>
      )}
      {run.publication?.result && run.mode === 'real' && (
        <p>
          <a href={run.publication.result}>Open pull request</a>
        </p>
      )}
      {run.mode === 'real' &&
        run.publicationLocked &&
        ['paused', 'needs_input'].includes(run.status) &&
        !run.publication?.pushed && (
          <button disabled={busy} onClick={() => void act('revalidate')}>
            Repeat checks and review
          </button>
        )}
      <h3>Developer input</h3>
      {run.inputs.length ? (
        run.inputs.map((i) => (
          <p key={i.requestId}>
            {i.content} · {i.status}
            {i.status === 'queued' && (
              <button
                disabled={busy}
                onClick={() => {
                  void chat
                    .withdraw(run.developerConversationId, i.submissionId)
                    .catch((e) => setError(e.message));
                }}
              >
                Withdraw input
              </button>
            )}
          </p>
        ))
      ) : (
        <p>No developer input.</p>
      )}
      <h3>Run timeline</h3>
      <p>
        Elapsed times include pauses and recovery; they are not active execution
        time.
      </p>
      <ol className="run-timeline" aria-label="Run timeline">
        {runTimeline(run).map((event) => {
          const attempt = run.attempts.find((a) => a.id === event.attemptId);
          return (
            <li key={event.id} id={`attempt-${event.id}`}>
              <strong>
                {event.actor} · {event.title}
              </strong>
              <p>
                <time dateTime={new Date(event.at).toISOString()}>
                  {new Date(event.at).toLocaleString()}
                </time>
                {attempt &&
                  ` · Elapsed: ${Math.max(0, Math.round(((attempt.finishedAt ?? Date.now()) - attempt.startedAt) / 1000))} s`}
              </p>
              {event.detail && <p>{event.detail}</p>}
              {event.conversationId && (
                <a href={`/?conversation=${event.conversationId}`}>
                  Open{' '}
                  {attempt?.stage === 'reviewer' ? 'reviewer' : 'developer'}{' '}
                  conversation
                </a>
              )}
              {attempt?.repairCauses?.map((id) => (
                <p key={id}>
                  <a href={`#evidence-${id}`}>
                    Repair cause:{' '}
                    {run.attempts.find((a) => a.id === id)?.stage ?? id}
                  </a>
                </p>
              ))}
              {run.proofWorkspaces?.some((p) =>
                p.id.includes(event.attemptId ?? 'missing-attempt'),
              ) && (
                <p>
                  <a href="#proof-resources">Regression command output</a>
                </p>
              )}
              {run.implementations?.some(
                (r) => r.attemptId === event.attemptId,
              ) && (
                <p>
                  <a
                    href={`#report-${run.implementations?.findLast((r) => r.attemptId === event.attemptId)?.id ?? event.attemptId}`}
                  >
                    Implementation report
                  </a>
                </p>
              )}
              {[...run.evidence, ...(run.evidenceHistory ?? [])].some(
                (e) => e.attemptId === event.attemptId,
              ) && (
                <p>
                  <a href={`#evidence-${event.attemptId}`}>
                    Validation evidence and command output
                  </a>
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <h3>Implementation reports</h3>
      {!run.implementations?.length && (
        <p>No structured implementation report available.</p>
      )}
      {run.implementations?.map((report) => (
        <details
          key={report.id ?? report.attemptId}
          id={`report-${report.id ?? report.attemptId}`}
        >
          <summary>
            {report === currentImplementation(run) ? 'Current' : 'Superseded'}{' '}
            implementation · {report.summary}
          </summary>
          <p>{report.reviewerNotes}</p>
          <p>Criteria: {report.criteria.join(', ')}</p>
          <p>Changed files: {report.changedFiles.join(', ')}</p>
          <p>
            Validation performed:{' '}
            {report.validation.join('; ') || 'None reported.'}
          </p>
          <p>
            Remaining concerns: {report.concerns.join('; ') || 'None reported.'}
          </p>
        </details>
      ))}
      <h3>Evidence</h3>
      {[...run.evidence, ...(run.evidenceHistory ?? [])].map((e) => (
        <details key={e.attemptId} id={`evidence-${e.attemptId}`}>
          <summary>
            {e.kind}: {e.passed ? 'passed' : 'failed'} ·{' '}
            {run.evidence.includes(e) ? 'Current' : 'Superseded'} ·
            configuration {e.configurationRevision}
          </summary>
          <p>
            {e.source} · {e.duration} ms elapsed
          </p>
          {e.commands && <pre>{e.commands.join('\n')}</pre>}
          <pre>{e.output}</pre>
          {e.kind === 'reviewer' && !e.assessments && (
            <p>Criterion assessments unavailable in this legacy review.</p>
          )}
          {e.assessments?.map((a) => (
            <section key={a.id}>
              <h4>
                {a.id}: {a.status.replaceAll('_', ' ')}
              </h4>
              <p>{a.explanation}</p>
              <p>
                {a.references
                  .map((r) => `${r.path}${r.line ? ':' + r.line : ''}`)
                  .join(', ')}
              </p>
            </section>
          ))}
          {e.regression && <p>Regression proof: {e.regression.message}</p>}
          {[...(e.results ?? []), ...(e.regression?.results ?? [])].map(
            (result) => (
              <div key={result.artifact}>
                <p>
                  {result.command} · exit {result.exitCode} · {result.duration}{' '}
                  ms
                </p>
                <CommandLog runId={run.id} commandId={result.artifact} />
              </div>
            ),
          )}
        </details>
      ))}
      {!!run.proofWorkspaces?.length && (
        <section id="proof-resources" aria-label="Regression proof resources">
          <h3>Regression proof resources</h3>
          {run.proofWorkspaces.map((resource) => (
            <details key={resource.id}>
              <summary>
                {resource.id.endsWith('-base') ? 'Base' : 'Candidate'} snapshot
                · {resource.state}
              </summary>
              <p>{resource.root}</p>
              {resource.state !== 'removed' && (
                <p>
                  Retained until quiescence and ownership/content checks allow
                  cleanup. Interrupted snapshots with unverified content require
                  inspection.
                </p>
              )}
              {resource.results?.map((result) => (
                <div key={result.artifact}>
                  <p>
                    {result.command} · exit {result.exitCode}
                  </p>
                  <CommandLog runId={run.id} commandId={result.artifact} />
                </div>
              ))}
            </details>
          ))}
        </section>
      )}
      {run.publication && (
        <p role="status">
          {run.publication.result ??
            `${run.mode === 'simulation' ? 'Simulated publication' : 'Publication'}: ${run.publication.state}`}
        </p>
      )}
      <details>
        <summary>Captured commands, timeouts, models, and decisions</summary>
        <pre>
          {JSON.stringify(
            {
              setup: run.configuration.setupCommands,
              checks: run.configuration.requiredChecks,
              timeouts: run.configuration.timeouts,
              models: run.configuration.roles,
              decisions: run.decisions,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </article>
  );
}
export function RunsApp() {
  const [issueNumber, setIssueNumber] = useState('');
  const [startError, setStartError] = useState('');
  const [startBusy, setStartBusy] = useState(false);
  const [startOperation, setStartOperation] = useState(() =>
    crypto.randomUUID(),
  );
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>(),
    [connected, setConnected] = useState(false),
    [selected, setSelected] = useState(window.location.hash.slice(1));
  useEffect(() => client.watchRuns(setSnapshot, setConnected), []);
  const run =
    snapshot?.runs.find((r) => r.id === selected) ?? snapshot?.runs[0];
  return (
    <main className="runs-page">
      <nav>
        <a href="/">Planning chat</a>
        <a href="/settings">Settings</a>
      </nav>
      <h1>Workflow runs</h1>
      <p>
        Browser: {connected ? 'connected' : 'disconnected'} · Mode:{' '}
        {snapshot?.mode ?? 'connecting'}
      </p>
      {snapshot?.mode === 'simulation' && (
        <p>
          Simulation runs use fake agents and checks. They do not change code or
          create GitHub pull requests.
        </p>
      )}
      {snapshot?.mode === 'real' && snapshot.enabled && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setStartBusy(true);
            setStartError('');
            void client
              .startIssue(Number(issueNumber), startOperation)
              .then((run) => {
                setSelected(run.id);
                window.location.hash = run.id;
                setStartOperation(crypto.randomUUID());
              })
              .catch((error) => setStartError(error.message))
              .finally(() => setStartBusy(false));
          }}
        >
          <label>
            GitHub issue number
            <input
              type="number"
              min="1"
              step="1"
              required
              value={issueNumber}
              onChange={(event) => {
                setIssueNumber(event.target.value);
                setStartOperation(crypto.randomUUID());
              }}
            />
          </label>
          <button disabled={startBusy}>Start implementation</button>
        </form>
      )}
      {startError && <p role="alert">{startError}</p>}
      {snapshot && !snapshot.enabled && (
        <p>
          Starts are unavailable.{' '}
          {snapshot.missingPrerequisites?.length
            ? `Complete settings: ${snapshot.missingPrerequisites.join(', ')}.`
            : 'Execution is disabled for this service.'}
        </p>
      )}
      <div className="runs-layout">
        <aside aria-label="Run queue">
          {snapshot?.runs.map((r) => (
            <button
              key={r.id}
              aria-current={r.id === run?.id ? 'true' : undefined}
              onClick={() => {
                setSelected(r.id);
                window.location.hash = r.id;
              }}
            >
              {r.specification.title} · #{r.issue.number}
              <br />
              {r.status}
              {snapshot.slot === r.id
                ? ' · holds execution slot'
                : r.status === 'queued'
                  ? ` · queue position ${snapshot.runs.filter((x) => x.status === 'queued' && x.queueOrder <= r.queueOrder).length}`
                  : ''}
            </button>
          ))}
        </aside>
        {run ? (
          <Inspector
            key={run.id}
            startMode={snapshot!.mode}
            run={run}
            onRun={(updated) => {
              window.location.hash = updated.id;
              setSelected(updated.id);
              setSnapshot((s) =>
                s
                  ? {
                      ...s,
                      runs: [
                        ...s.runs.filter((r) => r.id !== updated.id),
                        updated,
                      ],
                    }
                  : s,
              );
            }}
          />
        ) : (
          <p>
            No runs yet. Start implementation from an issue or linked planning
            conversation.
          </p>
        )}
      </div>
    </main>
  );
}
