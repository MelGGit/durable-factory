import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startService } from '../helpers/credentials.js';
import { ChatClient } from '../../packages/shared/src/index.js';
import { fixture, configure, until } from '../fixtures/chat.js';

test(
  'browser chat restores drafts and pending sends, streams tools, survives browser and service restarts',
  { timeout: 60000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-chat-browser-'));
    let service = await startService({ dataDir, port: 0, chat: fixture(100) });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      let page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(service.url);
      await page.getByRole('button', { name: /^Start a chat in/ }).click();
      await page
        .getByRole('heading', {
          name: 'New planning conversation',
          exact: true,
        })
        .waitFor();
      const conversation = (await client.conversations()).conversations[0];
      await page
        .getByLabel('Message', { exact: true })
        .fill('Draft survives reload');
      await page.reload();
      await page.getByLabel('Message', { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel('Message', { exact: true }).inputValue(),
        'Draft survives reload',
      );
      const long = 'Explore durable behavior. '.repeat(30);
      await page.getByLabel('Message', { exact: true }).fill(long);
      await page.getByRole('button', { name: /^Send/ }).click();
      await page
        .locator('.chat-conversation[data-execution="running"]')
        .waitFor();
      await page
        .getByLabel('Message', { exact: true })
        .fill('Withdraw this follow-up');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
      await page.getByText('withdrawn', { exact: true }).waitFor();
      await page
        .getByRole('button', { name: 'Interrupt conversation', exact: true })
        .click();
      await page.locator('.chat-conversation[data-execution="idle"]').waitFor();
      // Lose the acknowledgement after admission. Retrying must reuse the saved ID.
      let dropped = false;
      await page.route('**/api/v1/ag-ui/run', async (route) => {
        if (!dropped && route.request().method() === 'POST') {
          dropped = true;
          await route.fetch();
          await route.abort('failed');
        } else await route.continue();
      });
      await page
        .getByLabel('Message', { exact: true })
        .fill('One uncertain send');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: 'Failed to fetch' })
        .waitFor();
      await page.reload();
      await page
        .locator('.chat-conversation[data-connection="connected"]')
        .waitFor();
      await until(
        async () => (await client.history(conversation.id)).entries,
        (entries) =>
          entries.some((entry) =>
            entry.text.includes('Offline reply: One uncertain send'),
          ),
      );
      assert.equal(
        (await client.history(conversation.id)).entries.filter(
          (entry) =>
            entry.kind === 'pi.user' && entry.text === 'One uncertain send',
        ).length,
        1,
      );
      await page.getByLabel('Message', { exact: true }).fill('use tool');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page.locator('.tool-card').first().waitFor();
      await until(
        async () => (await client.history(conversation.id)).entries,
        (entries) =>
          entries.some((entry) => entry.tools.some((tool) => tool.artifact)),
      );
      const result = page.locator('.tool-card[data-tool-id="probe-call"]');
      assert.equal(await result.count(), 1);
      await result.locator('summary').click();
      await result
        .getByRole('button', { name: 'Read complete output' })
        .click();
      await result.getByText(/Running controlled fixture/).waitFor();
      const port = service.port;
      await service.close();
      await page
        .locator('.chat-conversation[data-connection="disconnected"]')
        .waitFor();
      service = await startService({ dataDir, port, chat: fixture() });
      await page
        .locator('.chat-conversation[data-connection="connected"]')
        .waitFor();
      // Accepted work continues after the browser page closes.
      await page
        .getByLabel('Message', { exact: true })
        .fill('Work survives browser closure');
      await page.getByRole('button', { name: /^Send/ }).click();
      await until(
        async () => (await client.history(conversation.id)).entries,
        (entries) =>
          entries.some(
            (entry) => entry.text === 'Work survives browser closure',
          ),
      );
      await page.close();
      page = await context.newPage();
      await page.goto(service.url);
      await page
        .getByText('Offline reply: Work survives browser closure', {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .locator('.message-text')
          .filter({ hasText: 'Offline reply: One uncertain send' })
          .count(),
        1,
      );
      await mkdir(resolve('test-results'), { recursive: true });
      await page.screenshot({
        path: resolve('test-results/chat-desktop.png'),
        animations: 'disabled',
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page
          .locator('.composer')
          .evaluate(
            (element) => element.getBoundingClientRect().bottom <= innerHeight,
          ),
      );
      await page.screenshot({
        path: resolve('test-results/chat-mobile.png'),
        animations: 'disabled',
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
