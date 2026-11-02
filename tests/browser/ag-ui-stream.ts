import type { Page } from '@playwright/test';
import {
  AgUiViewStream,
  type AgUiView,
} from '../../packages/shared/src/index.js';

/**
 * Replaces one channel of the page's event stream with an AG-UI stream the
 * test drives. The page follows chats and run activity over its single
 * project stream, so this keeps that stream and answers for one channel on
 * it: the subscription for the channel never reaches the service, and the
 * test's snapshots arrive in its place. The test supplies view snapshots; the
 * real server-side encoder turns them into standard events, so the page sees
 * what a service would send. Each subscription, so also a reconnection,
 * starts a fresh stream from the latest snapshot.
 */
export async function installAgUiStream(
  page: Page,
  options: {
    /** For example `chat:12` or `activity:run-1`. */
    channel: string;
    threadId: string;
    // Tests describe views loosely; the encoder normalises them.
    view: (snapshot: any) => AgUiView<object>;
    initial: unknown;
  },
) {
  let latest = options.initial;
  let stream = new AgUiViewStream(options.threadId, 'ui-test');
  const text = (events: unknown[]) =>
    events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('');
  await page.exposeFunction('__agUiInit', () => {
    stream = new AgUiViewStream(options.threadId, 'ui-test');
    return text(stream.encode(options.view(latest)));
  });
  await page.addInitScript(`(() => {
    const original = window.fetch.bind(window);
    const channel = ${JSON.stringify(options.channel)};
    let controller;
    let active = false;
    const inject = (data) => {
      const message = JSON.stringify({ channel, data });
      controller?.enqueue(new TextEncoder().encode('event: channel\\ndata: ' + message + '\\n\\n'));
    };
    window.__agUiPush = inject;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (/\\/api\\/v1(\\/projects\\/[^/]+)?\\/events$/.test(url)) {
        const response = await original(input, init);
        const reader = response.body.getReader();
        active = false;
        return new Response(new ReadableStream({
          start(c) { controller = c; },
          async pull(c) {
            const chunk = await reader.read();
            if (chunk.done) c.close();
            else c.enqueue(chunk.value);
          },
          cancel: () => reader.cancel(),
        }), { status: response.status, headers: response.headers });
      }
      if (/\\/events\\/[^/]+\\/subscriptions$/.test(url) && init?.body) {
        const channels = JSON.parse(init.body).channels;
        const wanted = channels.includes(channel);
        const response = await original(input, {
          ...init,
          body: JSON.stringify({ channels: channels.filter((id) => id !== channel) }),
        });
        if (wanted && !active) inject(await window.__agUiInit());
        active = wanted;
        return response;
      }
      return original(input, init);
    };
  })()`);
  const push = async (snapshot: unknown) => {
    latest = snapshot;
    await page.evaluate(
      (data: string) =>
        (
          window as unknown as { __agUiPush: (data: string) => void }
        ).__agUiPush(data),
      text(stream.encode(options.view(snapshot))),
    );
  };
  /** The snapshot the next connection (for example after a reload) starts from. */
  push.startFrom = (snapshot: unknown) => {
    latest = snapshot;
  };
  return push;
}
