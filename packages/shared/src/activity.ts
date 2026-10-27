import { API_VERSION, ApiError, FactoryClient, type Role } from './core.js';
import { AgUiViewReducer, type AgUiEvent } from './ag-ui.js';
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
export interface RunActivityFrame {
  apiVersion: typeof API_VERSION;
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
  protected agUi = false;
  async activity(
    id: string,
    cursor?: string,
    limit = 50,
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const response = await this.request<
      RunActivityPage | { events: AgUiEvent[] }
    >(
      `/runs/${encodeURIComponent(id)}/activity${this.agUi ? '/ag-ui' : ''}?${query}`,
      { signal },
    );
    if (!this.agUi) return response as RunActivityPage;
    const reducer = new AgUiViewReducer();
    for (const event of (response as { events: AgUiEvent[] }).events) {
      const frame = reducer.apply(event, 'activity');
      if (frame) return frame.snapshot;
    }
    throw new Error('Missing AG-UI activity snapshot.');
  }
  watch(
    id: string,
    onPage: (
      page: RunActivityPage,
      frame: RunActivityFrame,
      signal: AbortSignal,
    ) => unknown,
    onConnection: (connected: boolean) => void,
    onError: (error: Error) => void = () => {},
  ) {
    const lifetime = new AbortController();
    let active: AbortController | undefined,
      watchdog: ReturnType<typeof setTimeout> | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      wake: (() => void) | undefined;
    void (async () => {
      let retries = 0;
      while (!lifetime.signal.aborted) {
        active = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const touch = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => active?.abort(), 45000);
        };
        try {
          touch();
          const response = await this.fetcher.call(
            globalThis,
            `${this.baseUrl}/api/v1/runs/${encodeURIComponent(id)}/activity/${this.agUi ? 'ag-ui/' : ''}events`,
            { signal: active.signal },
          );
          if (!response.ok) {
            const body = await response.json();
            throw new ApiError(
              body.error?.code ?? 'INTERNAL',
              body.error?.message ?? 'Activity stream unavailable.',
              response.status,
            );
          }
          reader = response.body!.getReader();
          let buffer = '',
            streamId = '',
            sequence = 0;
          const agUiReducer = new AgUiViewReducer();
          const decoder = new TextDecoder();
          while (!active.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('Activity stream closed.');
            touch();
            buffer += decoder.decode(chunk.value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');
            if (buffer.length > 2 * 1024 * 1024)
              throw new Error('Activity frame too large.');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (event.startsWith('event: heartbeat')) continue;
              const data = event
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (!data) continue;
              const parsed = JSON.parse(data);
              const frame = this.agUi
                ? agUiReducer.apply(parsed, 'activity')
                : (parsed as RunActivityFrame);
              if (!frame) continue;
              if (frame.apiVersion !== API_VERSION)
                throw new ApiError(
                  'UNSUPPORTED_VERSION',
                  'Reload to use the activity stream.',
                  409,
                );
              if (frame.streamId === streamId && frame.sequence <= sequence)
                continue;
              if (
                frame.type !== 'snapshot' &&
                (frame.streamId !== streamId || frame.sequence !== sequence + 1)
              )
                throw new Error('Activity stream gap.');
              streamId = frame.streamId;
              sequence = frame.sequence;
              retries = 0;
              onConnection(true);
              await onPage(frame.snapshot, frame, active.signal);
            }
          }
        } catch (error) {
          if (lifetime.signal.aborted) break;
          onConnection(false);
          if (error instanceof ApiError) {
            onError(error);
            if (
              ['NOT_FOUND', 'FORBIDDEN', 'UNSUPPORTED_VERSION'].includes(
                error.code,
              )
            )
              break;
          }
        } finally {
          clearTimeout(watchdog);
          active.abort();
          await reader?.cancel().catch(() => {});
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          retry = setTimeout(
            resolve,
            Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)),
          );
        });
      }
    })();
    return () => {
      lifetime.abort();
      active?.abort();
      clearTimeout(watchdog);
      clearTimeout(retry);
      wake?.();
    };
  }
}

export class AgUiRunActivityClient extends RunActivityClient {
  protected override agUi = true;
}
