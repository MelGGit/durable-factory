import { FactoryClient, type Role } from './core.js';
import type { AgUiEvent } from './ag-ui.js';
import { activityFromAgUi, observeAgUi, viewFromEvents } from './ag-ui-view.js';
import type {
  ConversationSnapshot,
  TranscriptEntry,
  ToolView,
} from './chat.js';

export interface RunActivityItem {
  id: string;
  at?: number;
  actor: 'code' | 'human' | 'development' | 'review';
  title: string;
  detail?: string;
  conversationId?: string;
  attemptId?: string;
  entry?: TranscriptEntry;
  command?: {
    id: string;
    state: string;
    exitCode?: number;
    finishedAt?: number;
  };
}
export interface RunActivityPage {
  conversation?: Pick<
    ConversationSnapshot,
    'conversation' | 'workflow' | 'submissions' | 'execution'
  >;
  items: RunActivityItem[];
  updates?: RunActivityItem[];
  cursor?: string;
  live: {
    conversationId: string;
    role: Role;
    partial: string;
    tools: ToolView[];
  }[];
}
/** A projection of the run timeline. The wire carries it as AG-UI messages and
 * state; see `ag-ui-view.ts`. */
export interface RunActivityFrame {
  apiVersion: string;
  streamId: string;
  sequence: number;
  type: 'snapshot' | 'update';
  snapshot: RunActivityPage;
}
export function mergeActivity(...pages: RunActivityItem[][]) {
  return [
    ...new Map(pages.flat().map((item) => [item.id, item])).values(),
  ].sort(
    (a, b) =>
      (a.at ?? 0) - (b.at ?? 0) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
}
export class RunActivityClient extends FactoryClient {
  async activity(
    id: string,
    cursor?: string,
    limit = 50,
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const response = await this.request<{ events: AgUiEvent[] }>(
      `/runs/${encodeURIComponent(id)}/activity/ag-ui?${query}`,
      { signal },
    );
    const view = viewFromEvents(response.events);
    return activityFromAgUi(view.messages, view.state);
  }
  /** Observes the run timeline as a standard AG-UI stream. */
  watch(
    id: string,
    onPage: (
      page: RunActivityPage,
      frame: Pick<RunActivityFrame, 'type' | 'streamId'>,
      signal: AbortSignal,
    ) => unknown,
    onConnection: (connected: boolean) => void,
    onError: (error: Error) => void = () => {},
  ) {
    return observeAgUi({
      url: `${this.baseUrl}/api/v1/runs/${encodeURIComponent(id)}/activity/ag-ui/events`,
      threadId: id,
      fetcher: this.fetcher,
      project: activityFromAgUi,
      onView: (page, frame) => onPage(page, frame, frame.signal),
      onConnection: (state) => {
        if (state !== 'connecting') onConnection(state === 'connected');
      },
      onError,
    });
  }
}
