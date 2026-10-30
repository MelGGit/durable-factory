import type { DeletionOperation } from './deletion.js';
import type { PlanningState } from './planning.js';
import { HttpAgent } from '@ag-ui/client';
import {
  conversationFromAgUi,
  historyFromAgUi,
  observeAgUi,
  unwrapError,
  viewFromEvents,
} from './ag-ui-view.js';
import type { AgUiEvent } from './ag-ui.js';
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
  projectId: string;
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
/** A projection of the conversation, as the service observes it. The wire
 * carries this as AG-UI messages and state; see `ag-ui-view.ts`. */
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

export class ChatClient extends FactoryClient {
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
  planIssue(issueNumber: number, requestId: string) {
    return this.mutation<ConversationSummary>(
      `/issues/${issueNumber}/planning`,
      'POST',
      { requestId },
    );
  }
  createConversation(title: string, requestId: string) {
    return this.mutation<ConversationSummary>('/conversations', 'POST', {
      title,
      requestId,
    });
  }
  async history(id: string, cursor?: string, signal?: AbortSignal) {
    const response = await this.request<{ events: AgUiEvent[] }>(
      `/conversations/${encodeURIComponent(id)}/ag-ui/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      { signal },
    );
    const view = viewFromEvents(response.events);
    return historyFromAgUi(view.messages, view.state);
  }
  /**
   * Sends text through the standard AG-UI run endpoint and resolves once the
   * service has durably admitted it. `messageId` makes a retry idempotent: the
   * same ID with the same text reuses the earlier admission. The run's own
   * stream is detached here; `watch` shows the conversation.
   */
  async send(conversationId: string, content: string, messageId: string) {
    const attempt = async () => {
      const csrf = await this.csrf();
      const agent = new HttpAgent({
        url: `${this.baseUrl}/api/v1/ag-ui/run`,
        threadId: conversationId,
        headers: { 'X-Factory-CSRF': csrf },
        fetch: async (url, init) => {
          const response = await this.fetcher.call(globalThis, url, init);
          if (!response.ok)
            throw await responseError(
              response,
              'The service could not complete the request.',
            );
          return response;
        },
        initialMessages: [{ id: messageId, role: 'user', content }],
      });
      await new Promise<void>((resolve, reject) => {
        let admitted = false;
        const fail = (error: unknown) => {
          if (!admitted) reject(unwrapError(error));
        };
        agent
          .runAgent(
            { runId: crypto.randomUUID() },
            {
              onRunStartedEvent: () => {
                admitted = true;
                resolve();
                agent.abortRun();
              },
              onRunFailed: ({ error }) => fail(error),
              onRunErrorEvent: ({ event }) => fail(new Error(event.message)),
            },
          )
          .then(
            () => fail(new Error('The run ended before it was admitted.')),
            fail,
          );
      });
    };
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'FORBIDDEN')
        throw error;
      await this.connect();
      return attempt();
    }
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
  /** Observes a conversation as a standard AG-UI stream. Every (re)connection
   * delivers a fresh `snapshot` frame, then `update` frames. */
  watch(
    id: string,
    onSnapshot: (
      value: ConversationSnapshot,
      frame: Pick<ChatFrame, 'type' | 'streamId'> & { signal: AbortSignal },
    ) => unknown,
    onConnection: (state: ConnectionState) => void,
    onError: (error: Error) => void = () => {},
  ) {
    return observeAgUi({
      url: `${this.baseUrl}/api/v1/conversations/${encodeURIComponent(id)}/ag-ui/events`,
      threadId: id,
      fetcher: this.fetcher,
      project: conversationFromAgUi,
      onView: onSnapshot,
      onConnection,
      onError,
    });
  }
}
