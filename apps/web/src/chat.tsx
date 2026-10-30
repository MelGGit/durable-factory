import { ImplementationTranscript, RunInformation } from './run-chat.js';
import {
  conversationItems,
  agentLabel,
  type PresentationTool,
} from './transcript.js';
import { markdown } from './markdown.js';
import { Overlay, useMedia } from './panels.js';
import { StartRun } from './runs.js';
import { ProjectTree, followLink } from './sidebar.js';
import { Home } from './home.js';
import { Icon } from './icons.js';
import { SessionActions } from './session-actions.js';
import { PageHeader } from './page-header.js';
import { PageCardsToggle, PageWorkspace } from './page-cards.js';
import { SidebarBrand, WorkspaceShell } from './workspace-shell.js';
import { useConversationUrl, useRoute } from './hooks/use-route.js';
import { usePageHeader } from './hooks/use-page-header.js';
import { confirmLeave } from './hooks/use-unsaved-changes.js';
import { useProjects } from './hooks/use-projects.js';
import { useWorkflow } from './hooks/use-workflow.js';
import { Settings } from './settings.js';
import { AddProject } from './add-project.js';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ApiError,
  ChatClient,
  WorkflowClient,
  acceptsTypedAnswer,
  type Intervention,
  type DeletionOperation,
  type WorkflowSnapshot,
  type WorkflowRun,
  mergeEntries,
  runUpdatedAt,
  DEFAULT_PROJECT_ID,
  type ProjectSummary,
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
const workflowClient = new WorkflowClient();
type ConversationView = {
  id: string;
  abort: AbortController;
  entries: TranscriptEntry[];
  cursor?: string;
  seenSnapshot?: boolean;
  linkedRunId?: string;
  startEntry?: string;
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
export function Tool({
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
function PlanningOperation({
  snapshot,
  selected,
  onError,
}: {
  snapshot: ConversationSnapshot;
  selected: string;
  onError: (message: string) => void;
}) {
  const planning = snapshot.planning;
  if (!planning?.operation) return null;
  return (
    <div role="status">
      <p>
        Issue:{' '}
        {planning.operation.kind === 'update' &&
        planning.operation.state === 'created'
          ? 'updated'
          : planning.operation.state}
      </p>
      {planning.operation.message && <p>{planning.operation.message}</p>}
      {planning.operation.issue && (
        <a href={planning.operation.issue.url} target="_blank" rel="noreferrer">
          View issue #{planning.operation.issue.number}
        </a>
      )}
      {planning.operation.issue && <StartRun conversationId={selected} />}
      {['prepared', 'sending', 'uncertain', 'rejected', 'blocked'].includes(
        planning.operation.state,
      ) && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void client.retryIssue(selected).catch((e) => onError(e.message));
          }}
        >
          Retry{' '}
          {planning.operation.state === 'rejected' ||
          planning.operation.state === 'prepared'
            ? planning.sourceIssue
              ? 'issue update'
              : 'issue creation'
            : 'reconciliation'}
        </button>
      )}
    </div>
  );
}

export function ChatApp() {
  const {
    route,
    navigate: navigateRoute,
    enterChat,
  } = useRoute((next) => {
    // Back/Forward to a settings view must not touch the selection.
    if (next.kind !== 'chat') return;
    persist((previous) => ({
      ...previous,
      selected:
        new URLSearchParams(window.location.search).get('conversation') ?? '',
    }));
  });
  const navigate = (path: string) => {
    navigateRoute(path);
    setNavigationOpen(false);
  };
  const [local, setLocal] = useState<ChatLocalState>(() => {
    const state = restoreChatState();
    const selected = new URLSearchParams(window.location.search).get(
      'conversation',
    );
    return selected
      ? { ...state, selected }
      : new URLSearchParams(window.location.search).has('empty')
        ? { ...state, selected: '' }
        : state;
  });
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const { projects, visibleProjects, reloadProjects } = useProjects();
  const { workflowSnapshot, setWorkflowSnapshot, deletions, setDeletions } =
    useWorkflow();
  const [activityConnected, setActivityConnected] = useState(false);
  const [activityVersion, setActivityVersion] = useState(0);
  const [storedSnapshot, setSnapshot] = useState<ConversationSnapshot>();
  const snapshot =
    storedSnapshot?.conversation.id === local.selected
      ? storedSnapshot
      : undefined;
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const visibleEntries =
    snapshot && !snapshot.conversation.runId ? entries : [];
  const [cursor, setCursor] = useState<string>();
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
    run: boolean;
  }>();
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const mobile = useMedia('(max-width: 759px)');
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
  const selectedRun = workflowSnapshot?.runs.find(
    (run) =>
      run.developerConversationId === selected ||
      run.attempts.some((a) => a.conversationId === selected),
  );
  // Blockers that need a button leave the composer alone; typed questions are
  // answered from it when exactly one is open, so the reply lands in the chat.
  const openQuestions =
    selectedRun?.interventions.filter(
      (question) =>
        question.state === 'pending' && acceptsTypedAnswer(question),
    ) ?? [];
  const composerQuestion =
    openQuestions.length === 1 &&
    ['paused', 'needs_input'].includes(selectedRun!.status)
      ? openQuestions[0]
      : undefined;
  const awaitingRunAnswer = openQuestions.length > 1;
  const [answering, setAnswering] = useState(false);
  const answerReceipt = useRef<
    { key: string; id: string; revision: number } | undefined
  >(undefined);
  const selectedDeletion = deletions.find(
    (operation) =>
      operation.state !== 'completed' &&
      operation.conversationIds.includes(selected),
  );
  const header = usePageHeader({
    route,
    projects: visibleProjects,
    snapshot,
    selectedRun,
    hasSelection: Boolean(selected),
  });
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
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
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
  const selectConversation = (id: string) => {
    if (route.kind !== 'chat' && !confirmLeave()) return;
    if (route.kind !== 'chat') enterChat(id ? `/?conversation=${id}` : '/');
    persist((previous) => ({ ...previous, selected: id }));
    setNavigationOpen(false);
  };
  const updateRun = (run: WorkflowRun) => {
    setWorkflowSnapshot((previous) =>
      previous
        ? {
            ...previous,
            runs: [...previous.runs.filter((r) => r.id !== run.id), run],
          }
        : previous,
    );
    if (selected !== run.developerConversationId)
      selectConversation(run.developerConversationId);
    void refresh().catch((e) => setError(e.message));
  };
  const completedIds = deletions
    .filter((operation) => operation.state === 'completed')
    .flatMap((operation) => operation.conversationIds)
    .join(',');
  useEffect(() => {
    const ids = new Set(completedIds.split(',').filter(Boolean));
    if (!ids.size) return;
    // Explicit deletion supersedes draft preservation, including drafts in other tabs.
    try {
      for (const id of ids)
        localStorage.removeItem(`${chatStorageKey}.draft.${id}`);
    } catch {
      setError(
        'Browser storage is unavailable. Deleted chat drafts could not be cleared.',
      );
    }
    persist((previous) => ({
      ...previous,
      selected: ids.has(previous.selected) ? '' : previous.selected,
      drafts: Object.fromEntries(
        Object.entries(previous.drafts).filter(([id]) => !ids.has(id)),
      ),
      pending: previous.pending.filter((item) => !ids.has(item.conversationId)),
    }));
    setConversations((previous) =>
      previous.filter((item) => !ids.has(item.id)),
    );
    setWorkflowSnapshot((previous) =>
      previous
        ? {
            ...previous,
            runs: previous.runs.filter(
              (run) => !ids.has(run.developerConversationId),
            ),
          }
        : previous,
    );
  }, [completedIds, selected]);
  const confirmDeletion = async () => {
    if (!deleteTarget || deletingBusy) return;
    setDeletingBusy(true);
    setDeleteError('');
    try {
      const operation = await (deleteTarget.run
        ? client.deleteRun(deleteTarget.id)
        : client.deleteConversation(deleteTarget.id));
      setDeletions((previous) => [
        ...previous.filter((item) => item.id !== operation.id),
        operation,
      ]);
      setDeleteTarget(undefined);
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : 'Unable to request deletion. Retry.',
      );
    } finally {
      setDeletingBusy(false);
    }
  };
  const deletionControl = (id: string, title: string, run: boolean) => {
    const operation = deletions.find(
      (item) =>
        item.state !== 'completed' &&
        (run ? item.runId === id : item.conversationIds.includes(id)),
    );
    return (
      <div className="chat-delete-control">
        {operation && (
          <small className="sr-only" role="status">
            {operation.message}
          </small>
        )}
        <SessionActions
          title={title}
          disabled={Boolean(operation && operation.state !== 'blocked')}
          retry={operation?.state === 'blocked'}
          status={operation?.message}
          onDelete={() => {
            setDeleteError('');
            setDeleteTarget({ id, title, run });
          }}
        />
      </div>
    );
  };
  const runIds = workflowSnapshot?.runs.map((r) => r.id).join(',');
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [runIds]);
  useConversationUrl(selected, route, enterChat);
  useEffect(() => {
    if (selectedRun && selected !== selectedRun.developerConversationId)
      selectConversation(selectedRun.developerConversationId);
  }, [selectedRun?.id, selected]);
  useEffect(() => {
    if (
      workflowSnapshot &&
      snapshot?.conversation.runId &&
      !workflowSnapshot.runs.some((r) => r.id === snapshot.conversation.runId)
    )
      selectConversation('');
  }, [workflowSnapshot?.runs.length, snapshot?.conversation.runId]);
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
    follow.current = true;
    anchor.current = undefined;
    if (!selected) {
      setConnection('disconnected');
      return;
    }
    if (selectedRun) return;
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
        const linkedRunId = value.planning?.runId;
        const startEntry = value.entries.findLast(
          (entry) =>
            entry.kind === 'pi.tool-result' &&
            entry.tools.some(
              (tool) =>
                tool.name === 'start_development' &&
                tool.status === 'completed',
            ),
        )?.id;
        const explicitStart =
          view.seenSnapshot &&
          linkedRunId &&
          (linkedRunId !== view.linkedRunId ||
            (startEntry && startEntry !== view.startEntry));
        view.seenSnapshot = true;
        view.linkedRunId = linkedRunId;
        view.startEntry = startEntry;
        if (explicitStart) {
          try {
            const run = await workflowClient.run(linkedRunId);
            if (isCurrent(view)) updateRun(run);
          } catch (error) {
            if (isCurrent(view))
              setError(
                error instanceof Error
                  ? error.message
                  : 'Unable to open implementation.',
              );
          }
          return;
        }
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
        setConversations((previous) =>
          previous.map((item) =>
            item.id === value.conversation.id ? value.conversation : item,
          ),
        );
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
  }, [selected, selectedRun?.id]);
  const reconcile = async (pending: PendingSend) => {
    if (
      deletions.some((operation) =>
        operation.conversationIds.includes(pending.conversationId),
      ) ||
      inFlight.current.has(pending.requestId)
    )
      return;
    inFlight.current.add(pending.requestId);
    try {
      // The request ID is the AG-UI user-message ID, so repeating an uncertain
      // send reuses its earlier admission instead of queueing the text twice.
      await client.send(
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
  }, [entries, snapshot, activityVersion]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected]);
  // Queued runs start oldest first, whichever project they belong to.
  const queuePosition = new Map(
    (workflowSnapshot?.runs ?? [])
      .filter((run) => run.status === 'queued')
      .sort((a, b) => a.queueOrder - b.queueOrder)
      .map((run, index) => [run.id, index + 1] as const),
  );
  const create = async (
    projectId: string,
    savedCreation = current.current.creation,
  ) => {
    const creation = savedCreation ?? {
      title: 'New planning conversation',
      requestId: crypto.randomUUID(),
      projectId,
    };
    persist((previous) => ({ ...previous, creation }));
    setBusy(true);
    setError('');
    try {
      const conversation = await new ChatClient(
        '',
        undefined,
        creation.projectId,
      ).createConversation(creation.title, creation.requestId);
      persist((previous) => ({
        ...previous,
        selected: conversation.id,
        creation: undefined,
      }));
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
      awaitingRunAnswer ||
      current.current.pending.some((item) => item.conversationId === selected)
    )
      return;
    if (composerQuestion && selectedRun) {
      void answerQuestion(selectedRun, composerQuestion, content);
      return;
    }
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
  const answerQuestion = async (
    run: WorkflowRun,
    question: Intervention,
    content: string,
  ) => {
    if (answering) return;
    setAnswering(true);
    // A retry of the same answer keeps its operation ID, so it cannot apply twice.
    const key = `${question.id}:${question.revision}:${content}`;
    const receipt =
      answerReceipt.current?.key === key
        ? answerReceipt.current
        : { key, id: crypto.randomUUID(), revision: run.revision };
    answerReceipt.current = receipt;
    try {
      updateRun(
        await workflowClient.command(run.id, {
          action: 'answer',
          operationId: receipt.id,
          expectedRevision: receipt.revision,
          interventionId: question.id,
          interventionRevision: question.revision,
          answer: content,
        }),
      );
      answerReceipt.current = undefined;
      persist((previous) => ({
        ...previous,
        drafts: {
          ...previous.drafts,
          [selected]:
            previous.drafts[selected] === content
              ? ''
              : previous.drafts[selected],
        },
      }));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer.');
    } finally {
      setAnswering(false);
    }
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
  const emptyPlanning = Boolean(
    snapshot?.conversation.role === 'planning' &&
      !selectedRun &&
      !entries.length &&
      !cursor &&
      !snapshot.partial &&
      !snapshot.tools.length &&
      snapshot.execution === 'idle' &&
      !snapshot.submissions.length &&
      !pending.length,
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
  const inChat = route.kind === 'chat';
  const atHome = inChat && !selected;
  const sidebar = (
    <div className="chat-sidebar">
      {mobile && (
        <SidebarBrand
          open={navigationOpen}
          onToggle={() => setNavigationOpen(false)}
        />
      )}
      <a
        className={`home-link ${atHome ? 'selected' : ''}`}
        href="/"
        aria-current={atHome ? 'page' : undefined}
        onClick={(event) => followLink(event, () => selectConversation(''))}
      >
        <Icon name="home" />
        Home
      </a>
      <a
        className={`add-project ${route.kind === 'add-project' ? 'selected' : ''}`}
        href="/projects/new"
        aria-current={route.kind === 'add-project' ? 'page' : undefined}
        onClick={(event) => followLink(event, () => navigate('/projects/new'))}
      >
        <Icon name="plus" />
        Add project
      </a>
      <div className="sidebar-heading">Projects</div>
      <ProjectTree
        projects={visibleProjects}
        conversations={conversations}
        runs={workflowSnapshot?.runs ?? []}
        workflowDisabled={workflowSnapshot?.mode === 'disabled'}
        renderConversation={(item) => (
          <div
            key={item.id}
            className={`chat-navigation-row${inChat && item.id === selected ? ' selected-session' : ''}`}
          >
            <button
              type="button"
              aria-current={inChat && item.id === selected ? 'page' : undefined}
              className={`session-link${inChat && item.id === selected ? ' selected' : ''}`}
              title={item.title}
              onClick={() => {
                selectConversation(item.id);
              }}
            >
              <strong>{item.title}</strong>
              <span
                className="session-kind"
                role="img"
                aria-label="Planning"
                title="Planning"
              >
                <Icon name="plan" size={15} />
              </span>
            </button>
            {deletionControl(item.id, item.title, false)}
          </div>
        )}
        renderRun={(run) => (
          <div
            key={run.id}
            className={`chat-navigation-row${inChat && selectedRun?.id === run.id ? ' selected-session' : ''}`}
          >
            <button
              type="button"
              className={`session-link${inChat && selectedRun?.id === run.id ? ' selected' : ''}`}
              title={`${run.mode === 'simulation' ? 'Simulation · ' : ''}${run.status.replaceAll('_', ' ')}${run.status === 'queued' ? ` · position ${queuePosition.get(run.id)}` : ''} · #${run.issue.number} · ${run.specification.title}`}
              aria-current={
                inChat && selectedRun?.id === run.id ? 'page' : undefined
              }
              onClick={() => selectConversation(run.developerConversationId)}
            >
              <strong>
                #{run.issue.number} · {run.specification.title}
              </strong>
              <span
                className="session-kind implementation"
                role="img"
                aria-label="Implementation"
                title="Implementation"
              >
                <Icon name="code" size={15} />
              </span>
            </button>
            {deletionControl(run.id, run.specification.title, true)}
          </div>
        )}
        onNew={(projectId) => void create(projectId)}
        navigate={navigate}
        activeSettings={
          route.kind === 'project-settings' ? route.projectId : undefined
        }
      />
      <a
        className="settings-link"
        href="/settings"
        aria-current={route.kind === 'settings' ? 'page' : undefined}
        onClick={(event) => followLink(event, () => navigate('/settings'))}
      >
        <Icon name="settings" />
        Settings
      </a>
    </div>
  );
  return (
    <WorkspaceShell
      mobile={mobile}
      navigation={sidebar}
      header={
        <PageHeader
          title={header.title}
          tag={header.tag}
          navigationOpen={navigationOpen}
          onOpenNavigation={mobile ? () => setNavigationOpen(true) : undefined}
          actions={
            <PageCardsToggle disabled={inChat && Boolean(selectedDeletion)} />
          }
        />
      }
    >
      {mobile && (
        <Overlay
          open={navigationOpen}
          label="Conversations"
          onClose={() => setNavigationOpen(false)}
        >
          {sidebar}
        </Overlay>
      )}
      <Overlay
        open={Boolean(deleteTarget)}
        label="Delete chat"
        title={`Delete “${deleteTarget?.title ?? ''}”?`}
        className="confirmation-overlay"
        descriptionId="delete-chat-description"
        closeDisabled={deletingBusy}
        onClose={() => {
          if (!deletingBusy) setDeleteTarget(undefined);
        }}
      >
        <div className="delete-confirmation">
          <p id="delete-chat-description">
            {deleteTarget?.run
              ? 'This permanently deletes this implementation, its chat history, and the entire local worktree, including all files and unpublished changes.'
              : 'This permanently deletes this planning chat and its history.'}
          </p>
          <p className="delete-context">
            {deleteTarget?.run
              ? 'The linked planning chat is kept.'
              : 'Linked implementations and their worktrees are kept.'}{' '}
            Active agents and commands will stop first.
          </p>
          <p className="delete-warning">This cannot be undone.</p>
          {deleteError && <p role="alert">{deleteError}</p>}
        </div>
        <div className="confirmation-actions">
          <button
            type="button"
            className="secondary"
            disabled={deletingBusy}
            onClick={() => setDeleteTarget(undefined)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            disabled={deletingBusy}
            onClick={() => void confirmDeletion()}
          >
            {deletingBusy ? 'Requesting…' : 'Delete permanently'}
          </button>
        </div>
      </Overlay>
      <PageWorkspace disabled={inChat && Boolean(selectedDeletion)}>
        {route.kind !== 'chat' ? (
          <>
            <div className="view-scroll">
              {route.kind === 'settings' && (
                <Settings
                  key="general"
                  onChanged={() => reloadProjects()}
                  onDeleted={() => selectConversation('')}
                />
              )}
              {route.kind === 'project-settings' && (
                <Settings
                  key={route.projectId}
                  projectId={route.projectId}
                  onChanged={() => reloadProjects()}
                  onDeleted={() => selectConversation('')}
                />
              )}
              {route.kind === 'add-project' && (
                <AddProject
                  onCreated={() => {
                    reloadProjects();
                    selectConversation('');
                  }}
                  onCancel={() => selectConversation('')}
                />
              )}
            </div>
          </>
        ) : (
          <>
            {error && (
              <div className="chat-error" role="alert">
                {error}
              </div>
            )}
            {selectedDeletion && (
              <p className="chat-error" role="status">
                {selectedDeletion.message}
              </p>
            )}
            {!selected ? (
              <Home
                projects={visibleProjects}
                conversations={conversations}
                runs={workflowSnapshot?.runs ?? []}
                deletions={deletions}
                onNew={(projectId) => void create(projectId)}
                onOpen={(id) => {
                  void refresh().catch((e) => setError(e.message));
                  selectConversation(id);
                }}
                onRun={updateRun}
                workflowMode={workflowSnapshot?.mode ?? 'disabled'}
              />
            ) : (
              <>
                {selectedRun && workflowSnapshot && (
                  <RunInformation
                    key={selectedRun.id}
                    run={selectedRun}
                    snapshot={workflowSnapshot}
                    onRun={updateRun}
                  />
                )}
                <div
                  inert={Boolean(selectedDeletion)}
                  className="chat-workspace"
                >
                  <section
                    key={selected}
                    className={`chat-conversation${emptyPlanning ? ' empty-planning' : ''}`}
                    aria-label="Conversation"
                    data-connection={connection}
                    data-execution={snapshot?.execution ?? 'idle'}
                    data-activity={
                      activityConnected ? 'connected' : 'reconnecting'
                    }
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
                      {!selectedRun && cursor && (
                        <button
                          className="secondary older-button"
                          disabled={loadingHistory}
                          type="button"
                          onClick={() => void older()}
                        >
                          Load older messages
                        </button>
                      )}
                      {selectedRun ? (
                        <ImplementationTranscript
                          key={selectedRun.id}
                          run={selectedRun}
                          onRun={updateRun}
                          onChange={() =>
                            setActivityVersion((value) => value + 1)
                          }
                          onConversation={(value) => {
                            if (
                              value.conversation.id !== current.current.selected
                            )
                              return;
                            setSnapshot({
                              ...value,
                              entries: [],
                              tools: [],
                              partial: '',
                            });
                          }}
                          onConnection={(connected) => {
                            setActivityConnected(connected);
                            setConnection(
                              connected ? 'connected' : 'disconnected',
                            );
                          }}
                        />
                      ) : (
                        conversationItems(visibleEntries, snapshot?.tools).map(
                          (item) => {
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
                                  {entry.interrupted && (
                                    <span> · Interrupted</span>
                                  )}
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
                                    <div className="message-text">
                                      {entry.text}
                                    </div>
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
                          },
                        )
                      )}
                      {!selectedRun &&
                        !snapshot?.conversation.runId &&
                        snapshot?.partial && (
                          <article
                            className="message assistant-message"
                            data-conversation-item="partial"
                          >
                            <div className="message-author">
                              {label} · Responding
                            </div>
                            <div
                              className="message-text markdown"
                              dangerouslySetInnerHTML={{
                                __html: markdown(snapshot.partial),
                              }}
                            />
                          </article>
                        )}
                      {!selectedRun &&
                        snapshot?.execution !== 'idle' &&
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
                      {!emptyPlanning &&
                        !selectedRun &&
                        !entries.length &&
                        !snapshot?.partial && (
                          <p className="transcript-hint">
                            Describe the feature you want to build and any
                            constraints.
                          </p>
                        )}
                      {!selectedRun && snapshot && (
                        <div inert={Boolean(selectedDeletion)}>
                          <PlanningOperation
                            snapshot={snapshot}
                            selected={selected}
                            onError={setError}
                          />
                          {workflowSnapshot?.runs
                            .filter(
                              (run) => run.planningConversationId === selected,
                            )
                            .map((run) => (
                              <a
                                className="linked-implementation"
                                key={run.id}
                                href={`/?conversation=${run.developerConversationId}`}
                              >
                                Open implementation · #{run.issue.number} ·{' '}
                                {run.status}
                              </a>
                            ))}
                        </div>
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
                      {emptyPlanning && (
                        <div className="chat-welcome">
                          <h2>What feature would you like to plan?</h2>
                          <p>
                            Describe the feature, who it’s for, and what success
                            looks like.
                          </p>
                          {!local.drafts[selected]?.trim() && (
                            <div
                              className="starter-prompts"
                              aria-label="Conversation starters"
                            >
                              {[
                                [
                                  'Plan a feature',
                                  'I’d like to plan a new feature: ',
                                ],
                                [
                                  'Define requirements',
                                  'Help me define the requirements for this feature: ',
                                ],
                                [
                                  'Break down a feature',
                                  'Help me break this feature into implementation steps: ',
                                ],
                              ].map(([prompt, draft]) => (
                                <button
                                  type="button"
                                  className="secondary"
                                  key={prompt}
                                  onClick={() => {
                                    persist((previous) => ({
                                      ...previous,
                                      drafts: {
                                        ...previous.drafts,
                                        [selected]: draft,
                                      },
                                    }));
                                    document
                                      .getElementById('chat-message')
                                      ?.focus();
                                  }}
                                >
                                  {prompt}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
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
                            <span className="submission-text">
                              {item.content}
                            </span>
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
                      ) : awaitingRunAnswer ? (
                        <p className="composer-footnote">
                          Answer each open question above to continue the
                          implementation.
                        </p>
                      ) : snapshot.conversation.role !== 'review' &&
                        snapshot.workflow?.acceptsInput !== false ? (
                        <form onSubmit={send} className="composer">
                          <label className="sr-only" htmlFor="chat-message">
                            Message
                          </label>
                          <textarea
                            id="chat-message"
                            placeholder={
                              composerQuestion
                                ? 'Reply to the question to continue…'
                                : selectedRun
                                  ? 'Guide the implementation or ask a question…'
                                  : 'Describe the feature you want to plan…'
                            }
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
                                  answering ||
                                  pending.length > 0
                                }
                              >
                                Send <Icon name="send" size={14} />
                              </button>
                            </div>
                          </div>
                        </form>
                      ) : (
                        <p>
                          Implementation input is closed for this conversation.
                          Available controls are in Chat trails.
                        </p>
                      )}
                      {snapshot?.workflow?.acceptsInput === false &&
                        interruptControl}
                      {!awaitingRunAnswer && (
                        <p className="composer-footnote">
                          {composerQuestion
                            ? 'Your reply answers the open question and resumes the run.'
                            : 'Follow-ups queue while the agent works. Accepted work continues after you close this window.'}
                        </p>
                      )}
                    </div>
                  </section>
                </div>
              </>
            )}
          </>
        )}
      </PageWorkspace>
    </WorkspaceShell>
  );
}
