import type { BaseEvent, Message } from '@ag-ui/core';
import { ApiError, API_VERSION } from './core.js';
import type {
  ChatFrame,
  ConversationSnapshot,
  TranscriptEntry,
  ToolView,
} from './chat.js';
import type { RunActivityFrame } from './activity.js';

export type {
  BaseEvent as AgUiEvent,
  Message as AgUiMessage,
} from '@ag-ui/core';
export const AG_UI_VERSION = '1.0' as const;
export const FACTORY_AG_UI_VERSION = 1 as const;

/** Stable projection shared by the standard endpoint and passive factory views. */
export function agUiMessages(
  threadId: string,
  entries: readonly TranscriptEntry[],
): Message[] {
  const messages: Message[] = [];
  for (const entry of entries) {
    const id = `${threadId}:entry:${entry.id}`;
    if (entry.kind === 'pi.tool-result') {
      for (const tool of entry.tools)
        messages.push({
          id: `${id}:result:${tool.id}`,
          role: 'tool',
          toolCallId: `${threadId}:${tool.id}`,
          content: tool.output ?? '',
          ...(tool.status === 'failed' ? { error: 'Tool failed' } : {}),
        });
    } else if (entry.text || entry.tools.length) {
      if (entry.kind === 'pi.user')
        messages.push({
          id: entry.messageId ?? id,
          role: 'user',
          content: entry.text,
        });
      else
        messages.push({
          id,
          role: 'assistant',
          content: entry.text,
          ...(entry.tools.length
            ? {
                toolCalls: entry.tools.map((tool) => ({
                  id: `${threadId}:${tool.id}`,
                  type: 'function' as const,
                  function: {
                    name: tool.name,
                    arguments: tool.arguments ?? '{}',
                  },
                })),
              }
            : {}),
        });
    }
  }
  return messages;
}

export function agUiConversationMessages(
  snapshot: ConversationSnapshot,
): Message[] {
  return agUiMessages(snapshot.conversation.id, snapshot.entries);
}

type FactoryFrame = ChatFrame | RunActivityFrame;
export function agUiViewEvents(
  frame: FactoryFrame,
  kind: 'conversation' | 'activity',
): BaseEvent[] {
  const messages =
    kind === 'conversation'
      ? agUiConversationMessages((frame as ChatFrame).snapshot)
      : (frame as RunActivityFrame).snapshot.items.flatMap((item) =>
          item.entry ? agUiMessages(item.conversationId!, [item.entry]) : [],
        );
  return [
    { type: 'MESSAGES_SNAPSHOT', messages } as BaseEvent,
    {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        factory: { schemaVersion: FACTORY_AG_UI_VERSION, kind, ...frame },
      },
    } as BaseEvent,
  ];
}

/** Passive observation is a factory extension, not an AG-UI run transport. */
export class AgUiViewReducer {
  private streamId = '';
  private sequence = 0;
  apply(event: BaseEvent, kind: 'conversation'): ChatFrame | undefined;
  apply(event: BaseEvent, kind: 'activity'): RunActivityFrame | undefined;
  apply(
    event: BaseEvent,
    kind: 'conversation' | 'activity',
  ): FactoryFrame | undefined {
    if (event.type !== 'STATE_SNAPSHOT') return;
    const factory = (
      event as BaseEvent & {
        snapshot?: {
          factory?: FactoryFrame & { schemaVersion: number; kind: string };
        };
      }
    ).snapshot?.factory;
    if (
      !factory ||
      factory.schemaVersion !== FACTORY_AG_UI_VERSION ||
      factory.kind !== kind ||
      factory.apiVersion !== API_VERSION
    )
      throw new ApiError(
        'UNSUPPORTED_VERSION',
        'Unsupported factory AG-UI view.',
        409,
      );
    if (
      !factory.streamId ||
      !Number.isSafeInteger(factory.sequence) ||
      factory.sequence < 1 ||
      !['snapshot', 'update'].includes(factory.type) ||
      !factory.snapshot
    )
      throw new Error('Invalid factory AG-UI frame.');
    if (factory.streamId === this.streamId && factory.sequence <= this.sequence)
      return;
    if (
      factory.type !== 'snapshot' &&
      (factory.streamId !== this.streamId ||
        factory.sequence !== this.sequence + 1)
    )
      throw new Error('A fresh AG-UI snapshot is required.');
    this.streamId = factory.streamId;
    this.sequence = factory.sequence;
    return factory;
  }
}

/** Emits actual text/tool events, with snapshots for authoritative reconciliation. */
export class AgUiConversationEvents {
  private entries = new Map<string, TranscriptEntry>();
  private initialized = false;
  private text = new Map<string, string>();
  private tools = new Map<string, string>();
  private results = new Map<string, string>();
  private liveId?: string;
  private serial = 0;
  private durable = new Set<string>();
  constructor(
    private threadId: string,
    private runId: string,
    history: readonly TranscriptEntry[] = [],
  ) {
    for (const entry of history) {
      this.entries.set(entry.id, entry);
      for (const tool of entry.tools) {
        this.tools.set(tool.id, `${threadId}:${tool.id}`);
        if (entry.kind === 'pi.tool-result') this.results.set(tool.id, tool.id);
      }
    }
    for (const message of agUiMessages(threadId, history))
      if (message.role === 'assistant') this.durable.add(message.id);
  }
  update(
    snapshot: ConversationSnapshot,
    additions: readonly TranscriptEntry[] = snapshot.entries,
  ): BaseEvent[] {
    const events: BaseEvent[] = [];
    const emit = (event: object) => events.push(event as BaseEvent);
    let changed = !this.initialized;
    for (const entry of additions) {
      if (this.entries.has(entry.id)) continue;
      this.entries.set(entry.id, entry);
      changed = true;
    }
    const closeText = () => {
      if (this.liveId)
        emit({ type: 'TEXT_MESSAGE_END', messageId: this.liveId });
      this.liveId = undefined;
      changed = true;
    };
    const entries = [...this.entries.values()].sort(
      (a, b) => Number(a.id) - Number(b.id),
    );
    const messages = agUiMessages(this.threadId, entries);
    const committed = messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.id)
      .join('|');
    // A completed generation acquires its durable entry ID. Close the live slot
    // before the authoritative snapshot replaces it, so clients never keep twins.
    if (
      this.liveId &&
      (this.text.get('$committed') !== committed || !snapshot.partial)
    ) {
      // A committed message replaces its live slot. Send only any final suffix
      // before closing the slot, rather than generating the whole reply twice.
      const partial = this.text.get(this.liveId) ?? '';
      const final = messages.find(
        (message) =>
          message.role === 'assistant' &&
          !this.durable.has(message.id) &&
          message.content?.startsWith(partial),
      );
      if (final?.role === 'assistant' && partial) {
        const delta = final.content!.slice(partial.length);
        if (delta)
          emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: this.liveId, delta });
        this.durable.add(final.id);
      }
      closeText();
    }
    this.text.set('$committed', committed);
    for (const message of messages) {
      if (
        message.role !== 'assistant' ||
        !message.content ||
        this.durable.has(message.id)
      )
        continue;
      emit({
        type: 'TEXT_MESSAGE_START',
        messageId: message.id,
        role: 'assistant',
      });
      emit({
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: message.id,
        delta: message.content,
      });
      emit({ type: 'TEXT_MESSAGE_END', messageId: message.id });
      this.durable.add(message.id);
    }
    if (snapshot.partial) {
      if (!this.liveId) {
        this.liveId = `${this.threadId}:live:${this.runId}:${++this.serial}`;
        emit({
          type: 'TEXT_MESSAGE_START',
          messageId: this.liveId,
          role: 'assistant',
        });
      }
      const previous = this.text.get(this.liveId) ?? '';
      if (!snapshot.partial.startsWith(previous)) {
        closeText();
        this.liveId = `${this.threadId}:live:${this.runId}:${++this.serial}`;
        emit({
          type: 'TEXT_MESSAGE_START',
          messageId: this.liveId,
          role: 'assistant',
        });
      }
      const delta = snapshot.partial.slice(
        this.text.get(this.liveId!)?.length ?? 0,
      );
      if (delta)
        emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: this.liveId, delta });
      this.text.set(this.liveId!, snapshot.partial);
    }
    const toolMap = new Map<string, ToolView>();
    for (const entry of entries)
      for (const tool of entry.tools)
        toolMap.set(tool.id, { ...toolMap.get(tool.id), ...tool });
    for (const tool of snapshot.tools)
      if (!['completed', 'failed'].includes(toolMap.get(tool.id)?.status ?? ''))
        toolMap.set(tool.id, { ...toolMap.get(tool.id), ...tool });
    for (const tool of toolMap.values()) {
      const toolCallId = `${this.threadId}:${tool.id}`;
      if (!this.tools.has(tool.id)) {
        emit({ type: 'TOOL_CALL_START', toolCallId, toolCallName: tool.name });
        if (tool.arguments)
          emit({ type: 'TOOL_CALL_ARGS', toolCallId, delta: tool.arguments });
        emit({ type: 'TOOL_CALL_END', toolCallId });
        this.tools.set(tool.id, toolCallId);
      }
      if (
        ['completed', 'failed'].includes(tool.status) &&
        !this.results.has(tool.id)
      ) {
        const messageId = `${this.threadId}:result:${tool.id}`;
        emit({
          type: 'TOOL_CALL_RESULT',
          toolCallId,
          messageId,
          content: tool.output ?? '',
          role: 'tool',
        });
        this.results.set(tool.id, messageId);
      }
    }
    // Keep the open live message in the snapshot too; a standard client replaces
    // its message store on snapshots and must not lose the generation in progress.
    if (this.liveId)
      messages.push({
        id: this.liveId,
        role: 'assistant',
        content: snapshot.partial,
      });
    // Replacement snapshots must include the entire transcript, not just the
    // service's bounded observation window. Token deltas need no replacement.
    if (changed) emit({ type: 'MESSAGES_SNAPSHOT', messages });
    this.initialized = true;
    emit({
      type: 'STATE_SNAPSHOT',
      snapshot: {
        factory: {
          schemaVersion: FACTORY_AG_UI_VERSION,
          kind: 'conversation',
          snapshot,
        },
      },
    });
    return events;
  }
  finish(): BaseEvent[] {
    if (!this.liveId) return [];
    const event = {
      type: 'TEXT_MESSAGE_END',
      messageId: this.liveId,
    } as BaseEvent;
    this.liveId = undefined;
    return [event];
  }
}
