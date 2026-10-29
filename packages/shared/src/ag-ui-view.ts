import type { BaseEvent, Message } from '@ag-ui/core';
import {
  HttpAgent,
  runHttpRequest,
  transformHttpEventStream,
  type AgentSubscriber,
} from '@ag-ui/client';
import { agUiMessages, FACTORY_AG_UI_VERSION } from './ag-ui.js';
import { API_VERSION, ApiError, responseError } from './core.js';
import type {
  ConnectionState,
  ConversationSnapshot,
  ToolView,
  TranscriptEntry,
} from './chat.js';
import type { RunActivityItem, RunActivityPage } from './activity.js';

/**
 * Observation views are plain AG-UI streams. Transcript content travels as
 * messages (`MESSAGES_SNAPSHOT`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`); everything the
 * message model cannot express travels as agent state (`STATE_SNAPSHOT`, then
 * `STATE_DELTA` JSON patches). Each batch of events that forms one consistent
 * view ends with a `CUSTOM` `factory.frame` marker.
 */
export const FRAME_EVENT = 'factory.frame';

type Json = Record<string, unknown>;
export interface ToolMeta {
  name: string;
  status: ToolView['status'];
  arguments?: string;
  noArguments?: true;
  artifact?: string;
  truncated?: boolean;
}
/** Transcript fields with no AG-UI message equivalent, keyed by message prefix. */
export interface EntryMeta {
  id: string;
  kind: string;
  at?: number;
  interrupted?: boolean;
  textArtifact?: string;
  /** Original AG-UI id of a user message, when it differs from the entry's. */
  messageId?: string;
  text?: string;
  tools?: Record<string, ToolMeta>;
}
export interface AgUiView<T> {
  messages: Message[];
  state: { factory: T & { schemaVersion: 1; apiVersion: string } };
}
interface ConversationState {
  kind: 'conversation';
  conversation: ConversationSnapshot['conversation'];
  workflow?: ConversationSnapshot['workflow'];
  planning?: ConversationSnapshot['planning'];
  submissions: ConversationSnapshot['submissions'];
  execution: ConversationSnapshot['execution'];
  olderCursor?: string;
  entries: Record<string, EntryMeta>;
  tools: ToolView[];
}
type ActivityItemState = Omit<RunActivityItem, 'entry'> & { entryKey?: string };
interface ActivityState {
  kind: 'activity';
  conversation?: RunActivityPage['conversation'];
  items: ActivityItemState[];
  updates?: ActivityItemState[];
  cursor?: string;
  live: Omit<RunActivityPage['live'][number], 'partial'>[];
  entries: Record<string, EntryMeta>;
}
interface HistoryState {
  kind: 'history';
  entries: Record<string, EntryMeta>;
  order: string[];
  cursor?: string;
}

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const entryKey = (threadId: string, id: string) => `${threadId}:entry:${id}`;
const liveId = (threadId: string) => `${threadId}:live`;
const toolCallId = (threadId: string, id: string) => `${threadId}:${id}`;

function entryMeta(entry: TranscriptEntry): EntryMeta {
  return {
    id: entry.id,
    kind: entry.kind,
    ...(entry.at === undefined ? {} : { at: entry.at }),
    ...(entry.interrupted ? { interrupted: true } : {}),
    ...(entry.textArtifact ? { textArtifact: entry.textArtifact } : {}),
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(entry.kind === 'pi.tool-result' && entry.text
      ? { text: entry.text }
      : {}),
    ...(entry.tools.length
      ? {
          tools: Object.fromEntries(
            entry.tools.map((tool) => [
              tool.id,
              {
                name: tool.name,
                status: tool.status,
                ...(tool.arguments === undefined
                  ? { noArguments: true as const }
                  : entry.kind === 'pi.tool-result'
                    ? { arguments: tool.arguments }
                    : {}),
                ...(tool.artifact ? { artifact: tool.artifact } : {}),
                ...(tool.truncated ? { truncated: true } : {}),
              },
            ]),
          ),
        }
      : {}),
  };
}

function entriesMeta(threadId: string, entries: readonly TranscriptEntry[]) {
  return Object.fromEntries(
    entries.map((entry) => [entryKey(threadId, entry.id), entryMeta(entry)]),
  );
}

/** The generation in progress, plus tools that have no durable entry yet. */
function liveMessages(
  threadId: string,
  partial: string,
  tools: readonly ToolView[],
  committed: ReadonlySet<string>,
): Message[] {
  const pending = tools.filter((tool) => !committed.has(tool.id));
  if (!partial && !pending.length) return [];
  return [
    {
      id: liveId(threadId),
      role: 'assistant',
      content: partial,
      ...(pending.length
        ? {
            toolCalls: pending.map((tool) => ({
              id: toolCallId(threadId, tool.id),
              type: 'function' as const,
              function: { name: tool.name, arguments: tool.arguments ?? '{}' },
            })),
          }
        : {}),
    },
    ...pending
      .filter((tool) => tool.status === 'completed' || tool.status === 'failed')
      .map(
        (tool): Message => ({
          id: `${threadId}:result:${tool.id}`,
          role: 'tool',
          toolCallId: toolCallId(threadId, tool.id),
          content: tool.output ?? '',
          ...(tool.status === 'failed' ? { error: 'Tool failed' } : {}),
        }),
      ),
  ];
}

export function conversationState(
  snapshot: ConversationSnapshot,
): AgUiView<ConversationState>['state'] {
  return json({
    factory: {
      schemaVersion: FACTORY_AG_UI_VERSION,
      apiVersion: API_VERSION,
      kind: 'conversation' as const,
      conversation: snapshot.conversation,
      workflow: snapshot.workflow,
      planning: snapshot.planning,
      submissions: snapshot.submissions,
      execution: snapshot.execution,
      olderCursor: snapshot.olderCursor,
      entries: entriesMeta(snapshot.conversation.id, snapshot.entries),
      tools: snapshot.tools,
    },
  });
}

export function conversationView(
  snapshot: ConversationSnapshot,
): AgUiView<ConversationState> {
  const threadId = snapshot.conversation.id;
  const committed = new Set(
    snapshot.entries.flatMap((entry) => entry.tools.map((tool) => tool.id)),
  );
  return json({
    messages: [
      ...agUiMessages(threadId, snapshot.entries),
      ...liveMessages(threadId, snapshot.partial, snapshot.tools, committed),
    ],
    state: conversationState(snapshot),
  });
}

export function activityView(page: RunActivityPage): AgUiView<ActivityState> {
  const messages = new Map<string, Message>();
  const entries: Record<string, EntryMeta> = {};
  const committed = new Map<string, Set<string>>();
  const strip = (item: RunActivityItem): ActivityItemState => {
    const { entry, ...rest } = item;
    if (!entry || !item.conversationId) return rest;
    const key = entryKey(item.conversationId, entry.id);
    entries[key] = entryMeta(entry);
    for (const message of agUiMessages(item.conversationId, [entry]))
      messages.set(message.id, message);
    const tools = committed.get(item.conversationId) ?? new Set<string>();
    for (const tool of entry.tools) tools.add(tool.id);
    committed.set(item.conversationId, tools);
    return { ...rest, entryKey: key };
  };
  const items = page.items.map(strip);
  const updates = page.updates?.map(strip);
  for (const source of page.live)
    for (const message of liveMessages(
      source.conversationId,
      source.partial,
      source.tools,
      committed.get(source.conversationId) ?? new Set(),
    ))
      messages.set(message.id, message);
  return json({
    messages: [...messages.values()],
    state: {
      factory: {
        schemaVersion: FACTORY_AG_UI_VERSION,
        apiVersion: API_VERSION,
        kind: 'activity' as const,
        conversation: page.conversation,
        items,
        updates,
        cursor: page.cursor,
        live: page.live.map(({ partial: _partial, ...source }) => source),
        entries,
      },
    },
  });
}

/** A page of durable history, for loading older entries on demand. */
export function historyView(
  threadId: string,
  entries: readonly TranscriptEntry[],
  cursor?: string,
): AgUiView<HistoryState> {
  return json({
    messages: agUiMessages(threadId, entries),
    state: {
      factory: {
        schemaVersion: FACTORY_AG_UI_VERSION,
        apiVersion: API_VERSION,
        kind: 'history' as const,
        entries: entriesMeta(threadId, entries),
        order: entries.map((entry) => entryKey(threadId, entry.id)),
        cursor,
      },
    },
  });
}

export const viewSnapshotEvents = (view: AgUiView<object>): BaseEvent[] => [
  { type: 'MESSAGES_SNAPSHOT', messages: view.messages } as BaseEvent,
  { type: 'STATE_SNAPSHOT', snapshot: view.state } as BaseEvent,
];

// ---------------------------------------------------------------------------
// Events: server side

type Patch = {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
}[];
const escapePointer = (key: string) =>
  key.replace(/~/g, '~0').replace(/\//g, '~1');
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** RFC 6902 patch between two JSON values. Objects recurse; arrays replace. */
export function diffState(
  before: unknown,
  after: unknown,
  path = '',
  patch: Patch = [],
): Patch {
  if (isObject(before) && isObject(after)) {
    for (const key of Object.keys(before))
      if (!Object.hasOwn(after, key))
        patch.push({ op: 'remove', path: `${path}/${escapePointer(key)}` });
    for (const key of Object.keys(after)) {
      const child = `${path}/${escapePointer(key)}`;
      if (Object.hasOwn(before, key))
        diffState(before[key], after[key], child, patch);
      else patch.push({ op: 'add', path: child, value: after[key] });
    }
  } else if (JSON.stringify(before) !== JSON.stringify(after))
    patch.push({ op: 'replace', path, value: after });
  return patch;
}

const sameMessage = (a: Message, b: Message) =>
  JSON.stringify(a) === JSON.stringify(b);
const text = (message: Message) =>
  typeof message.content === 'string' ? message.content : '';
const calls = (message: Message) =>
  message.role === 'assistant' ? (message.toolCalls ?? []) : [];

/** `next` only adds text and tool calls to the same open assistant message. */
function grows(previous: Message, next: Message) {
  return (
    previous.id === next.id &&
    previous.role === 'assistant' &&
    next.role === 'assistant' &&
    text(next).startsWith(text(previous)) &&
    calls(previous).every(
      (call, index) =>
        JSON.stringify(call) === JSON.stringify(calls(next)[index]),
    )
  );
}

/**
 * Turns successive message lists into AG-UI events. Appended messages and text
 * growth become `TEXT_MESSAGE_*`, `TOOL_CALL_*` events; anything else is sent as
 * a replacement `MESSAGES_SNAPSHOT`. The in-progress generation (`…:live`) stays
 * open between updates so tokens can be streamed as deltas.
 */
export class AgUiMessageStream {
  private previous?: Message[];
  private open = new Set<string>();
  /** Closes any message still open, before the run ends. */
  finish(): BaseEvent[] {
    const events = [...this.open].map(
      (messageId) => ({ type: 'TEXT_MESSAGE_END', messageId }) as BaseEvent,
    );
    this.open.clear();
    return events;
  }
  update(next: readonly Message[]): BaseEvent[] {
    const events: BaseEvent[] = [];
    const emit = (event: object) => events.push(event as BaseEvent);
    const previous = this.previous;
    this.previous = [...next];
    const isLive = (message: Message) =>
      message.role === 'assistant' && message.id.endsWith(':live');
    const begin = (message: Message) => {
      emit({
        type: 'TEXT_MESSAGE_START',
        messageId: message.id,
        role: message.role,
      });
      if (text(message))
        emit({
          type: 'TEXT_MESSAGE_CONTENT',
          messageId: message.id,
          delta: text(message),
        });
    };
    const call = (
      messageId: string,
      item: NonNullable<ReturnType<typeof calls>>[number],
    ) => {
      emit({
        type: 'TOOL_CALL_START',
        toolCallId: item.id,
        toolCallName: item.function.name,
        parentMessageId: messageId,
      });
      if (item.function.arguments)
        emit({
          type: 'TOOL_CALL_ARGS',
          toolCallId: item.id,
          delta: item.function.arguments,
        });
      emit({ type: 'TOOL_CALL_END', toolCallId: item.id });
    };
    const append = (message: Message) => {
      if (message.role === 'tool')
        return emit({
          type: 'TOOL_CALL_RESULT',
          messageId: message.id,
          toolCallId: message.toolCallId,
          content: message.content,
          role: 'tool',
        });
      if (message.role === 'assistant' && isLive(message)) {
        begin(message);
        this.open.add(message.id);
      } else if (text(message)) {
        begin(message);
        emit({ type: 'TEXT_MESSAGE_END', messageId: message.id });
      }
      for (const item of calls(message)) call(message.id, item);
    };
    const snapshot = () => {
      for (const id of this.open)
        emit({ type: 'TEXT_MESSAGE_END', messageId: id });
      this.open.clear();
      // The generation in progress is opened first so later tokens are deltas,
      // then the snapshot replaces the temporary copy it creates.
      for (const message of next)
        if (isLive(message)) {
          begin(message);
          this.open.add(message.id);
        }
      emit({ type: 'MESSAGES_SNAPSHOT', messages: next });
    };
    if (!previous) {
      snapshot();
      return events;
    }
    let shared = 0;
    while (
      shared < previous.length &&
      shared < next.length &&
      sameMessage(previous[shared], next[shared])
    )
      shared++;
    if (shared === previous.length && shared === next.length) return events;
    const rest = previous.slice(shared);
    const grown =
      rest.length > 0 &&
      shared < next.length &&
      this.open.has(rest[0].id) &&
      grows(rest[0], next[shared]) &&
      rest
        .slice(1)
        .every((message, index) =>
          sameMessage(message, next[shared + 1 + index] ?? ({} as Message)),
        );
    if (rest.length && !grown) {
      snapshot();
      return events;
    }
    let from = shared;
    if (grown) {
      const before = previous[shared];
      const after = next[shared];
      const delta = text(after).slice(text(before).length);
      if (delta)
        emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: after.id, delta });
      for (const item of calls(after).slice(calls(before).length))
        call(after.id, item);
      from = shared + rest.length;
    } else from = previous.length;
    // A user's message is not generation output: it reaches clients in a
    // snapshot, which replaces any local copy instead of duplicating it.
    const added = next.slice(from);
    for (const message of added) if (message.role !== 'user') append(message);
    if (added.some((message) => message.role === 'user'))
      emit({ type: 'MESSAGES_SNAPSHOT', messages: next });
    return events;
  }
}

/** One connection's encoder: a snapshot first, then messages and state deltas. */
export class AgUiViewStream {
  private messages = new AgUiMessageStream();
  private state?: unknown;
  /**
   * `frames` ends each batch with a `factory.frame` marker, for observers that
   * publish consistent views. A run stream has its own lifecycle and omits it.
   */
  constructor(
    private threadId: string,
    private runId: string,
    private options: { protocolVersion?: string; frames?: boolean } = {},
  ) {}
  encode(view: AgUiView<object>): BaseEvent[] {
    const events: BaseEvent[] = [];
    const first = this.state === undefined;
    if (first)
      events.push({
        type: 'RUN_STARTED',
        threadId: this.threadId,
        runId: this.runId,
        ...(this.options.protocolVersion
          ? { protocolVersion: this.options.protocolVersion }
          : {}),
      } as BaseEvent);
    events.push(...this.messages.update(view.messages));
    if (first)
      events.push({
        type: 'STATE_SNAPSHOT',
        snapshot: view.state,
      } as BaseEvent);
    else {
      const delta = diffState(this.state, view.state);
      if (delta.length)
        events.push({ type: 'STATE_DELTA', delta } as BaseEvent);
    }
    this.state = view.state;
    if (this.options.frames ?? true)
      events.push({
        type: 'CUSTOM',
        name: FRAME_EVENT,
        value: { type: first ? 'snapshot' : 'update' },
      } as BaseEvent);
    return events;
  }
  finish() {
    return this.messages.finish();
  }
}

// ---------------------------------------------------------------------------
// Views: client side

const unsupported = () =>
  new ApiError('UNSUPPORTED_VERSION', 'Unsupported factory AG-UI view.', 409);
function factoryState<K extends string>(state: unknown, kind: K) {
  const factory = (state as { factory?: Json } | undefined)?.factory;
  if (
    !factory ||
    factory.schemaVersion !== FACTORY_AG_UI_VERSION ||
    factory.kind !== kind ||
    factory.apiVersion !== API_VERSION
  )
    throw unsupported();
  return factory;
}

const textOf = (message: Message) =>
  typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('\n')
      : '';

/** Rebuilds transcript entries from messages and their metadata. */
export function entriesFromAgUi(
  messages: readonly Message[],
  metas: Record<string, EntryMeta>,
  order: readonly string[] = Object.keys(metas),
): Map<string, TranscriptEntry> {
  const entries = new Map<string, TranscriptEntry>();
  const aliases = new Map<string, string>();
  for (const key of order) {
    const meta = metas[key];
    if (!meta) continue;
    entries.set(key, {
      id: meta.id,
      kind: meta.kind,
      text: meta.text ?? '',
      tools: [],
      ...(meta.at === undefined ? {} : { at: meta.at }),
      ...(meta.interrupted ? { interrupted: true } : {}),
      ...(meta.textArtifact ? { textArtifact: meta.textArtifact } : {}),
      ...(meta.messageId ? { messageId: meta.messageId } : {}),
    });
    if (meta.messageId) aliases.set(meta.messageId, key);
  }
  const toolView = (
    key: string,
    id: string,
    fallback: Partial<ToolView>,
  ): ToolView => {
    const meta = metas[key]?.tools?.[id];
    return {
      id,
      name: meta?.name ?? fallback.name ?? 'tool',
      ...(fallback.arguments !== undefined && !meta?.noArguments
        ? { arguments: fallback.arguments }
        : meta?.arguments !== undefined
          ? { arguments: meta.arguments }
          : {}),
      ...(fallback.output ? { output: fallback.output } : {}),
      status: meta?.status ?? fallback.status ?? 'pending',
      ...(meta?.artifact ? { artifact: meta.artifact } : {}),
      ...(meta?.truncated ? { truncated: true } : {}),
    };
  };
  for (const message of messages) {
    const key =
      aliases.get(message.id) ??
      /^(.+?:entry:\d+)(?::|$)/.exec(message.id)?.[1];
    const entry = key ? entries.get(key) : undefined;
    if (!key || !entry) continue;
    if (message.role === 'tool') {
      const id = message.toolCallId.slice(key.indexOf(':entry:') + 1);
      entry.tools.push(
        toolView(key, id, {
          output: textOf(message),
          status: message.error ? 'failed' : 'completed',
        }),
      );
    } else if (message.role === 'user' || message.role === 'assistant') {
      entry.text = textOf(message);
      if (message.role === 'assistant')
        for (const item of message.toolCalls ?? []) {
          entry.tools.push(
            toolView(key, item.id.slice(key.indexOf(':entry:') + 1), {
              name: item.function.name,
              arguments: item.function.arguments,
            }),
          );
        }
    }
  }
  return entries;
}

export function conversationFromAgUi(
  messages: readonly Message[],
  state: unknown,
): ConversationSnapshot {
  const factory = factoryState(
    state,
    'conversation',
  ) as unknown as ConversationState;
  const entries = [...entriesFromAgUi(messages, factory.entries).values()].sort(
    (a, b) => Number(a.id) - Number(b.id),
  );
  const live = messages.find(
    (message) => message.id === liveId(factory.conversation.id),
  );
  return {
    conversation: factory.conversation,
    ...(factory.workflow ? { workflow: factory.workflow } : {}),
    ...(factory.planning ? { planning: factory.planning } : {}),
    entries,
    partial: live ? textOf(live) : '',
    tools: factory.tools,
    submissions: factory.submissions,
    execution: factory.execution,
    ...(factory.olderCursor ? { olderCursor: factory.olderCursor } : {}),
  };
}

export function activityFromAgUi(
  messages: readonly Message[],
  state: unknown,
): RunActivityPage {
  const factory = factoryState(state, 'activity') as unknown as ActivityState;
  const entries = entriesFromAgUi(messages, factory.entries);
  const revive = ({
    entryKey: key,
    ...item
  }: ActivityItemState): RunActivityItem => {
    const entry = key ? entries.get(key) : undefined;
    return entry ? { ...item, entry } : item;
  };
  return {
    ...(factory.conversation ? { conversation: factory.conversation } : {}),
    items: factory.items.map(revive),
    ...(factory.updates ? { updates: factory.updates.map(revive) } : {}),
    ...(factory.cursor ? { cursor: factory.cursor } : {}),
    live: factory.live.map((source) => ({
      ...source,
      partial: textOf(
        messages.find((m) => m.id === liveId(source.conversationId)) ??
          ({ content: '' } as Message),
      ),
    })),
  };
}

export function historyFromAgUi(
  messages: readonly Message[],
  state: unknown,
): { entries: TranscriptEntry[]; cursor?: string } {
  const factory = factoryState(state, 'history') as unknown as HistoryState;
  const entries = entriesFromAgUi(messages, factory.entries, factory.order);
  return {
    entries: factory.order.flatMap((key) =>
      entries.has(key) ? [entries.get(key)!] : [],
    ),
    ...(factory.cursor ? { cursor: factory.cursor } : {}),
  };
}

/** Reads the message and state snapshots of a one-shot AG-UI view. */
export function viewFromEvents(events: readonly BaseEvent[]) {
  const messages = events.find(
    (event) => event.type === 'MESSAGES_SNAPSHOT',
  ) as { messages: Message[] } | undefined;
  const state = events.find((event) => event.type === 'STATE_SNAPSHOT') as
    | { snapshot: unknown }
    | undefined;
  if (!messages || !state) throw unsupported();
  return { messages: messages.messages, state: state.snapshot };
}

// ---------------------------------------------------------------------------
// Client: observing a view with the AG-UI SDK

/** A passive AG-UI agent: it joins a thread's stream instead of starting a run. */
class ObserverAgent extends HttpAgent {
  protected override connect(): ReturnType<HttpAgent['run']> {
    return transformHttpEventStream(
      runHttpRequest(() =>
        this.fetch(this.url, {
          method: 'GET',
          headers: { Accept: 'text/event-stream', ...this.headers },
          signal: this.abortController.signal,
        }),
      ),
    );
  }
}

export interface ObserveOptions<T> {
  url: string;
  threadId: string;
  fetcher: typeof fetch;
  project: (messages: readonly Message[], state: unknown) => T;
  onView: (
    view: T,
    frame: {
      type: 'snapshot' | 'update';
      streamId: string;
      signal: AbortSignal;
    },
  ) => unknown;
  onConnection: (state: ConnectionState) => void;
  onError: (error: Error) => void;
}

/** Keeps an observer connected: watchdog, jittered backoff, fresh snapshots. */
/** A throwing UI callback must not end the observer's reconnect loop. */
const safely = (callback: () => void) => {
  try {
    callback();
  } catch {
    /* The caller's own error handling is its responsibility. */
  }
};

export function observeAgUi<T>(options: ObserveOptions<T>) {
  const lifetime = new AbortController();
  let active: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  void (async () => {
    let retries = 0;
    while (!lifetime.signal.aborted) {
      safely(() =>
        options.onConnection(retries ? 'disconnected' : 'connecting'),
      );
      const attempt = (active = new AbortController());
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => attempt.abort(), 45000);
      };
      const streamId = crypto.randomUUID();
      let failure: unknown;
      try {
        touch();
        const agent = new ObserverAgent({
          url: options.url,
          threadId: options.threadId,
          // Every chunk, heartbeats included, proves the connection is alive.
          fetch: async (url, init) => {
            const response = await options.fetcher.call(globalThis, url, {
              ...init,
              signal: attempt.signal,
            });
            if (!response.ok)
              throw await responseError(response, 'Could not connect.');
            if (!response.body) throw new Error('Streaming is unavailable.');
            return new Response(
              response.body.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  start(controller) {
                    if (attempt.signal.aborted)
                      controller.error(new Error('Disconnected.'));
                    attempt.signal.addEventListener(
                      'abort',
                      () => controller.error(new Error('Disconnected.')),
                      { once: true },
                    );
                  },
                  transform(chunk, controller) {
                    touch();
                    controller.enqueue(chunk);
                  },
                }),
              ),
              response,
            );
          },
        });
        attempt.signal.addEventListener('abort', () => agent.abortRun(), {
          once: true,
        });
        let first = true;
        const subscriber: AgentSubscriber = {
          onRunFailed: ({ error }) => {
            failure ??= error;
          },
          onRunErrorEvent: ({ event }) => {
            failure ??= new Error(event.message);
          },
          onCustomEvent: async ({ event, messages, state }) => {
            if (event.name !== FRAME_EVENT) return;
            // The SDK logs and swallows subscriber errors; end the attempt so
            // the failure decides between retrying and stopping.
            try {
              const view = options.project(messages, state);
              const type = first ? 'snapshot' : 'update';
              first = false;
              retries = 0;
              options.onConnection('connected');
              await options.onView(view, {
                type,
                streamId,
                signal: attempt.signal,
              });
            } catch (error) {
              failure ??= error;
              attempt.abort();
            }
          },
        };
        // An abort ends the attempt even if the SDK is slow to notice.
        await Promise.race([
          agent.connectAgent({ runId: streamId }, subscriber),
          new Promise<void>((resolve) =>
            attempt.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          ),
        ]);
      } catch (error) {
        failure ??= error;
      } finally {
        clearTimeout(timer);
        attempt.abort();
      }
      if (lifetime.signal.aborted) break;
      safely(() => options.onConnection('disconnected'));
      const error =
        failure instanceof ApiError ? failure : unwrapError(failure);
      if (error instanceof ApiError) {
        safely(() => options.onError(error));
        if (
          [
            'AUTHENTICATION',
            'NOT_FOUND',
            'UNSUPPORTED_VERSION',
            'FORBIDDEN',
          ].includes(error.code)
        )
          break;
      }
      const wait =
        Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)) *
        (0.75 + Math.random() * 0.25);
      await new Promise<void>((resolve) => {
        wake = resolve;
        retryTimer = setTimeout(resolve, wait);
      });
    }
  })();
  return () => {
    lifetime.abort();
    active?.abort();
    clearTimeout(timer);
    clearTimeout(retryTimer);
    wake?.();
  };
}

/** The SDK may wrap a transport failure; look for the service's own error. */
export function unwrapError(error: unknown): unknown {
  for (let value = error, depth = 0; value && depth < 4; depth++) {
    if (value instanceof ApiError) return value;
    value = (value as { cause?: unknown }).cause;
  }
  return error;
}
