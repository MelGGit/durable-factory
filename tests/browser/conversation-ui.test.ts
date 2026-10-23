import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startService } from '../../apps/server/src/service.js';
import {
  ChatClient,
  type ConversationSnapshot,
} from '../../packages/shared/src/index.js';
import { fixture, configure } from '../fixtures/chat.js';

async function installSnapshotStream(
  page: Page,
  initial: ConversationSnapshot,
) {
  await page.addInitScript(`(() => {
        const initial = ${JSON.stringify(initial)};
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          if (typeof input === 'string' && input.endsWith('/events')) {
            return new Response(new ReadableStream({ start(controller) {
              let sequence = 0;
              window.pushSnapshot = value => controller.enqueue(new TextEncoder().encode(
                'data: ' + JSON.stringify({apiVersion:'v1', streamId:'ui-test', sequence:++sequence, type:sequence === 1 ? 'snapshot' : 'update', snapshot:value}) + String.fromCharCode(10,10)
              ));
              window.pushSnapshot(initial);
              init?.signal?.addEventListener('abort', () => controller.error(new Error('Aborted')), {once:true});
            }}), {headers:{'Content-Type':'text/event-stream'}});
          }
          return original(input, init);
        };
      })()`);
}
async function pushSnapshot(page: Page, snapshot: ConversationSnapshot) {
  await page.evaluate(
    (value) =>
      (
        window as unknown as { pushSnapshot: (value: unknown) => void }
      ).pushSnapshot(value),
    snapshot,
  );
}

test(
  'growing tool artifacts stay readable after EOF, completion and in-flight reads',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-artifact-growth-'));
    const service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'Growing output',
        'growth',
      );
      let snapshot: ConversationSnapshot = {
        conversation,
        execution: 'running',
        partial: '',
        submissions: [],
        entries: [],
        tools: [
          {
            id: 'call',
            name: 'probe',
            status: 'running',
            output: 'Preview',
            artifact: 'task-1',
          },
        ],
      };
      const page = await browser.newPage();
      page.setDefaultTimeout(6000);
      await installSnapshotStream(page, snapshot);
      const offsets: number[] = [];
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pending = false;
      await page.route('**/artifacts/task-1?*', async (route) => {
        const offset = Number(
          new URL(route.request().url()).searchParams.get('offset'),
        );
        offsets.push(offset);
        if (offsets.length === 1)
          await route.fulfill({ json: { text: 'Early ✓' } });
        else if (offsets.length === 2) {
          pending = true;
          await gate;
          await route.fulfill({ json: { text: '\nStill running' } });
        } else await route.fulfill({ json: { text: '\nFinal output' } });
      });
      await page.goto(`${service.url}/?conversation=${conversation.id}`);
      const tool = page.locator('.tool-card[data-tool-id="call"]');
      await tool.locator('summary').click();
      await tool
        .getByRole('button', { name: 'Read complete output', exact: true })
        .click();
      await tool
        .locator('.artifact-output pre')
        .filter({ hasText: 'Early ✓' })
        .waitFor();
      await tool
        .getByRole('button', { name: 'Load more output', exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLButtonElement>('.artifact-output button')
            ?.disabled,
      );
      // Finish while the earlier running-phase request is still in flight.
      assert.ok(pending);
      snapshot = {
        ...snapshot,
        execution: 'idle',
        tools: [],
        entries: [
          {
            id: '1',
            kind: 'pi.assistant',
            text: '',
            tools: [
              {
                id: 'call',
                name: 'probe',
                arguments: '{}',
                status: 'completed',
              },
            ],
          },
          {
            id: '2',
            kind: 'pi.tool-result',
            text: '',
            tools: [
              {
                id: 'call',
                name: 'probe',
                status: 'completed',
                output: 'Final preview',
                artifact: 'task-1',
                truncated: true,
              },
            ],
          },
        ],
      };
      await pushSnapshot(page, snapshot);
      await tool.getByText('Final preview', { exact: true }).waitFor();
      release();
      await tool
        .getByRole('button', { name: 'Load more output', exact: true })
        .waitFor();
      await tool
        .locator('.artifact-output pre')
        .filter({ hasText: 'Still running' })
        .waitFor();
      await tool
        .getByRole('button', { name: 'Load more output', exact: true })
        .click();
      await tool
        .locator('.artifact-output pre')
        .filter({ hasText: 'Final output' })
        .waitFor();
      assert.deepEqual(offsets, [
        0,
        Buffer.byteLength('Early ✓'),
        Buffer.byteLength('Early ✓\nStill running'),
      ]);
      assert.equal(
        await tool.locator('.artifact-output pre').textContent(),
        'Early ✓\nStill running\nFinal output',
      );
      assert.equal(
        await tool
          .getByRole('button', { name: 'Load more output', exact: true })
          .count(),
        0,
      );
      assert.equal(await tool.getAttribute('open'), '');
      await browser.close();
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'pagination preserves a visible message when an orphan tool card moves to its older call',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), 'factory-tool-history-anchor-'),
    );
    const service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'History anchor',
        'anchor',
      );
      const entries = Array.from({ length: 16 }, (_, i) => ({
        id: String(i + 10),
        kind: i % 2 ? 'pi.assistant' : 'pi.user',
        text: `History row ${i}: ${'Readable history. '.repeat(7)}`,
        tools: [],
      }));
      const snapshot: ConversationSnapshot = {
        conversation,
        execution: 'idle',
        partial: '',
        submissions: [],
        olderCursor: 'older',
        tools: [],
        entries: [
          ...entries,
          {
            id: '30',
            kind: 'pi.tool-result',
            text: '',
            tools: [
              {
                id: 'old-call',
                name: 'probe',
                output: 'Final output',
                status: 'completed',
              },
            ],
          },
        ],
      };
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(6000);
      await installSnapshotStream(page, snapshot);
      await page.route('**/history?*', (route) =>
        route.fulfill({
          json: {
            entries: [
              {
                id: '1',
                kind: 'pi.assistant',
                text: 'Older assistant context',
                tools: [
                  {
                    id: 'old-call',
                    name: 'probe',
                    arguments: '{}',
                    status: 'pending',
                  },
                ],
              },
            ],
          },
        }),
      );
      await page.goto(`${service.url}/?conversation=${conversation.id}`);
      const tool = page.locator('.tool-card[data-tool-id="old-call"]');
      await tool.locator('summary').click();
      await page.getByLabel('Conversation transcript').evaluate((element) => {
        element.scrollTop = 0;
      });
      const message = page.getByText(entries[0].text, { exact: true });
      const top = await message.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await page.getByRole('button', { name: 'Load older messages' }).click();
      await page
        .getByText('Older assistant context', { exact: true })
        .waitFor();
      const restored = await message.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      assert.ok(
        Math.abs(restored - top) < 2,
        `Visible message shifted by ${restored - top}px`,
      );
      assert.equal(await tool.count(), 1);
      assert.equal(await tool.getAttribute('open'), '');
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'conversation formatting, stable tool cards, reading position, composer keys and role restrictions',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-conversation-ui-'));
    const service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'Improve conversation UI',
        'ui-test',
      );
      let snapshot: ConversationSnapshot = {
        conversation,
        execution: 'running',
        partial: '',
        submissions: [],
        entries: Array.from({ length: 22 }, (_, i) => ({
          id: String(i + 1),
          kind: i % 2 ? 'pi.assistant' : 'pi.user',
          text:
            i % 2
              ? `Response ${i}: readable conversation history.`
              : `Question ${i}: keep this reading position.`,
          tools: [],
        })),
        tools: [
          {
            id: 'read-call',
            name: 'read_file',
            arguments: '{"path":"apps/web/src/chat.tsx"}',
            status: 'running',
            output: 'Reading conversation renderer…',
          },
        ],
      };
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(6000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await installSnapshotStream(page, snapshot);
      const push = async () => {
        await page.evaluate(
          (value) =>
            (
              window as unknown as { pushSnapshot: (value: unknown) => void }
            ).pushSnapshot(value),
          snapshot,
        );
      };
      await page.goto(`${service.url}/?conversation=${conversation.id}`);
      await page.locator('.agent-activity').waitFor();
      const tool = page.locator('.tool-card[data-tool-id="read-call"]');
      await tool.locator('summary').click();
      const transcript = page.getByLabel('Conversation transcript');
      await transcript.evaluate((element) => {
        element.scrollTop = 80;
      });
      await page.getByRole('button', { name: 'Jump to latest ↓' }).waitFor();
      const before = await transcript.evaluate((element) => element.scrollTop);
      snapshot = {
        ...snapshot,
        partial:
          '## A clearer conversation\n\n- Formatted **replies**\n- Unified tools\n\n```ts\nconst readable = true;\n```\n\n| Part | Change |\n| --- | --- |\n| Tools | One card |\n\n[Documentation](https://example.com)\n\n<script>window.bad = true</script><a href="javascript:alert(1)">Unsafe link</a><img src=x onerror="alert(1)">',
        tools: [],
        entries: [
          ...snapshot.entries,
          {
            id: '23',
            kind: 'pi.assistant',
            text: 'I checked the renderer.',
            tools: [
              {
                id: 'read-call',
                name: 'read_file',
                arguments: '{"path":"apps/web/src/chat.tsx"}',
                status: 'pending',
              },
            ],
          },
          {
            id: '24',
            kind: 'pi.tool-result',
            text: '',
            tools: [
              {
                id: 'read-call',
                name: 'read_file',
                status: 'completed',
                output: 'Renderer inspected.',
              },
            ],
          },
        ],
      };
      await push();
      await tool.getByText('Renderer inspected.', { exact: true }).waitFor();
      assert.equal(await tool.count(), 1);
      assert.equal(await tool.getAttribute('open'), '');
      assert.ok(
        Math.abs(
          (await transcript.evaluate((element) => element.scrollTop)) - before,
        ) < 3,
      );
      const markdown = page.locator('.markdown').last();
      assert.equal(
        await markdown.locator('h2').textContent(),
        'A clearer conversation',
      );
      assert.equal(await markdown.locator('table').count(), 1);
      assert.equal(await markdown.locator('pre code').count(), 1);
      assert.equal(
        await markdown
          .locator('script, img, [onerror], a[href^="javascript:"]')
          .count(),
        0,
      );
      await page.getByRole('button', { name: 'Jump to latest ↓' }).click();
      assert.ok(
        await transcript.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight < 3,
        ),
      );
      const input = page.getByLabel('Message', { exact: true });
      await input.fill('First line');
      await input.press('Shift+Enter');
      await input.press('End');
      assert.match(await input.inputValue(), /\n/);
      await input.dispatchEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        isComposing: true,
      });
      assert.equal((await client.history(conversation.id)).entries.length, 0);
      await input.fill('Send with Enter');
      await input.press('Enter');
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLTextAreaElement>('#chat-message')
            ?.value === '',
      );
      assert.equal(
        (await client.history(conversation.id)).entries.filter(
          (e) => e.kind === 'pi.user',
        ).length,
        1,
      );
      snapshot = {
        ...snapshot,
        conversation: { ...conversation, role: 'development' },
      };
      await push();
      await page
        .getByText('Development agent · Responding', { exact: true })
        .waitFor();
      snapshot = {
        ...snapshot,
        conversation: { ...conversation, role: 'review' },
      };
      await push();
      await page
        .getByText('Review agent · Responding', { exact: true })
        .waitFor();
      assert.equal(await input.count(), 0);
      assert.equal(
        await page
          .getByRole('button', { name: 'Interrupt conversation' })
          .count(),
        0,
      );
      snapshot = {
        ...snapshot,
        conversation: { ...conversation, role: 'development' },
        workflow: {
          runId: 'run',
          status: 'running',
          stage: 'developer',
          acceptsInput: false,
        },
      };
      await push();
      await page.getByText(/Implementation input is closed/).waitFor();
      assert.equal(await input.count(), 0);
      assert.ok(
        await page
          .getByRole('button', { name: 'Interrupt conversation' })
          .isEnabled(),
      );
      snapshot = { ...snapshot, conversation, workflow: undefined };
      await push();
      await input.waitFor();
      await mkdir(resolve('test-results'), { recursive: true });
      await page.screenshot({
        path: resolve('test-results/conversation-redesign-desktop.png'),
      });
      for (const width of [1024, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        assert.ok(
          await page
            .locator('.composer')
            .evaluate(
              (element) =>
                element.getBoundingClientRect().bottom <= innerHeight,
            ),
        );
        await page.screenshot({
          path: resolve(`test-results/conversation-redesign-${width}.png`),
        });
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
