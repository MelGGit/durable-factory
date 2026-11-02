import { ApiError } from '../../../packages/shared/src/index.js';
import type { StreamSink } from './sse.js';

/** A client may follow a few chats and runs over its one event stream. */
export const MAX_CHANNELS = 8;
const CHANNEL = /^chat:\d{1,20}$|^activity:[A-Za-z0-9_-]{1,128}$/;

type Kind = 'chat' | 'activity';
export interface ChannelSource {
  /** Throws a 404 unless the target exists in the project. */
  authorize(kind: Kind, id: string, project?: string): Promise<void>;
  /** Streams the target into the sink until the sink closes. */
  start(kind: Kind, id: string, sink: StreamSink): Promise<void>;
}

interface Channel {
  close(): void;
}
interface Attached {
  project?: string;
  write: (text: string) => Promise<boolean>;
  channels: Map<string, Channel>;
  closed: boolean;
  /** Replacements run one at a time, so each sees the previous result. */
  turn: Promise<unknown>;
}

/** The streams of chats and runs that clients follow through their open
 * project stream, keyed by that stream's id. */
export class ChannelRegistry {
  private streams = new Map<string, Attached>();
  constructor(private source: ChannelSource) {}
  /** Registers a project stream. Call the result when it closes. */
  attach(
    streamId: string,
    project: string | undefined,
    write: (text: string) => Promise<boolean>,
  ) {
    const stream: Attached = {
      project,
      write,
      channels: new Map(),
      closed: false,
      turn: Promise.resolve(),
    };
    this.streams.set(streamId, stream);
    return () => {
      stream.closed = true;
      this.streams.delete(streamId);
      for (const channel of [...stream.channels.values()]) channel.close();
    };
  }
  /** Replaces the set of channels a stream carries. Channels in both sets
   * keep running. Returns the channels now carried. */
  async replace(streamId: string, input: unknown) {
    const stream = this.streams.get(streamId);
    if (!stream)
      throw new ApiError('NOT_FOUND', 'Event stream not found.', 404);
    const list = (input as { channels?: unknown } | null)?.channels;
    if (
      !Array.isArray(list) ||
      list.length > MAX_CHANNELS ||
      !list.every((item) => typeof item === 'string' && CHANNEL.test(item))
    )
      throw new ApiError(
        'INVALID_INPUT',
        `Provide at most ${MAX_CHANNELS} chat or activity channels.`,
        400,
      );
    const wanted = [...new Set(list as string[])];
    const turn = stream.turn.then(() => this.apply(stream, wanted));
    stream.turn = turn.catch(() => {});
    return turn;
  }
  private async apply(stream: Attached, wanted: string[]) {
    const added = wanted.filter((channel) => !stream.channels.has(channel));
    await Promise.all(
      added.map((channel) => {
        const [kind, id] = channel.split(':');
        return this.source.authorize(kind as Kind, id, stream.project);
      }),
    );
    if (stream.closed)
      throw new ApiError('NOT_FOUND', 'Event stream not found.', 404);
    for (const [channel, running] of [...stream.channels])
      if (!wanted.includes(channel)) running.close();
    for (const channel of added) {
      const [kind, id] = channel.split(':');
      stream.channels.set(channel, this.run(stream, channel, kind as Kind, id));
    }
    return wanted;
  }
  private run(
    stream: Attached,
    channel: string,
    kind: Kind,
    id: string,
  ): Channel {
    const callbacks: (() => void)[] = [];
    let closed = false;
    const send = (message: object) =>
      stream.write(
        `event: channel\ndata: ${JSON.stringify({ channel, ...message })}\n\n`,
      );
    const close = () => {
      if (closed) return;
      closed = true;
      if (stream.channels.get(channel) === running)
        stream.channels.delete(channel);
      for (const callback of callbacks.splice(0)) callback();
    };
    const sink: StreamSink = {
      closed: () => closed,
      open: () => {},
      write: (payload) =>
        closed ? Promise.resolve(false) : send({ data: payload }),
      // The project stream's own heartbeat covers every channel.
      heartbeat: () => true,
      last: (payload) => {
        if (!closed) void send({ data: payload });
      },
      end: () => {
        if (closed) return;
        void send({ end: true });
        close();
      },
      onClose: (callback) => {
        if (closed) callback();
        else callbacks.push(callback);
      },
    };
    const running: Channel = { close };
    this.source.start(kind, id, sink).catch(() => {
      if (closed) return;
      void send({ end: true, error: 'The stream failed.' });
      close();
    });
    return running;
  }
}
