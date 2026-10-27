import type { DeletionOperation } from './deletion.js';
import type { PlanningState } from './planning.js';
import { AgUiViewReducer, type AgUiEvent } from './ag-ui.js';
import {
  API_VERSION,
  ApiError,
  FactoryClient,
  responseError,
  type Role,
  type RoleSettings,
} from './core.js';

export type SubmissionState =
  | 'acknowledged'
  | 'queued'
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'withdrawn';
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
export interface ConversationSummary {
  runId?: string;
  id: string;
  title: string;
  role: Role;
  repository: { path: string; github: string; baseBranch?: string };
  createdAt: string;
  model: RoleSettings;
}
export interface ChatSubmission {
  id: string;
  requestId: string;
  content: string;
  mode: 'followUp' | 'steer';
  status: SubmissionState;
  reason?: string;
}
export interface ToolView {
  id: string;
  name: string;
  arguments?: string;
  output?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  artifact?: string;
  truncated?: boolean;
}
export interface TranscriptEntry {
  /** Original AG-UI user identity, when this entry was admitted through AG-UI. */
  messageId?: string;
  at?: number;
  id: string;
  kind: string;
  text: string;
  interrupted?: boolean;
  textArtifact?: string;
  tools: ToolView[];
}
export interface ConversationSnapshot {
  workflow?: {
    runId: string;
    status: string;
    stage: string;
    acceptsInput: boolean;
  };
  conversation: ConversationSummary;
  planning?: PlanningState;
  entries: TranscriptEntry[];
  partial: string;
  tools: ToolView[];
  submissions: ChatSubmission[];
  execution: 'idle' | 'running' | 'interrupting';
  olderCursor?: string;
}
export interface ChatFrame {
  apiVersion: typeof API_VERSION;
  streamId: string;
  sequence: number;
  type: 'snapshot' | 'update';
  snapshot: ConversationSnapshot;
}
export interface HistoryPage {
  entries: TranscriptEntry[];
  cursor?: string;
}
export const roleCapabilities = (role: Role) => ({
  followUp: role !== 'review',
  steer: role === 'development',
  interrupt: role !== 'review',
});
export function mergeEntries(
  older: TranscriptEntry[],
  newer: TranscriptEntry[],
) {
  const entries = [
    ...new Map([...older, ...newer].map((entry) => [entry.id, entry])).values(),
  ].sort((a, b) => Number(a.id) - Number(b.id));
  const results = new Map(
    entries
      .flatMap((entry) => entry.tools)
      .filter((tool) => tool.status === 'completed' || tool.status === 'failed')
      .map((tool) => [tool.id, tool.status]),
  );
  return entries.map((entry) => ({
    ...entry,
    tools: entry.tools.map((tool) =>
      tool.status === 'pending' && results.has(tool.id)
        ? { ...tool, status: results.get(tool.id)! }
        : tool,
    ),
  }));
}

export class ChatReducer {
  streamId = '';
  sequence = 0;
  snapshot?: ConversationSnapshot;
  apply(frame: ChatFrame) {
    if (frame.apiVersion !== API_VERSION)
      throw new ApiError(
        'UNSUPPORTED_VERSION',
        'The app and service versions do not match.',
        409,
      );
    if (frame.type === 'snapshot') {
      if (frame.streamId === this.streamId && frame.sequence <= this.sequence)
        return false;
      this.streamId = frame.streamId;
      this.sequence = frame.sequence;
      this.snapshot = frame.snapshot;
      return true;
    }
    if (frame.streamId !== this.streamId)
      throw new Error('A fresh snapshot is required.');
    if (frame.sequence <= this.sequence) return false;
    if (frame.sequence !== this.sequence + 1)
      throw new Error('A stream update was missed.');
    this.sequence = frame.sequence;
    this.snapshot = frame.snapshot;
    return true;
  }
}
export class ChatClient extends FactoryClient {
  protected agUi = false;
  deleteConversation(id: string) {
    return this.mutation<DeletionOperation>(
      `/conversations/${encodeURIComponent(id)}`,
      'DELETE',
      {},
    );
  }
  deleteRun(id: string) {
    return this.mutation<DeletionOperation>(
      `/runs/${encodeURIComponent(id)}`,
      'DELETE',
      {},
    );
  }
  deletions() {
    return this.request<{ operations: DeletionOperation[] }>('/deletions');
  }
  deletion(id: string) {
    return this.request<DeletionOperation>(
      `/deletions/${encodeURIComponent(id)}`,
    );
  }
  conversations() {
    return this.request<{ conversations: ConversationSummary[] }>(
      '/conversations',
    );
  }
  retryIssue(id: string) {
    return this.mutation<PlanningState>(
      `/conversations/${id}/issue/retry`,
      'POST',
      {},
    );
  }
  createConversation(title: string, requestId: string) {
    return this.mutation<ConversationSummary>('/conversations', 'POST', {
      title,
      requestId,
    });
  }
  async history(id: string, cursor?: string, signal?: AbortSignal) {
    const response = await this.request<HistoryPage | { events: AgUiEvent[] }>(
      `/conversations/${encodeURIComponent(id)}/${this.agUi ? 'ag-ui/' : ''}history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      { signal },
    );
    if (!this.agUi) return response as HistoryPage;
    const state = (
      response as {
        events: (AgUiEvent & {
          snapshot?: {
            factory?: HistoryPage & { schemaVersion: number; kind: string };
          };
        })[];
      }
    ).events.find((event) => event.type === 'STATE_SNAPSHOT')?.snapshot
      ?.factory;
    if (!state || state.schemaVersion !== 1 || state.kind !== 'history')
      throw new ApiError(
        'UNSUPPORTED_VERSION',
        'Unsupported AG-UI history.',
        409,
      );
    return {
      entries: state.entries,
      ...(state.cursor ? { cursor: state.cursor } : {}),
    };
  }
  submit(
    id: string,
    content: string,
    requestId: string,
    mode: 'followUp' | 'steer' = 'followUp',
  ) {
    return this.mutation<ChatSubmission>(
      `/conversations/${encodeURIComponent(id)}/submissions`,
      'POST',
      { content, requestId, mode },
    );
  }
  submission(id: string, requestId: string) {
    return this.request<ChatSubmission>(
      `/conversations/${encodeURIComponent(id)}/submissions?requestId=${encodeURIComponent(requestId)}`,
    );
  }
  withdraw(id: string, submissionId: string) {
    return this.mutation<ChatSubmission>(
      `/conversations/${encodeURIComponent(id)}/submissions/${encodeURIComponent(submissionId)}/withdraw`,
      'POST',
      {},
    );
  }
  interrupt(id: string) {
    return this.mutation<{ status: string }>(
      `/conversations/${encodeURIComponent(id)}/interrupt`,
      'POST',
      {},
    );
  }
  artifact(id: string, artifact: string, offset = 0) {
    return this.request<{ text: string; nextOffset?: number }>(
      `/conversations/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifact)}?offset=${offset}`,
    );
  }
  watch(
    id: string,
    onSnapshot: (
      value: ConversationSnapshot,
      frame: Pick<ChatFrame, 'type' | 'streamId'> & { signal: AbortSignal },
    ) => unknown,
    onConnection: (state: ConnectionState) => void,
    onError: (error: Error) => void = () => {},
  ) {
    const lifetime = new AbortController();
    let active: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    void (async () => {
      let retries = 0;
      while (!lifetime.signal.aborted) {
        onConnection(retries ? 'disconnected' : 'connecting');
        active = new AbortController();
        const resetTimeout = () => {
          clearTimeout(timer);
          timer = setTimeout(() => active?.abort(), 45000);
        };
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          resetTimeout();
          const response = await this.fetcher.call(
            globalThis,
            `${this.baseUrl}/api/v1/conversations/${encodeURIComponent(id)}/${this.agUi ? 'ag-ui/' : ''}events`,
            { signal: active.signal },
          );
          if (!response.ok)
            throw await responseError(response, 'Could not connect.');
          if (!response.body) throw new Error('Streaming is unavailable.');
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          const reducer = new ChatReducer();
          const agUiReducer = new AgUiViewReducer();
          let buffer = '';
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('Stream closed.');
            resetTimeout();
            buffer += decoder.decode(chunk.value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');
            if (buffer.length > 2 * 1024 * 1024)
              throw new Error('Stream frame is too large.');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = event
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (!data) continue;
              const parsed = JSON.parse(data);
              const frame = this.agUi
                ? agUiReducer.apply(parsed, 'conversation')
                : (parsed as ChatFrame);
              if (!frame) continue;
              if (reducer.apply(frame)) {
                retries = 0;
                onConnection('connected');
                await onSnapshot(reducer.snapshot!, {
                  ...frame,
                  signal: active.signal,
                });
              }
            }
          }
        } catch (error) {
          if (lifetime.signal.aborted) break;
          onConnection('disconnected');
          if (error instanceof ApiError) {
            onError(error);
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
        } finally {
          clearTimeout(timer);
          active.abort();
          await reader?.cancel().catch(() => {});
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
}

/** Uses standard AG-UI events for passive views and factory APIs for durable controls. */
export class AgUiChatClient extends ChatClient {
  protected override agUi = true;
}
