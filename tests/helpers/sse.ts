import { request, type IncomingMessage } from 'node:http';

export interface Message {
  id?: string;
  event?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

/** Opens a stream the way a reconnecting client would. */
export function open(base: string, path: string, resume?: string) {
  const messages: Message[] = [];
  const waiting: (() => void)[] = [];
  let response: IncomingMessage | undefined;
  let arrived = false;
  let ended = false;
  let buffer = '';
  const req = request(
    `${base}${path}`,
    { headers: resume === undefined ? {} : { 'Last-Event-ID': resume } },
    (res) => {
      response = res;
      arrived = true;
      res.on('close', () => (ended = true));
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (
          let end = buffer.indexOf('\n\n');
          end >= 0;
          end = buffer.indexOf('\n\n')
        ) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const message: Message = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) message.id = line.slice(4);
            else if (line.startsWith('event: ')) message.event = line.slice(7);
            else if (line.startsWith('data: '))
              message.data = JSON.parse(line.slice(6));
          }
          if (message.data !== undefined && message.event !== 'heartbeat')
            messages.push(message);
        }
        for (const wake of waiting.splice(0)) wake();
      });
    },
  );
  req.on('error', () => undefined);
  req.end();
  return {
    /** Whether the response itself, not a frame, arrives in time. */
    async opened(timeout: number) {
      const deadline = Date.now() + timeout;
      while (!arrived && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      return arrived;
    },
    /** The next frame, or undefined if none arrives in time. */
    async next(timeout: number) {
      const deadline = Date.now() + timeout;
      while (!messages.length && Date.now() < deadline)
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          setTimeout(resolve, 25);
        });
      return messages.shift();
    },
    /** Whether the service ended the stream in time. */
    async ended(timeout: number) {
      const deadline = Date.now() + timeout;
      while (!ended && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      return ended;
    },
    close() {
      response?.destroy();
      req.destroy();
    },
  };
}
