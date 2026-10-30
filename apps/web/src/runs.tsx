import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PageCard } from './hooks/use-page-cards.js';
import { RunUsage } from './run-details.js';
import { useRunCommand } from './hooks/use-run-command.js';
import {
  WorkflowClient,
  ChatClient,
  type WorkflowSnapshot,
  type WorkflowRun,
  type RunInspection,
} from '../../../packages/shared/src/index.js';
const client = new WorkflowClient();
const chat = new ChatClient();
export function StartRun({ conversationId }: { conversationId: string }) {
  const [mode, setMode] = useState('simulation');
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [operationId] = useState(() => {
    const key = `factory.startRun.${conversationId}`;
    try {
      const id = localStorage.getItem(key) ?? crypto.randomUUID();
      localStorage.setItem(key, id);
      return id;
    } catch {
      return crypto.randomUUID();
    }
  });
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
              try {
                localStorage.removeItem(`factory.startRun.${conversationId}`);
              } catch {
                /* In-memory receipt remains valid. */
              }
              window.location.href = `/?conversation=${run.developerConversationId}`;
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
export function CommandLog({
  runId,
  commandId,
  running = false,
}: {
  runId: string;
  commandId: string;
  running?: boolean;
}) {
  const [output, setOutput] = useState(''),
    [expanded, setExpanded] = useState(false),
    [more, setMore] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const offset = useRef(0),
    loading = useRef(false),
    loadPromise = useRef<Promise<void> | undefined>(undefined),
    request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const load = useCallback(() => {
    if (loadPromise.current) return loadPromise.current;
    loading.current = true;
    setBusy(true);
    const work = (async () => {
      const controller = new AbortController();
      request.current = controller;
      try {
        const response = await fetch(
          `/api/v1/runs/${runId}/artifacts/${commandId}?offset=${offset.current}`,
          { signal: controller.signal },
        );
        const page = await response.json();
        if (!response.ok)
          throw new Error(page.error?.message ?? 'Unable to load output.');
        if (controller.signal.aborted) return;
        offset.current =
          page.nextOffset ??
          offset.current + new TextEncoder().encode(page.text).byteLength;
        setOutput((previous) => previous + page.text);
        setMore(page.nextOffset !== undefined);
        setError('');
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load output.');
      } finally {
        loading.current = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
    loadPromise.current = work;
    void work.finally(() => {
      if (loadPromise.current === work) loadPromise.current = undefined;
    });
    return work;
  }, [runId, commandId]);
  useEffect(() => {
    if (!expanded) return;
    let stopped = false;
    void (async () => {
      await loadPromise.current;
      if (!stopped) await load();
    })();
    if (!running)
      return () => {
        stopped = true;
      };
    const timer = setInterval(() => void load(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [expanded, running, load]);
  return (
    <details
      className="command-output"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>View command output</summary>
      {expanded && (
        <>
          <pre>
            {output ||
              (running
                ? 'Waiting for command output…'
                : 'Command produced no output.')}
          </pre>
          {(more || error) && (
            <button disabled={busy} onClick={() => void load()}>
              {error ? 'Retry output' : 'Load more output'}
            </button>
          )}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </details>
  );
}
export function useRunDetails({
  run,
  onRun,
  startMode,
}: {
  startMode: WorkflowSnapshot['mode'];
  run: WorkflowRun;
  onRun: (run: WorkflowRun) => void;
}): { controls: React.ReactNode; cards: PageCard[] } {
  const { error, setError, busy, setBusy, act } = useRunCommand(run, onRun);
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
  const pending = run.interventions.filter((i) => i.state === 'pending');
  const ended = ['pr_ready', 'cancelled'].includes(run.status);
  const publishing =
    run.publicationLocked || run.stage === 'publishing' || ended;
  return {
    controls: (
      <>
        {error && <p role="alert">{error}</p>}
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
          {['paused', 'needs_input'].includes(run.status) &&
            !pending.length && (
              <button disabled={busy} onClick={() => void act('resume')}>
                Resume run
              </button>
            )}
          {!pending.length && run.status === 'termination_blocker' ? (
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
                {!pending.some(
                  (question) => question.reason === 'specification_contract',
                ) && (
                  <button
                    disabled={busy}
                    onClick={() => void act('adopt_specification')}
                  >
                    Adopt saved specification
                  </button>
                )}
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
        {run.mode === 'real' &&
          run.publicationLocked &&
          ['paused', 'needs_input'].includes(run.status) &&
          !run.publication?.pushed && (
            <button disabled={busy} onClick={() => void act('revalidate')}>
              Repeat checks and review
            </button>
          )}
      </>
    ),
    cards: [
      {
        id: 'usage',
        title: 'Usage',
        content: <RunUsage inspection={inspection} error={inspectionError} />,
      },
      ...(run.inputs.length
        ? [
            {
              id: 'developer-input',
              title: 'Developer input',
              collapsible: true,
              content: (
                <>
                  {run.inputs.length ? (
                    run.inputs.map((i) => (
                      <p key={i.requestId}>
                        {i.content} · {i.status}
                        {i.status === 'queued' && (
                          <button
                            disabled={busy}
                            onClick={() => {
                              void chat
                                .withdraw(
                                  run.developerConversationId,
                                  i.submissionId,
                                )
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
                </>
              ),
            },
          ]
        : []),
    ],
  };
}
