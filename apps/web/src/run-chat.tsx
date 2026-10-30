import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  RunActivityClient,
  WorkflowClient,
  mergeActivity,
  runUpdatedAt,
  type RunActivityItem,
  type RunActivityPage,
  type WorkflowRun,
  type WorkflowSnapshot,
} from '../../../packages/shared/src/index.js';
import { markdown } from './markdown.js';
import { conversationItems } from './transcript.js';
import { CommandLog, useRunCards } from './runs.js';
import { usePageCards } from './hooks/use-page-cards.js';
import { RunStatusBadge } from './run-status.js';
import { Tool } from './chat.js';
const activity = new RunActivityClient();
const workflow = new WorkflowClient();

export function ImplementationTranscript({
  run,
  onChange,
  onConnection,
  onConversation,
}: {
  run: WorkflowRun;
  onChange: () => void;
  onConnection: (connected: boolean) => void;
  onConversation: (value: NonNullable<RunActivityPage['conversation']>) => void;
}) {
  const [items, setItems] = useState<RunActivityItem[]>([]),
    [live, setLive] = useState<RunActivityPage['live']>([]);
  const [cursor, setCursor] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const current = useRef<RunActivityItem[]>([]);
  const callback = useRef(onChange);
  callback.current = onChange;
  const conversationCallback = useRef(onConversation);
  conversationCallback.current = onConversation;
  const oldestCursor = useRef<string | undefined>(undefined);
  const scrollAnchor = useRef<
    { key?: string; top: number; height: number; scrollTop: number } | undefined
  >(undefined);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    current.current = [];
    setItems([]);
    setLive([]);
    setCursor(undefined);
    oldestCursor.current = undefined;
    const stop = activity.watch(
      run.id,
      async (page, frame, signal) => {
        const last = current.current.at(-1);
        let incoming = page.items;
        // Fill every missed page after reconnect, rather than losing an entire snapshot window.
        if (last && !incoming.some((i) => i.id === last.id)) {
          let before = page.cursor;
          while (before && active && !signal.aborted) {
            const older = await activity.activity(run.id, before, 100, signal);
            incoming = mergeActivity(older.items, incoming);
            if (
              older.items.some((i) => i.id === last.id) ||
              (older.items[0]?.at ?? 0) < (last.at ?? 0)
            )
              break;
            before = older.cursor;
          }
        }
        if (!active || signal.aborted) return;
        if (!current.current.length) {
          oldestCursor.current = page.cursor;
          setCursor(page.cursor);
        }
        const known = new Set(
          [...current.current, ...incoming].map((item) => item.id),
        );
        const updates = (page.updates ?? []).filter(
          (item) =>
            known.has(item.id) ||
            (item.command && item.command.state !== 'finished'),
        );
        current.current = mergeActivity(current.current, incoming, updates);
        setItems(current.current);
        setLive(page.live);
        if (page.conversation) conversationCallback.current(page.conversation);
        setError('');
        callback.current();
      },
      (value) => {
        if (active) onConnection(value);
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
      stop();
    };
  }, [run.id]);
  useLayoutEffect(() => {
    const saved = scrollAnchor.current;
    if (!saved) return;
    const el = container.current?.closest('.transcript');
    const item = Array.from(
      container.current?.querySelectorAll<HTMLElement>(
        '[data-conversation-item]',
      ) ?? [],
    ).find((node) => node.dataset.conversationItem === saved.key);
    if (el)
      el.scrollTop += item
        ? item.getBoundingClientRect().top - saved.top
        : saved.scrollTop + el.scrollHeight - saved.height - el.scrollTop;
    scrollAnchor.current = undefined;
  }, [items]);
  const older = async () => {
    if (!oldestCursor.current || busy) return;
    setBusy(true);
    try {
      const page = await activity.activity(run.id, oldestCursor.current);
      const el = container.current?.closest('.transcript');
      if (el) {
        const bounds = el.getBoundingClientRect();
        const item = Array.from(
          container.current?.querySelectorAll<HTMLElement>(
            '[data-conversation-item]',
          ) ?? [],
        ).find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        scrollAnchor.current = {
          key: item?.dataset.conversationItem,
          top: item?.getBoundingClientRect().top ?? bounds.top,
          height: el.scrollHeight,
          scrollTop: el.scrollTop,
        };
      }
      current.current = mergeActivity(page.items, current.current);
      setItems(current.current);
      oldestCursor.current = page.cursor;
      setCursor(page.cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load activity.');
    } finally {
      setBusy(false);
    }
  };
  // Pair all durable tool results with their calls across the combined history.
  const sourceIds = [
    ...new Set([
      ...items.flatMap((item) =>
        item.conversationId ? [item.conversationId] : [],
      ),
      ...live.map((source) => source.conversationId),
    ]),
  ];
  const tools = new Map<string, import('./transcript.js').PresentationTool>(
    sourceIds.flatMap((id) =>
      conversationItems(
        items
          .filter((item) => item.conversationId === id)
          .flatMap((item) => (item.entry ? [item.entry] : [])),
        live.find((source) => source.conversationId === id)?.tools,
      ).flatMap((item) =>
        item.kind === 'tool'
          ? [[`${id}:${item.tool.id}`, item.tool] as const]
          : [],
      ),
    ),
  );
  const renderedTools = new Set<string>();
  const renderTool = (
    tool: import('./transcript.js').PresentationTool,
    conversationId: string,
  ) => {
    const key = `${conversationId}:${tool.id}`;
    if (renderedTools.has(key)) return null;
    renderedTools.add(key);
    return (
      <section key={`tool:${key}`} data-conversation-item={`tool:${key}`}>
        <div className="message-author">
          {run.attempts.some(
            (a) =>
              a.stage === 'reviewer' && a.conversationId === conversationId,
          )
            ? 'Review agent'
            : 'Developer agent'}{' '}
          · Tool activity
        </div>
        <Tool tool={tools.get(key) ?? tool} conversationId={conversationId} />
      </section>
    );
  };
  return (
    <div ref={container} className="implementation-events">
      {cursor && (
        <button
          className="secondary older-button"
          disabled={busy}
          onClick={() => void older()}
        >
          Load older activity
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {[
        ...items.flatMap((item) => {
          if (item.entry) {
            const entry = item.entry;
            return [
              entry.text || entry.textArtifact || entry.interrupted ? (
                <article
                  key={item.id}
                  className={`message ${item.actor === 'human' ? 'user-message' : item.actor === 'code' ? 'event-message' : 'assistant-message'}`}
                  data-conversation-item={item.id}
                >
                  <div className="message-author">
                    {item.title}
                    {entry.interrupted && ' · Interrupted'}
                    {item.at !== undefined && (
                      <time dateTime={new Date(item.at).toISOString()}>
                        {new Date(item.at).toLocaleTimeString()}
                      </time>
                    )}
                  </div>
                  {entry.text && (
                    <div
                      className="message-text markdown"
                      dangerouslySetInnerHTML={{ __html: markdown(entry.text) }}
                    />
                  )}
                  {entry.textArtifact && (
                    <Tool
                      conversationId={item.conversationId!}
                      tool={{
                        id: entry.id,
                        name: 'Complete message',
                        status: 'completed',
                        artifact: entry.textArtifact,
                      }}
                    />
                  )}
                </article>
              ) : null,
              ...entry.tools.map((tool) =>
                renderTool(tool, item.conversationId!),
              ),
            ];
          }
          return (
            <article
              key={item.id}
              data-conversation-item={item.id}
              className="message event-message run-event"
            >
              <div className="message-author">
                {item.actor === 'human' ? 'You' : 'Workflow'}
                {item.at !== undefined && (
                  <time dateTime={new Date(item.at).toISOString()}>
                    {new Date(item.at).toLocaleTimeString()}
                  </time>
                )}
              </div>
              <strong>{item.title}</strong>
              {item.detail && <p>{item.detail}</p>}
              {item.command && (
                <CommandLog
                  key={item.command.id}
                  runId={run.id}
                  commandId={item.command.id}
                  running={item.command.state !== 'finished'}
                />
              )}
            </article>
          );
        }),
        ...live.flatMap((source) => [
          source.partial ? (
            <article
              key={`partial:${source.conversationId}`}
              className="message assistant-message"
            >
              <div className="message-author">
                {source.role === 'review' ? 'Review agent' : 'Developer agent'}{' '}
                · Responding
              </div>
              <div
                className="message-text markdown"
                dangerouslySetInnerHTML={{ __html: markdown(source.partial) }}
              />
            </article>
          ) : null,
          ...source.tools.map((tool) =>
            renderTool(tool, source.conversationId),
          ),
        ]),
      ]}
      {!items.length && <p role="status">Loading implementation activity…</p>}
    </div>
  );
}

export function RunInformation({
  run,
  snapshot,
  onRun,
}: {
  run: WorkflowRun;
  snapshot: WorkflowSnapshot;
  onRun: (run: WorkflowRun) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const inspectionCards = useRunCards({ run, startMode: snapshot.mode, onRun });
  useEffect(() => {
    if (['pr_ready', 'cancelled'].includes(run.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.status]);
  const stages = ['setup', 'developer', 'checks', 'reviewer', 'publication'];
  const index = stages.indexOf(
    run.stage === 'publishing' ? 'publication' : run.stage,
  );
  const end = ['pr_ready', 'cancelled'].includes(run.status)
    ? (run.activity?.at(-1)?.at ??
      run.attempts.at(-1)?.finishedAt ??
      run.createdAt)
    : now;
  const seconds = Math.max(0, Math.round((end - run.createdAt) / 1000));
  const elapsed =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  usePageCards(
    [
      {
        id: 'run-progress',
        title: 'Run progress',
        actions: <RunStatusBadge status={run.status} />,
        content: (
          <>
            <div className="run-progress-meta">
              <span>
                {run.mode === 'simulation' ? 'Simulation' : 'Real execution'}
              </span>
              <span title="Includes pauses and recovery">
                {elapsed} elapsed
              </span>
            </div>
            <ol className="run-stepper" aria-label="Implementation stages">
              {['Setup', 'Develop', 'Checks', 'Review', 'PR'].map(
                (label, i) => (
                  <li
                    key={label}
                    aria-current={i === index ? 'step' : undefined}
                    data-complete={i < index}
                  >
                    {label}
                  </li>
                ),
              )}
            </ol>
            {run.status === 'queued' && (
              <p>
                Queue position:{' '}
                {
                  snapshot.runs.filter(
                    (r) =>
                      r.status === 'queued' && r.queueOrder <= run.queueOrder,
                  ).length
                }
              </p>
            )}
            <div className="run-links">
              <a href={run.issue.url}>View issue #{run.issue.number}</a>
              {run.planningConversationId && (
                <a href={`/?conversation=${run.planningConversationId}`}>
                  Open planning conversation
                </a>
              )}
              {run.publication?.result &&
                (run.mode === 'real' ? (
                  <a href={run.publication.result}>Open pull request</a>
                ) : (
                  <p role="status">{run.publication.result}</p>
                ))}
              {run.publication && !run.publication.result && (
                <p role="status">Publication: {run.publication.state}</p>
              )}
            </div>
          </>
        ),
      },
      inspectionCards[0],
      {
        id: 'run-ticket',
        title: 'Ticket',
        collapsible: true,
        content: (
          <>
            <h3>{run.specification.title}</h3>
            {[
              ['Goal', run.specification.goal],
              ['Scope', run.specification.scope],
              ['Acceptance criteria', run.specification.acceptanceCriteria],
              ['Validation', run.specification.validation],
            ].map(([label, text]) => (
              <section key={label}>
                <h3>{label}</h3>
                <div
                  className="markdown"
                  dangerouslySetInnerHTML={{ __html: markdown(text) }}
                />
              </section>
            ))}
            <h3>Regression proof</h3>
            <p>
              {run.specification.regression?.required
                ? `Required: ${run.specification.regression.command}`
                : run.specification.regression?.required === false
                  ? `Not required: ${run.specification.regression.reason}`
                  : 'Not specified'}
            </p>
            {run.specification.regression?.required && (
              <>
                <p>
                  Test paths:{' '}
                  {run.specification.regression.testPaths.join(', ')}
                </p>
                <p>
                  Expected failure:{' '}
                  {run.specification.regression.expectedFailure}
                </p>
              </>
            )}
          </>
        ),
      },
      ...inspectionCards.slice(1),
    ],
    'Run information',
  );
  return null;
}
