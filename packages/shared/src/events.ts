import { ApiError } from './core.js';
import type {
  ChannelMessage,
  ProjectState,
  WorkflowClient,
} from './workflow.js';

/** Where a chat or run activity gets a `fetch` that delivers its AG-UI
 * stream, so that it needs no connection of its own. */
export interface ChannelSource {
  channel(id: string): typeof fetch;
}

const encoder = new TextEncoder();
const HEARTBEAT = encoder.encode(': heartbeat\n\n');

/** One channel's response body, fed by the hub. */
class Feed {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private done = false;
  readonly body = new ReadableStream<Uint8Array>({
    start: (controller) => void (this.controller = controller),
    cancel: () => {
      this.done = true;
      this.onCancel();
    },
  });
  constructor(private onCancel: () => void) {}
  push(chunk: Uint8Array) {
    if (!this.done) this.controller.enqueue(chunk);
  }
  close() {
    if (this.done) return;
    this.done = true;
    this.controller.close();
  }
  error(error: Error) {
    if (this.done) return;
    this.done = true;
    this.controller.error(error);
  }
}

/** Keeps one connection to the project's event stream, and carries chats and
 * run activities over it. Each `channel` is a `fetch` for `observeAgUi`, so
 * its backoff, watchdog and fresh snapshot per connection all apply. */
export class EventHub implements ChannelSource {
  private streamId?: string;
  private feeds = new Map<string, Feed>();
  /** What the service was last told, and what was replaced since. */
  private applied = new Set<string>();
  private stale = new Set<string>();
  private flushing = false;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private onError: (error: Error) => void = () => {};
  constructor(private client: WorkflowClient) {}
  watch(
    onState: (state: ProjectState) => void,
    onConnection: (connected: boolean) => void,
    onError: (error: Error) => void = () => {},
  ) {
    this.onError = onError;
    const stop = this.client.watchProject(
      onState,
      (connected) => {
        if (!connected) this.lost();
        onConnection(connected);
      },
      onError,
      {
        open: (streamId) => this.opened(streamId),
        channel: (message) => this.route(message),
        // Every byte of the connection proves each channel alive as well.
        alive: () => {
          for (const feed of this.feeds.values()) feed.push(HEARTBEAT);
        },
      },
    );
    return () => {
      stop();
      clearTimeout(this.timer);
      this.lost();
    };
  }
  channel(id: string): typeof fetch {
    return async (_input, init) => {
      const signal = init?.signal;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const feed: Feed = new Feed(() => this.release(id, feed));
      this.feeds.get(id)?.error(new Error('Replaced.'));
      // A channel the service already carries must start over, for a snapshot.
      if (this.applied.has(id)) this.stale.add(id);
      this.feeds.set(id, feed);
      signal?.addEventListener(
        'abort',
        () => {
          this.release(id, feed);
          feed.error(new Error('Disconnected.'));
        },
        { once: true },
      );
      this.schedule();
      return new Response(feed.body, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
  }
  private release(id: string, feed: Feed) {
    if (this.feeds.get(id) !== feed) return;
    this.feeds.delete(id);
    if (this.applied.has(id)) this.stale.add(id);
    this.schedule();
  }
  private route(message: ChannelMessage) {
    const feed = this.feeds.get(message.channel);
    if (!feed) return;
    if (message.data !== undefined) feed.push(encoder.encode(message.data));
    if (!message.end) return;
    // The service stopped carrying it, so a new subscription must restart it.
    this.feeds.delete(message.channel);
    this.applied.delete(message.channel);
    if (message.error) feed.error(new Error(message.error));
    else feed.close();
  }
  private opened(streamId: string | undefined) {
    this.applied.clear();
    this.stale.clear();
    this.streamId = streamId;
    if (streamId) this.schedule();
    else this.fail(new Error('The service cannot carry chats on this stream.'));
  }
  /** The connection is gone, and with it everything it carried. */
  private lost() {
    const was = this.streamId;
    this.streamId = undefined;
    this.applied.clear();
    this.stale.clear();
    if (was) this.fail(new Error('Disconnected.'));
  }
  private fail(error: Error) {
    for (const feed of this.feeds.values()) feed.error(error);
    this.feeds.clear();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 10);
  }
  private async flush() {
    // Changes during a flush are picked up by going again.
    if (this.flushing) {
      this.again = true;
      return;
    }
    this.flushing = true;
    try {
      let failures = 0;
      do {
        this.again = false;
        const streamId = this.streamId;
        if (!streamId) break;
        try {
          const wanted = [...this.feeds.keys()];
          const restart = wanted.filter((id) => this.stale.has(id));
          if (restart.length) {
            const rest = wanted.filter((id) => !this.stale.has(id));
            await this.client.subscribe(streamId, rest);
            if (this.streamId === streamId) this.applied = new Set(rest);
          }
          const current = this.applied;
          if (
            this.streamId === streamId &&
            (wanted.length !== current.size ||
              wanted.some((id) => !current.has(id)))
          ) {
            await this.client.subscribe(streamId, wanted);
            if (this.streamId === streamId) this.applied = new Set(wanted);
          }
          if (this.streamId === streamId) this.stale.clear();
          failures = 0;
        } catch (error) {
          // A stream that has gone is replaced by the reconnect.
          if (error instanceof ApiError && error.code === 'NOT_FOUND') continue;
          if (++failures > 4) {
            this.onError(error instanceof Error ? error : new Error('Failed.'));
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500 * failures));
          this.again = true;
        }
      } while (this.again);
    } finally {
      this.flushing = false;
    }
  }
}
