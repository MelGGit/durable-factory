import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../helpers/credentials.js';
import { ApiError, ChatClient } from '../../packages/shared/src/index.js';
import { fixture, configure, until } from '../fixtures/chat.js';

const launch = () =>
  chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
async function seed(
  client: ChatClient,
  id: string,
  prefix: string,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    await client.submit(
      id,
      `${prefix} ${i}`,
      `${prefix.replaceAll(' ', '-')}-${i}`,
    );
    await until(
      () => client.submission(id, `${prefix.replaceAll(' ', '-')}-${i}`),
      (value) => value.status === 'completed',
    );
  }
}

test(
  'separate tabs preserve migrated drafts, selection, and uncertain request IDs',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-tabs-'));
    const service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await launch();
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const a = await client.createConversation('Draft A', 'create-a');
      const b = await client.createConversation('Draft B', 'create-b');
      const context = await browser.newContext();
      const page1 = await context.newPage();
      page1.setDefaultTimeout(10000);
      await page1.goto(`${service.url}/health`);
      await page1.evaluate(
        ({ id }) =>
          localStorage.setItem(
            'factory.chat.v1',
            JSON.stringify({
              selected: id,
              drafts: { [id]: 'Legacy A draft' },
              pending: [
                {
                  conversationId: id,
                  requestId: 'legacy-input',
                  content: 'Legacy pending input',
                },
              ],
            }),
          ),
        { id: a.id },
      );
      await page1.goto(service.url);
      await page1
        .getByRole('heading', { name: 'Draft A', exact: true })
        .waitFor();
      // The saved request ID is the AG-UI message ID of the recovered send.
      await until(
        async () => (await client.history(a.id)).entries,
        (entries) =>
          entries.some((entry) =>
            entry.text.includes('Offline reply: Legacy pending input'),
          ),
      );
      assert.equal(
        await page1.getByLabel('Message', { exact: true }).inputValue(),
        'Legacy A draft',
      );
      const page2 = await context.newPage();
      page2.setDefaultTimeout(10000);
      await page2.goto(service.url);
      await page2
        .getByRole('heading', { name: 'Draft A', exact: true })
        .waitFor();
      // Background tabs may receive storage notifications late. Correctness must
      // not depend on receiving another tab's event before writing a new draft.
      await page2.evaluate(() =>
        window.addEventListener(
          'storage',
          (event) => event.stopImmediatePropagation(),
          { capture: true },
        ),
      );
      await page1.getByLabel('Message', { exact: true }).fill('Keep A draft');
      await page2.getByRole('button', { name: 'Draft B Planning' }).click();
      await page2
        .getByRole('heading', { name: 'Draft B', exact: true })
        .waitFor();
      await page2.getByLabel('Message', { exact: true }).fill('Keep B draft');
      await page1.reload();
      await page1
        .getByRole('heading', { name: 'Draft A', exact: true })
        .waitFor();
      assert.equal(
        await page1.getByLabel('Message', { exact: true }).inputValue(),
        'Keep A draft',
      );
      assert.equal(
        await page2.getByLabel('Message', { exact: true }).inputValue(),
        'Keep B draft',
      );
      let dropped = false;
      let requestId = '';
      await page1.route('**/api/v1/ag-ui/run', async (route) => {
        if (!dropped && route.request().method() === 'POST') {
          dropped = true;
          requestId = route.request().postDataJSON().messages.at(-1).id;
          await route.fetch();
          await route.abort('failed');
        } else await route.continue();
      });
      await page1
        .getByLabel('Message', { exact: true })
        .fill('Uncertain send from A');
      await page1.getByRole('button', { name: /^Send/ }).click();
      await page1
        .getByRole('alert')
        .filter({ hasText: 'Failed to fetch' })
        .waitFor();
      await page2
        .getByLabel('Message', { exact: true })
        .fill('Updated B draft');
      assert.ok(
        await page2.evaluate(
          (key) => localStorage.getItem(key),
          `factory.chat.v1.pending.${requestId}`,
        ),
      );
      await page1.reload();
      await page1
        .getByRole('heading', { name: 'Draft A', exact: true })
        .waitFor();
      await until(
        async () =>
          page1.evaluate(
            (key) => localStorage.getItem(key),
            `factory.chat.v1.pending.${requestId}`,
          ),
        (value) => value === null,
      );
      assert.equal(
        (await client.history(a.id)).entries.filter(
          (entry) => entry.text === 'Uncertain send from A',
        ).length,
        1,
      );
      assert.equal(
        (await client.history(a.id)).entries.filter(
          (entry) => entry.text === 'Legacy pending input',
        ).length,
        1,
      );
      await page2.reload();
      await page2
        .getByRole('heading', { name: 'Draft B', exact: true })
        .waitFor();
      assert.equal(
        await page2.getByLabel('Message', { exact: true }).inputValue(),
        'Updated B draft',
      );
      await context.close();
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'reconnect fills multiple missing history pages and retries a failed backfill',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-reconnect-gap-'));
    let service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await launch();
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'Reconnect gap',
        'create-gap',
      );
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(service.url);
      await page
        .getByRole('navigation', { name: /sessions$/ })
        .getByRole('button', { name: 'Reconnect gap Planning', exact: true })
        .click();
      await page
        .getByRole('heading', { name: 'Reconnect gap', exact: true })
        .waitFor();
      await client.submit(conversation.id, 'Before disconnect', 'before');
      await page
        .getByText('Offline reply: Before disconnect', { exact: true })
        .waitFor();
      await context.setOffline(true);
      const port = service.port;
      await service.close();
      service = await startService({ dataDir, port, chat: fixture() });
      await seed(client, conversation.id, 'During disconnect', 65);
      let failed = false;
      await page.route('**/history*', async (route) => {
        if (!failed) {
          failed = true;
          await route.abort('failed');
        } else await route.continue();
      });
      await context.setOffline(false);
      await page
        .getByText('Offline reply: During disconnect 64', { exact: true })
        .waitFor();
      assert.ok(failed);
      const texts = await page.locator('.message-text').allTextContents();
      assert.equal(texts.length, 132);
      assert.equal(new Set(texts).size, 132);
      for (let i = 0; i < 65; i++) {
        assert.ok(texts.includes(`During disconnect ${i}`));
        assert.ok(texts.includes(`Offline reply: During disconnect ${i}`));
      }
      if (
        await page.getByRole('button', { name: 'Load older messages' }).count()
      ) {
        await page.getByRole('button', { name: 'Load older messages' }).click();
        await until(
          async () =>
            page.getByRole('button', { name: 'Load older messages' }).count(),
          (count) => count === 0,
        );
      }
      assert.equal(await page.locator('.message-text').count(), 132);
      await context.close();
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'delayed history cannot enter another conversation or change its pagination',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-history-switch-'));
    const service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await launch();
    let release = () => {};
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const a = await client.createConversation('History A', 'create-a');
      const b = await client.createConversation('History B', 'create-b');
      await seed(client, a.id, 'A private question', 30);
      await seed(client, b.id, 'B question', 30);
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(service.url);
      await page
        .getByRole('navigation', { name: /sessions$/ })
        .getByRole('button', { name: 'History A Planning', exact: true })
        .click();
      await page
        .getByRole('heading', { name: 'History A', exact: true })
        .waitFor();
      const gate = new Promise<void>((resolve) => (release = resolve));
      let requested = false,
        delivered = false;
      await page.route(
        `**/api/v1/conversations/${a.id}/ag-ui/history?*`,
        async (route) => {
          const response = await route.fetch();
          requested = true;
          await gate;
          try {
            await route.fulfill({ response });
          } catch {
            /* Switching conversations aborts this fetch. */
          }
          delivered = true;
        },
      );
      await page.getByRole('button', { name: 'Load older messages' }).click();
      await until(async () => requested, Boolean);
      await page
        .getByRole('navigation', { name: /sessions$/ })
        .getByRole('button', { name: 'History B Planning', exact: true })
        .click();
      await page
        .getByRole('heading', { name: 'History B', exact: true })
        .waitFor();
      release();
      await until(async () => delivered, Boolean);
      assert.ok(
        await page
          .getByRole('button', { name: 'Load older messages' })
          .isEnabled(),
      );
      await page.getByLabel('Conversation transcript').evaluate((element) => {
        element.scrollTop = 0;
      });
      const anchorText = await page
        .locator('.message-text')
        .first()
        .textContent();
      const anchorTop = await page
        .locator('.message-text')
        .first()
        .evaluate((element) => element.getBoundingClientRect().top);
      await page.getByRole('button', { name: 'Load older messages' }).click();
      await page.getByText('B question 0', { exact: true }).waitFor();
      const restoredTop = await page
        .getByText(anchorText!, { exact: true })
        .evaluate((element) => element.getBoundingClientRect().top);
      assert.ok(Math.abs(restoredTop - anchorTop) < 3);
      assert.equal(await page.getByText(/A private question/).count(), 0);
      assert.equal(
        await page.getByRole('button', { name: 'Load older messages' }).count(),
        0,
      );
      assert.equal(await page.locator('.message-text').count(), 60);
      await context.close();
    } finally {
      release();
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
