import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../helpers/credentials.js';
import { ChatClient } from '../../packages/shared/src/index.js';
import { configure } from '../fixtures/chat.js';
import { planningFixture } from '../fixtures/planning.js';

test(
  'sidebar resizes within bounds and collapses without moving the branding',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-sidebar-layout-'));
    const service = await startService({ dataDir, port: 0 });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${service.url}/settings`);
      await page.getByRole('heading', { name: 'Appearance' }).waitFor();

      const navigation = page.getByRole('complementary', {
        name: 'Conversation navigation',
      });
      const separator = page.getByRole('separator', { name: 'Resize sidebar' });
      const position = () =>
        page.evaluate(() =>
          ['.brand-mark', '.chat-brand strong', '.sidebar-toggle'].map(
            (selector) => {
              const { x, y, width, height } = document
                .querySelector(selector)!
                .getBoundingClientRect();
              return { x, y, width, height };
            },
          ),
        );
      const initial = await position();
      assert.equal((await navigation.boundingBox())!.width, 288);
      assert.equal(
        await navigation.locator('.sidebar-branding').count(),
        1,
        'branding belongs to the sidebar',
      );
      assert.equal(
        await navigation
          .getByRole('separator', { name: 'Resize sidebar' })
          .count(),
        1,
      );
      const checkSidebarColumn = async () => {
        const sidebar = (await navigation.boundingBox())!;
        const branding = (await page
          .locator('.sidebar-branding')
          .boundingBox())!;
        const header = (await page.locator('.chat-header').boundingBox())!;
        const handle = (await separator.boundingBox())!;
        assert.equal(
          branding.width,
          sidebar.width,
          'branding and navigation share the sidebar width',
        );
        assert.equal(
          header.x,
          sidebar.x + sidebar.width,
          'page header starts at the sidebar edge',
        );
        assert.equal(
          handle.y,
          0,
          'the resize handle includes the sidebar header',
        );
      };
      await checkSidebarColumn();
      const checkHeaderAlignment = async () => {
        const title = (await page.locator('.chat-header h1').boundingBox())!;
        const body = (await page
          .getByRole('heading', { name: 'Appearance' })
          .boundingBox())!;
        assert.ok(
          Math.abs(title.x - body.x) <= 1,
          'header aligns with the body',
        );
      };
      await checkHeaderAlignment();

      const dragTo = async (x: number) => {
        const box = (await separator.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(x, box.y + 100, { steps: 5 });
        await page.mouse.up();
      };
      await dragTo(900);
      assert.equal((await navigation.boundingBox())!.width, 480);
      assert.deepEqual(await position(), initial);
      await checkSidebarColumn();
      await checkHeaderAlignment();
      await dragTo(20);
      assert.equal((await navigation.boundingBox())!.width, 240);
      assert.deepEqual(await position(), initial);
      await checkSidebarColumn();

      await separator.focus();
      await separator.press('ArrowRight');
      assert.equal((await navigation.boundingBox())!.width, 250);
      await separator.press('End');
      assert.equal((await navigation.boundingBox())!.width, 480);
      await separator.press('Home');
      assert.equal((await navigation.boundingBox())!.width, 240);
      await separator.press('Shift+ArrowRight');
      assert.equal((await navigation.boundingBox())!.width, 280);

      await page
        .getByRole('button', { name: 'Close sidebar', exact: true })
        .click();
      assert.equal((await navigation.boundingBox())!.height, 48);
      assert.equal(
        await navigation.locator('.sidebar-content').isVisible(),
        false,
      );
      assert.equal(
        await navigation
          .getByRole('button', { name: 'Open sidebar', exact: true })
          .count(),
        1,
      );
      assert.equal(await separator.count(), 0);
      assert.deepEqual(await position(), initial);
      assert.equal((await page.locator('.chat-main').boundingBox())!.x, 0);
      await checkHeaderAlignment();
      assert.equal(
        await navigation.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        ),
        await page
          .locator('.chat-main')
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      );
      await page.reload();
      await page.getByRole('heading', { name: 'Appearance' }).waitFor();
      assert.equal((await navigation.boundingBox())!.height, 48);
      assert.equal(
        await navigation.locator('.sidebar-content').isVisible(),
        false,
      );
      await page
        .getByRole('button', { name: 'Open sidebar', exact: true })
        .click();
      assert.equal((await navigation.boundingBox())!.width, 280);
      assert.deepEqual(await position(), initial);

      await page.setViewportSize({ width: 800, height: 900 });
      await page.waitForFunction(
        () =>
          document
            .querySelector('[aria-label="Resize sidebar"]')
            ?.getAttribute('aria-valuemax') === '400',
      );
      await separator.focus();
      await separator.press('End');
      assert.equal((await navigation.boundingBox())!.width, 400);
      assert.equal(
        (await page.locator('.chat-main').boundingBox())!.width,
        400,
      );
      await page.setViewportSize({ width: 760, height: 900 });
      await page.waitForFunction(
        () =>
          document
            .querySelector('[aria-label="Resize sidebar"]')
            ?.getAttribute('aria-valuemax') === '360',
      );
      assert.equal((await navigation.boundingBox())!.width, 360);

      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .getByRole('button', { name: 'Conversations', exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Conversations',
        exact: true,
      });
      await dialog.waitFor();
      await dialog
        .getByRole('link', { name: 'Durable Factory', exact: true })
        .waitFor();
      await dialog
        .getByRole('button', { name: 'Close sidebar', exact: true })
        .click();
      assert.equal(await dialog.isVisible(), false);
      await page
        .getByRole('button', { name: 'Conversations', exact: true })
        .click();
      await page.keyboard.press('Escape');
      assert.equal(await dialog.isVisible(), false);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'planning keeps the header aligned with the conversation at every sidebar width',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-planning-header-'));
    const service = await startService({
      dataDir,
      port: 0,
      chat: planningFixture(),
    });
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
        'A long planning conversation title that must stay aligned and fit in the conversation header',
        'planning-header',
      );
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      await page.goto(`${service.url}/?conversation=${conversation.id}`);
      await page.getByLabel('Message', { exact: true }).fill('plan');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page
        .getByText(
          'Here is the saved plan. Should I create this GitHub issue?',
          { exact: true },
        )
        .waitFor();

      const branding = () => page.locator('.chat-brand').boundingBox();
      const initialBranding = await branding();
      const checkHeader = async () => {
        const layout = await page.evaluate(() => {
          const [title, tag, header, branding] = [
            '.chat-header h1',
            '.mode-tag',
            '.chat-header',
            '.sidebar-toggle',
          ].map((selector) =>
            document.querySelector(selector)!.getBoundingClientRect(),
          );
          const transcript = document.querySelector('.transcript')!;
          const contentLeft =
            transcript.getBoundingClientRect().left +
            parseFloat(getComputedStyle(transcript).paddingLeft);
          const closed = document
            .querySelector('.chat-shell')!
            .classList.contains('sidebar-collapsed');
          return {
            titleLeft: title.left,
            titleRight: title.right,
            tagLeft: tag.left,
            tagRight: tag.right,
            headerHeight: header.height,
            contentLeft,
            closed,
            brandingRight: branding.right,
          };
        });
        if (!layout.closed || layout.contentLeft >= 272) {
          assert.ok(
            Math.abs(layout.titleLeft - layout.contentLeft) <= 1,
            'title follows the conversation content as the sidebar changes',
          );
        }
        assert.ok(layout.titleLeft > layout.brandingRight);
        assert.ok(layout.titleRight <= layout.tagLeft);
        assert.ok(layout.tagRight <= 1440);
        assert.equal(layout.headerHeight, 48);
        assert.deepEqual(await branding(), initialBranding);
      };
      for (const state of ['default', 'widest', 'narrowest', 'collapsed']) {
        if (state === 'widest' || state === 'narrowest') {
          const separator = page.getByRole('separator', {
            name: 'Resize sidebar',
          });
          await separator.focus();
          await separator.press(state === 'widest' ? 'End' : 'Home');
        } else if (state === 'collapsed') {
          await page
            .getByRole('button', { name: 'Close sidebar', exact: true })
            .click();
        }
        await checkHeader();
        assert.equal(
          await page.locator('.ticket-panel, .ticket-toggle').count(),
          0,
        );
      }
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
