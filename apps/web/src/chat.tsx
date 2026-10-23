import {
  conversationItems,
  agentLabel,
  type PresentationTool,
} from './transcript.js';
import { markdown } from './markdown.js';
import { Overlay, useMedia } from './panels.js';
import { StartRun } from './runs.js';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ApiError,
  formatTicketBody,
  ChatClient,
  mergeEntries,
  type ConnectionState,
  type ConversationSnapshot,
  type ConversationSummary,
  type TranscriptEntry,
} from '../../../packages/shared/src/index.js';
import {
  chatStorageKey,
  restoreChatState,
  saveChatChanges,
  type ChatLocalState,
  type PendingSend,
} from './chat-storage.js';

const client = new ChatClient();
type ConversationView = {
  id: string;
  abort: AbortController;
  entries: TranscriptEntry[];
  cursor?: string;
};
function ArtifactText({
  artifact,
  conversationId,
  label = 'output',
  phase = 'completed',
}: {
  artifact: string;
  conversationId: string;
  label?: string;
  phase?: PresentationTool['status'];
}) {
  const [output, setOutput] = useState('');
  const [offset, setOffset] = useState(0);
  const [exhaustedPhase, setExhaustedPhase] = useState<typeof phase>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const page = await client.artifact(conversationId, artifact, offset);
      setOutput((previous) => previous + page.text);
      // EOF is temporary while the tool runs. Keep a byte cursor so a later
      // read appends only new data, including when completion races this read.
      setOffset(
        page.nextOffset ??
          offset + new TextEncoder().encode(page.text).byteLength,
      );
      setExhaustedPhase(page.nextOffset === undefined ? phase : undefined);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load output.');
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="artifact-output">
      {(phase === 'pending' ||
        phase === 'running' ||
        exhaustedPhase !== phase) && (
        <button
          type="button"
          disabled={loading}
          className="secondary"
          onClick={() => void load()}
        >
          {output ? `Load more ${label}` : `Read complete ${label}`}
        </button>
      )}
      {output && <pre>{output}</pre>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function Tool({
  tool,
  conversationId,
}: {
  tool: PresentationTool;
  conversationId: string;
}) {
  return (
    <details
      className="tool-card"
      data-tool-id={tool.id}
      data-conversation-item={`tool:${tool.id}`}
      data-status={tool.status}
    >
      <summary>
        <span className="tool-indicator" aria-hidden="true">
          {tool.status === 'completed'
            ? '✓'
            : tool.status === 'failed'
              ? '!'
              : '◌'}
        </span>
        <strong>{tool.name}</strong>
        {tool.arguments && (
          <code className="tool-preview">
            {tool.arguments.replace(/\s+/g, ' ').slice(0, 100)}
          </code>
        )}
        <span className="tool-status">{tool.status}</span>
      </summary>
      {tool.arguments && (
        <>
          <h4>Input / command</h4>
          <pre>{tool.arguments}</pre>
        </>
      )}
      {tool.output && (
        <>
          <h4>Output</h4>
          <pre>{tool.output}</pre>
        </>
      )}
      {tool.truncated && <p>Output preview is limited.</p>}
      {tool.inputArtifact && (
        <ArtifactText
          key={tool.inputArtifact}
          artifact={tool.inputArtifact}
          conversationId={conversationId}
          label="input"
        />
      )}
      {tool.artifact && (
        <ArtifactText
          key={tool.artifact}
          artifact={tool.artifact}
          conversationId={conversationId}
          phase={tool.status}
        />
      )}
    </details>
  );
}
function Ticket({
  snapshot,
  selected,
  onError,
}: {
  snapshot: ConversationSnapshot;
  selected: string;
  onError: (message: string) => void;
}) {
  const planning = snapshot.planning;
  if (!planning?.ticket) return null;
  return (
    <section className="planning-ticket">
      <div className="eyebrow">
        Saved ticket · revision {planning.ticket.revision}
      </div>
      {planning.operation && (
        <div role="status">
          <p>Issue: {planning.operation.state}</p>
          {planning.operation.message && <p>{planning.operation.message}</p>}
          {planning.operation.issue && (
            <a
              href={planning.operation.issue.url}
              target="_blank"
              rel="noreferrer"
            >
              View issue #{planning.operation.issue.number}
            </a>
          )}
          {planning.operation.issue && <StartRun conversationId={selected!} />}
          {['prepared', 'sending', 'uncertain', 'rejected', 'blocked'].includes(
            planning.operation.state,
          ) && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                void client
                  .retryIssue(selected!)
                  .catch((e) => onError(e.message));
              }}
            >
              Retry{' '}
              {planning.operation.state === 'rejected' ||
              planning.operation.state === 'prepared'
                ? 'issue creation'
                : 'reconciliation'}
            </button>
          )}
        </div>
      )}
      <h2>{planning.ticket.title}</h2>
      {[
        ['Goal', planning.ticket.goal],
        ['Scope', planning.ticket.scope],
        ['Acceptance criteria', planning.ticket.acceptanceCriteria],
        ['Validation', planning.ticket.validation],
        [
          'Regression proof',
          planning.ticket.regression
            ? planning.ticket.regression.required
              ? `Required. Command: ${planning.ticket.regression.command}\nTest paths: ${planning.ticket.regression.testPaths.join(', ')}\nExpected failure: ${planning.ticket.regression.expectedFailure}`
              : `Not required: ${planning.ticket.regression.reason}`
            : 'Unavailable in this legacy ticket.',
        ],
      ].map(([label, text]) => (
        <section key={label}>
          <h3>{label}</h3>
          <p>{text}</p>
        </section>
      ))}
      <details>
        <summary>Complete proposed GitHub issue body</summary>
        <pre>{formatTicketBody(planning.ticket)}</pre>
      </details>
      {planning.proposal && !planning.operation && (
        <p>
          Should I create this GitHub issue? Reply “yes” in chat, or describe
          changes.
        </p>
      )}
    </section>
  );
}

export function ChatApp() {
  const [local, setLocal] = useState<ChatLocalState>(() => {
    const state = restoreChatState();
    const selected = new URLSearchParams(window.location.search).get(
      'conversation',
    );
    return selected ? { ...state, selected } : state;
  });
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const desktop = useMedia('(min-width: 1200px)');
  const mobile = useMedia('(max-width: 759px)');
  const [ticketOpen, setTicketOpen] = useState(true);
  const [ticketOverlay, setTicketOverlay] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const label = agentLabel(snapshot?.conversation.role);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const anchor = useRef<
    { key?: string; top: number; height: number } | undefined
  >(undefined);
  const current = useRef(local);
  current.current = local;
  const inFlight = useRef(new Set<string>());
  const activeView = useRef<ConversationView | undefined>(undefined);
  const selected = local.selected;
  const persist = (update: (previous: ChatLocalState) => ChatLocalState) => {
    const previous = current.current;
    const next = update(previous);
    try {
      saveChatChanges(previous, next);
    } catch {
      setError(
        'Browser storage is unavailable. Keep this window open to preserve drafts and pending sends.',
      );
    }
    current.current = next;
    setLocal(next);
  };
  const refresh = async () => {
    const result = await client.conversations();
    setConversations(result.conversations);
  };
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (
        event.storageArea !== localStorage ||
        (event.key !== null && !event.key.startsWith(chatStorageKey))
      )
        return;
      const saved = restoreChatState();
      const next = {
        ...current.current,
        drafts: saved.drafts,
        pending: saved.pending,
      };
      current.current = next;
      setLocal(next);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const isCurrent = (view: ConversationView) =>
    activeView.current === view &&
    current.current.selected === view.id &&
    !view.abort.signal.aborted;
  useEffect(() => {
    setSnapshot(undefined);
    setEntries([]);
    setCursor(undefined);
    setError('');
    setLoadingHistory(false);
    setFollowing(true);
    setTicketOverlay(false);
    follow.current = true;
    anchor.current = undefined;
    if (!selected) {
      setConnection('disconnected');
      return;
    }
    const view: ConversationView = {
      id: selected,
      abort: new AbortController(),
      entries: [],
    };
    activeView.current = view;
    const stop = client.watch(
      selected,
      async (value, frame) => {
        if (!isCurrent(view)) return;
        const previous = view.entries;
        const last = previous.at(-1)?.id;
        let incoming = value.entries;
        // A fresh stream may skip an entire window, including entries compacted
        // while offline. Read durable history back to the last displayed entry.
        if (
          last &&
          (frame.type === 'snapshot' ||
            (incoming.length > 0 && Number(incoming[0].id) > Number(last)))
        ) {
          let pageCursor =
            frame.type === 'snapshot' ? undefined : value.olderCursor;
          let reachedPrevious = false;
          if (frame.type === 'snapshot' || pageCursor) {
            do {
              const page = await client.history(
                view.id,
                pageCursor,
                AbortSignal.any([view.abort.signal, frame.signal]),
              );
              if (!isCurrent(view)) return;
              incoming = mergeEntries(page.entries, incoming);
              pageCursor = page.cursor;
              reachedPrevious = page.entries.some(
                (entry) => Number(entry.id) <= Number(last),
              );
            } while (pageCursor && !reachedPrevious);
          }
        }
        if (!isCurrent(view)) return;
        if (!previous.length) view.cursor = value.olderCursor;
        view.entries = mergeEntries(view.entries, incoming);
        setSnapshot(value);
        setEntries(view.entries);
        setCursor(view.cursor);
      },
      (state) => {
        if (isCurrent(view)) setConnection(state);
      },
      (e) => {
        if (isCurrent(view)) setError(e.message);
      },
    );
    return () => {
      view.abort.abort();
      stop();
      if (activeView.current === view) activeView.current = undefined;
    };
  }, [selected]);
  const reconcile = async (pending: PendingSend) => {
    if (inFlight.current.has(pending.requestId)) return;
    inFlight.current.add(pending.requestId);
    try {
      let accepted;
      try {
        accepted = await client.submission(
          pending.conversationId,
          pending.requestId,
        );
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'NOT_FOUND') throw e;
      }
      if (!accepted || accepted.status === 'acknowledged')
        await client.submit(
          pending.conversationId,
          pending.content,
          pending.requestId,
        );
      persist((previous) => ({
        ...previous,
        pending: previous.pending.filter(
          (item) => item.requestId !== pending.requestId,
        ),
        drafts: {
          ...previous.drafts,
          [pending.conversationId]:
            previous.drafts[pending.conversationId] === pending.content
              ? ''
              : previous.drafts[pending.conversationId],
        },
      }));
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INVALID_INPUT')
        persist((previous) => ({
          ...previous,
          pending: previous.pending.filter(
            (item) => item.requestId !== pending.requestId,
          ),
        }));
      setError(
        e instanceof Error
          ? e.message
          : 'Send uncertain. Your text and request ID are saved; retry to reconcile.',
      );
    } finally {
      inFlight.current.delete(pending.requestId);
    }
  };
  useEffect(() => {
    if (connection === 'connected')
      for (const pending of current.current.pending.filter(
        (item) => item.conversationId === selected,
      ))
        void reconcile(pending);
  }, [connection, selected]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (anchor.current !== undefined) {
      const saved = anchor.current;
      const item = Array.from(
        element.querySelectorAll<HTMLElement>(
          ':scope > [data-conversation-item]',
        ),
      ).find((node) => node.dataset.conversationItem === saved.key);
      element.scrollTop += item
        ? item.getBoundingClientRect().top - saved.top
        : element.scrollHeight - saved.height;
      anchor.current = undefined;
    } else if (follow.current) element.scrollTop = element.scrollHeight;
  }, [entries, snapshot]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected]);
  const create = async (savedCreation = current.current.creation) => {
    const creation = savedCreation ?? {
      title: title.trim() || 'New planning conversation',
      requestId: crypto.randomUUID(),
    };
    persist((previous) => ({ ...previous, creation }));
    setBusy(true);
    setError('');
    try {
      const conversation = await client.createConversation(
        creation.title,
        creation.requestId,
      );
      persist((previous) => ({
        ...previous,
        selected: conversation.id,
        creation: undefined,
      }));
      setTitle('');
      setNavigationOpen(false);
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not create conversation.',
      );
    } finally {
      setBusy(false);
    }
  };
  const action = async (work: () => Promise<unknown>) => {
    try {
      await work();
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not complete action.');
    }
  };
  const send = (event: React.FormEvent) => {
    event.preventDefault();
    const content = current.current.drafts[selected] ?? '';
    if (
      !content.trim() ||
      !snapshot ||
      snapshot.execution === 'interrupting' ||
      snapshot.conversation.role === 'review' ||
      snapshot.workflow?.acceptsInput === false ||
      current.current.pending.some((item) => item.conversationId === selected)
    )
      return;
    const pending = {
      conversationId: selected,
      content,
      requestId: crypto.randomUUID(),
    };
    persist((previous) => ({
      ...previous,
      pending: [...previous.pending, pending],
    }));
    void reconcile(pending);
  };
  const older = async () => {
    const view = activeView.current;
    if (!view || !isCurrent(view) || !view.cursor) return;
    setLoadingHistory(true);
    try {
      const page = await client.history(
        view.id,
        view.cursor,
        view.abort.signal,
      );
      if (!isCurrent(view)) return;
      const element = scroll.current;
      if (element) {
        const bounds = element.getBoundingClientRect();
        const item = Array.from(
          element.querySelectorAll<HTMLElement>(
            ':scope > [data-conversation-item]',
          ),
        ).find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        anchor.current = {
          key: item?.dataset.conversationItem,
          top: item?.getBoundingClientRect().top ?? bounds.top,
          height: element.scrollHeight,
        };
      }
      view.entries = mergeEntries(page.entries, view.entries);
      view.cursor = page.cursor;
      setEntries(view.entries);
      setCursor(view.cursor);
    } catch (e) {
      if (isCurrent(view))
        setError(e instanceof Error ? e.message : 'Could not load history.');
    } finally {
      if (isCurrent(view)) setLoadingHistory(false);
    }
  };
  const pending = local.pending.filter(
    (item) => item.conversationId === selected,
  );
  const interruptControl =
    snapshot &&
    snapshot.conversation.role !== 'review' &&
    snapshot.execution !== 'idle' ? (
      <span className="interrupt-row">
        <button
          className="text-button"
          type="button"
          disabled={snapshot.execution === 'interrupting'}
          title="Stops the current reply and withdraws queued inputs."
          onClick={() => void action(() => client.interrupt(selected))}
        >
          Interrupt conversation
        </button>
      </span>
    ) : null;
  const sidebar = (
    <div className="chat-sidebar">
      <a className="chat-brand" href="/">
        df<span>↗</span> <strong>durable factory</strong>
      </a>
      <div className="eyebrow">PLANNING CONVERSATIONS</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        className="new-conversation"
      >
        <label className="sr-only" htmlFor="conversation-title">
          Conversation title
        </label>
        <input
          id="conversation-title"
          placeholder="What are you planning?"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button className="primary" disabled={busy} type="submit">
          {local.creation ? 'Retry creating conversation' : 'New conversation'}{' '}
          <span>＋</span>
        </button>
        {local.creation && (
          <button
            type="button"
            className="text-button"
            onClick={() =>
              persist((previous) => ({ ...previous, creation: undefined }))
            }
          >
            Discard pending creation
          </button>
        )}
      </form>
      <nav aria-label="Saved conversations">
        {conversations.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={item.id === selected ? 'page' : undefined}
            className={item.id === selected ? 'selected' : ''}
            onClick={() => {
              persist((previous) => ({ ...previous, selected: item.id }));
              setNavigationOpen(false);
            }}
          >
            <strong>{item.title}</strong>
            <small>{item.model.model}</small>
          </button>
        ))}
      </nav>
      <a className="settings-link" href="/runs">
        Workflow runs
      </a>
      <a className="settings-link" href="/settings">
        Settings <span>↗</span>
      </a>
    </div>
  );
  return (
    <div className="chat-shell">
      {!mobile && <aside aria-label="Conversation navigation">{sidebar}</aside>}
      {mobile && (
        <Overlay
          open={navigationOpen}
          label="Conversations"
          onClose={() => setNavigationOpen(false)}
        >
          {sidebar}
        </Overlay>
      )}
      <main className="chat-main">
        <header className="chat-header">
          {mobile && (
            <button
              type="button"
              className="secondary navigation-toggle"
              aria-haspopup="dialog"
              aria-expanded={navigationOpen}
              onClick={() => setNavigationOpen(true)}
            >
              Conversations
            </button>
          )}
          <div>
            <div className="eyebrow">PLAN BEFORE YOU BUILD</div>
            <h1>
              {snapshot?.conversation.title ?? 'Make room for good ideas.'}
            </h1>
          </div>
          <div className="chat-status">
            <span data-connection={connection}>
              Browser: {selected ? connection : 'no conversation selected'}
            </span>
            <span>Agent: {snapshot?.execution ?? 'idle'}</span>
          </div>
          {snapshot?.planning?.ticket && (
            <button
              type="button"
              className="secondary ticket-toggle"
              aria-expanded={desktop ? ticketOpen : ticketOverlay}
              aria-haspopup={desktop ? undefined : 'dialog'}
              onClick={() =>
                desktop ? setTicketOpen(!ticketOpen) : setTicketOverlay(true)
              }
            >
              {desktop && ticketOpen ? 'Hide ticket' : 'Show ticket'}
            </button>
          )}
        </header>
        {error && (
          <div className="chat-error" role="alert">
            {error}
          </div>
        )}
        {!selected ? (
          <div className="chat-empty">
            <span>↳</span>
            <h2>Start with a conversation.</h2>
            <p>
              Choose a planning model in <a href="/settings">settings</a>, then
              create a conversation. Messages and replies stay here when you
              return.
            </p>
            <p>
              Inspect your repository, agree a ticket, then ask the agent to
              create a GitHub issue.
            </p>
          </div>
        ) : (
          <>
            <div
              className={`chat-workspace ${desktop && ticketOpen && snapshot?.planning?.ticket ? 'with-ticket' : ''}`}
            >
              <section
                key={selected}
                className="chat-conversation"
                aria-label="Conversation"
              >
                <div
                  className="transcript"
                  ref={scroll}
                  onScroll={() => {
                    const element = scroll.current!;
                    follow.current =
                      element.scrollHeight -
                        element.scrollTop -
                        element.clientHeight <
                      80;
                    setFollowing(follow.current);
                  }}
                  style={{ overflowAnchor: 'none' }}
                  aria-label="Conversation transcript"
                  tabIndex={0}
                >
                  {cursor && (
                    <button
                      className="secondary older-button"
                      disabled={loadingHistory}
                      type="button"
                      onClick={() => void older()}
                    >
                      Load older messages
                    </button>
                  )}
                  {conversationItems(entries, snapshot?.tools).map((item) => {
                    if (item.kind === 'tool')
                      return (
                        <Tool
                          key={item.key}
                          tool={item.tool}
                          conversationId={selected}
                        />
                      );
                    const { entry } = item;
                    const user = entry.kind === 'pi.user';
                    const assistant = entry.kind === 'pi.assistant';
                    return (
                      <article
                        key={item.key}
                        data-conversation-item={item.key}
                        className={`message ${user ? 'user-message' : assistant ? 'assistant-message' : 'event-message'}`}
                      >
                        <div className="message-author">
                          {user
                            ? 'You'
                            : entry.kind === 'pi.tool-result'
                              ? 'Tool result'
                              : entry.kind === 'pi.compaction'
                                ? 'Context summary'
                                : assistant
                                  ? label
                                  : 'Conversation event'}
                          {entry.interrupted && <span> · Interrupted</span>}
                        </div>
                        {entry.text &&
                          (assistant ? (
                            <div
                              className="message-text markdown"
                              dangerouslySetInnerHTML={{
                                __html: markdown(entry.text),
                              }}
                            />
                          ) : (
                            <div className="message-text">{entry.text}</div>
                          ))}
                        {entry.textArtifact && (
                          <Tool
                            key={entry.textArtifact}
                            tool={{
                              id: entry.id,
                              name: 'Complete message',
                              status: 'completed',
                              artifact: entry.textArtifact,
                            }}
                            conversationId={selected}
                          />
                        )}
                      </article>
                    );
                  })}
                  {snapshot?.partial && (
                    <article
                      className="message assistant-message"
                      data-conversation-item="partial"
                    >
                      <div className="message-author">{label} · Responding</div>
                      <div
                        className="message-text markdown"
                        dangerouslySetInnerHTML={{
                          __html: markdown(snapshot.partial),
                        }}
                      />
                    </article>
                  )}
                  {snapshot?.execution !== 'idle' &&
                    snapshot &&
                    !snapshot.partial && (
                      <div className="agent-activity" role="status">
                        <span aria-hidden="true">◌</span>
                        {label} ·{' '}
                        {snapshot.execution === 'interrupting'
                          ? 'Stopping…'
                          : 'Working…'}
                      </div>
                    )}
                  {!entries.length && !snapshot?.partial && (
                    <p className="transcript-hint">
                      Describe the outcome you want, constraints, and questions
                      to explore.
                    </p>
                  )}
                </div>
                {!following && (
                  <div className="jump-row">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        follow.current = true;
                        setFollowing(true);
                        if (scroll.current)
                          scroll.current.scrollTop =
                            scroll.current.scrollHeight;
                      }}
                    >
                      Jump to latest ↓
                    </button>
                  </div>
                )}
                <div className="composer-area">
                  <div
                    className="submission-list"
                    aria-label="Submission status"
                  >
                    {snapshot?.submissions
                      .filter((item) => item.status !== 'completed')
                      .map((item) => (
                        <div key={item.id || item.requestId}>
                          <span className="submission-text">
                            {item.content}
                          </span>
                          <strong>{item.status}</strong>
                          {item.reason && <small>{item.reason}</small>}
                          {item.status === 'queued' && (
                            <button
                              className="text-button"
                              type="button"
                              onClick={() =>
                                void action(() =>
                                  client.withdraw(selected, item.id),
                                )
                              }
                            >
                              Withdraw
                            </button>
                          )}
                        </div>
                      ))}
                    {pending.map((item) => (
                      <div key={item.requestId}>
                        <span className="submission-text">{item.content}</span>
                        <strong>Awaiting acknowledgement</strong>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => void reconcile(item)}
                        >
                          Retry send
                        </button>
                      </div>
                    ))}
                  </div>
                  {!snapshot ? (
                    <p role="status">Connecting to the conversation…</p>
                  ) : snapshot.conversation.role !== 'review' &&
                    snapshot.workflow?.acceptsInput !== false ? (
                    <form onSubmit={send} className="composer">
                      <label className="sr-only" htmlFor="chat-message">
                        Message
                      </label>
                      <textarea
                        id="chat-message"
                        placeholder="Think it through together…"
                        value={local.drafts[selected] ?? ''}
                        onChange={(e) =>
                          persist((previous) => ({
                            ...previous,
                            drafts: {
                              ...previous.drafts,
                              [selected]: e.target.value,
                            },
                          }))
                        }
                        onKeyDown={(event) => {
                          if (
                            event.key === 'Enter' &&
                            !event.shiftKey &&
                            !event.nativeEvent.isComposing &&
                            event.keyCode !== 229
                          ) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                        rows={2}
                      />
                      <div>
                        <small>
                          Enter to send · Shift + Enter for a new line
                        </small>
                        <div className="composer-actions">
                          {interruptControl}
                          <button
                            className="primary"
                            type="submit"
                            disabled={
                              !local.drafts[selected]?.trim() ||
                              snapshot?.execution === 'interrupting' ||
                              pending.length > 0
                            }
                          >
                            Send <span>↗</span>
                          </button>
                        </div>
                      </div>
                    </form>
                  ) : (
                    <p>
                      Implementation input is closed for this conversation.
                      Inspect the <a href="/runs">workflow run</a> for available
                      controls.
                    </p>
                  )}
                  {snapshot?.workflow?.acceptsInput === false &&
                    interruptControl}
                  <p className="composer-footnote">
                    Follow-ups queue while the agent works. Accepted work
                    continues after you close this window.
                  </p>
                </div>
              </section>
              {desktop && snapshot?.planning?.ticket && (
                <aside
                  hidden={!ticketOpen}
                  className="ticket-panel"
                  aria-label="Saved ticket"
                >
                  <Ticket
                    snapshot={snapshot}
                    selected={selected}
                    onError={setError}
                  />
                </aside>
              )}
            </div>
            {!desktop && snapshot?.planning?.ticket && (
              <Overlay
                open={ticketOverlay}
                label="Saved ticket"
                onClose={() => setTicketOverlay(false)}
              >
                <Ticket
                  snapshot={snapshot}
                  selected={selected}
                  onError={setError}
                />
              </Overlay>
            )}
          </>
        )}
      </main>
    </div>
  );
}
