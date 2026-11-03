import type { BaseEvent, Message } from '@ag-ui/core';
import type {
  ConversationSnapshot,
  TranscriptEntry,
  ToolView,
  TranscriptPart,
} from './chat.js';
import { conversationState, diffState } from './ag-ui-view.js';

export type {
  BaseEvent as AgUiEvent,
  Message as AgUiMessage,
} from '@ag-ui/core';
export const AG_UI_VERSION = '1.0' as const;
export const FACTORY_AG_UI_VERSION = 1 as const;

/** Text lives in native messages; state carries only ordering and UI metadata. */
export type PartMeta =
  | Omit<Extract<TranscriptPart, { text: string }>, 'text'>
  | Extract<TranscriptPart, { type: 'tool' }>;
export const partsMeta = (parts: readonly TranscriptPart[]): PartMeta[] =>
  parts.map((part) => {
    if (part.type === 'tool') return part;
    const { text: _text, ...meta } = part;
    return meta;
  });
export function partMessages(
  threadId: string,
  base: string,
  parts: readonly TranscriptPart[],
  tools: readonly ToolView[],
): Message[] {
  return parts.flatMap((part, index): Message[] => {
    const id = `${base}:part:${index}`;
    if (part.type !== 'tool')
      return [
        {
          id,
          role: part.type === 'thinking' ? 'reasoning' : 'assistant',
          content: part.text,
        },
      ];
    const tool = tools.find((tool) => tool.id === part.toolId);
    return tool
      ? [
          {
            id,
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: `${threadId}:${tool.id}`,
                type: 'function',
                function: {
                  name: tool.name,
                  arguments: tool.arguments ?? '{}',
                },
              },
            ],
          },
        ]
      : [];
  });
}
export function partsFromMessages(
  base: string,
  parts: readonly PartMeta[],
  messages: readonly Message[],
): TranscriptPart[] {
  return parts.map((part, index) =>
    part.type === 'tool'
      ? part
      : {
          ...part,
          text: String(
            messages.find((message) => message.id === `${base}:part:${index}`)
              ?.content ?? '',
          ),
        },
  );
}

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
    } else if (entry.parts?.length) {
      messages.push(...partMessages(threadId, id, entry.parts, entry.tools));
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
