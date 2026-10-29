import type { Page } from '@playwright/test';
import {
  AgUiViewStream,
  type AgUiView,
} from '../../packages/shared/src/index.js';

/**
 * Replaces a passive AG-UI stream in the page with one the test drives. The
 * test supplies view snapshots; the real server-side encoder turns them into
 * standard events, so the page sees what a service would send. A reconnection
 * starts a fresh stream from the latest snapshot.
 */
export async function installAgUiStream(
  page: Page,
  options: {
    match: string;
    threadId: string;
    // Tests describe views loosely; the encoder normalises them.
    view: (snapshot: any) => AgUiView<object>;
    initial: unknown;
  },
) {
  let latest = options.initial;
  let stream = new AgUiViewStream(options.threadId, 'ui-test');
  await page.exposeFunction('__agUiInit', () => {
    stream = new AgUiViewStream(options.threadId, 'ui-test');
    return stream.encode(options.view(latest));
  });
  await page.addInitScript(`(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input).includes(${JSON.stringify(options.match)})) {
        const events = await window.__agUiInit();
        return new Response(new ReadableStream({ start(controller) {
          const push = (list) => {
            for (const event of list)
              controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + String.fromCharCode(10, 10)));
          };
          push(events);
          window.__agUiPush = push;
          init?.signal?.addEventListener('abort', () => controller.error(new Error('Aborted')), { once: true });
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return original(input, init);
    };
  })()`);
  const push = async (snapshot: unknown) => {
    latest = snapshot;
    await page.evaluate(
      (events: unknown[]) =>
        (
          window as unknown as { __agUiPush: (events: unknown[]) => void }
        ).__agUiPush(events),
      stream.encode(options.view(snapshot)),
    );
  };
  /** The snapshot the next connection (for example after a reload) starts from. */
  push.startFrom = (snapshot: unknown) => {
    latest = snapshot;
  };
  return push;
}
