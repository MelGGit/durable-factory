import type { BaseEvent, Message } from '@ag-ui/core';
import type {
  ConversationSnapshot,
  TranscriptEntry,
  ToolView,
} from './chat.js';
import { conversationState, diffState } from './ag-ui-view.js';

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
