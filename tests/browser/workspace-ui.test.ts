import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startService } from '../helpers/credentials.js';
import { ChatClient } from '../../packages/shared/src/index.js';
import { fixture, configure, until } from '../fixtures/chat.js';
import { fauxAssistantMessage } from '../../apps/server/src/chat-fixtures.js';
import { workflowFixture } from '../fixtures/workflow.js';
import { simulationAdapter } from '../../apps/server/src/workflow.js';

const launch = () =>
  chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });

test(
  'feature starters, compact session rows, full-row selection, and Delete survive pointer and keyboard input',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-workspace-ui-'));
    const deps = fixture();
    const service = await startService({ dataDir, port: 0, chat: deps });
    const browser = await launch();
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const c = await client.createConversation(
        'New planning conversation',
        'new',
      );
      await client.createConversation(
        'A very long feature planning conversation title that must fit on a single line in the project sidebar',
        'long',
      );
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(7000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${service.url}/?conversation=${c.id}`);
      await page
        .getByRole('heading', { name: 'What feature would you like to plan?' })
        .waitFor();
      assert.equal(
        await page.locator('.chat-header .header-project').count(),
        0,
      );
      await page
        .locator('.chat-header .mode-tag', { hasText: 'Planning' })
        .waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: 'Explore this repository' })
          .count(),
        0,
      );
      await page
        .getByRole('button', { name: 'Plan a feature', exact: true })
        .click();
      assert.equal(
        await page.getByLabel('Message', { exact: true }).inputValue(),
        'I’d like to plan a new feature: ',
      );
      assert.equal(await page.locator('.starter-prompts').count(), 0);
      assert.equal(
        (await client.history(c.id)).entries.length,
        0,
        'starter does not submit',
      );
      await page.reload();
      assert.equal(
        await page.getByLabel('Message', { exact: true }).inputValue(),
        'I’d like to plan a new feature: ',
      );
      await page.getByLabel('Message', { exact: true }).fill('');
      const geometry = await page
        .locator('.chat-navigation-row')
        .evaluateAll((rows) =>
          rows.map((row) => {
            const link = row.querySelector('.session-link')!;
            const title = link.querySelector('strong')!;
            const icon = link.querySelector('.session-kind')!;
            const dots = row.querySelector('.session-actions-trigger')!;
            const parent = row.closest('nav')!;
            const projectTitle = row
              .closest('.project-group')!
              .querySelector('.project-toggle strong')!;
            return {
              titleOffset:
                title.getBoundingClientRect().left -
                projectTitle.getBoundingClientRect().left,
              rowHeight: row.getBoundingClientRect().height,
              iconAfter:
                icon.getBoundingClientRect().left >=
                title.getBoundingClientRect().right,
              dotsCenter:
                dots.getBoundingClientRect().top +
                dots.getBoundingClientRect().height / 2,
              titleCenter:
                title.getBoundingClientRect().top +
                title.getBoundingClientRect().height / 2,
              gap: getComputedStyle(parent).gap,
              treeBorder: getComputedStyle(row.closest('.project-body')!)
                .borderLeftWidth,
              shadow: getComputedStyle(link).boxShadow,
              selected: row.classList.contains('selected-session'),
              background: getComputedStyle(row).backgroundColor,
              dotsBackground: getComputedStyle(dots).backgroundColor,
              overflow: getComputedStyle(title).textOverflow,
            };
          }),
        );
      assert.equal(geometry.length, 2);
      for (const g of geometry) {
        assert.equal(g.rowHeight, 36);
        assert.ok(
          Math.abs(g.titleOffset) < 1,
          'session and project titles align',
        );
        assert.ok(g.iconAfter);
        assert.ok(Math.abs(g.dotsCenter - g.titleCenter) <= 1);
        assert.equal(g.gap, '4px');
        assert.equal(g.treeBorder, '0px');
        assert.equal(g.shadow, 'none');
        assert.equal(g.overflow, 'ellipsis');
      }
      assert.notEqual(
        geometry.find((g) => g.selected)?.background,
        'rgba(0, 0, 0, 0)',
      );
      const trigger = page.getByRole('button', {
        name: 'Actions for New planning conversation',
        exact: true,
      });
      await trigger.click();
      const remove = page.getByRole('button', {
        name: 'Delete New planning conversation',
        exact: true,
      });
      // Safari can blur a button to the page before delivering its click.
      await remove.dispatchEvent('focusout', { relatedTarget: null });
      await remove.click();
      const dialog = page.getByRole('dialog', {
        name: 'Delete chat',
        exact: true,
      });
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await trigger.press('Enter');
      await remove.press('Escape');
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.ok(await trigger.evaluate((el) => el === document.activeElement));
      await trigger.click();
      await page
        .getByRole('heading', { name: 'What feature would you like to plan?' })
        .click();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      await mkdir(resolve('test-results'), { recursive: true });
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 844 });
        if (width < 760)
          await page
            .getByRole('button', { name: 'Conversations', exact: true })
            .click();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        await page.screenshot({
          path: resolve(`test-results/workspace-${width}.png`),
        });
        if (width < 760)
          await page
            .getByRole('button', { name: 'Close conversations', exact: true })
            .click();
      }
      await page
        .getByLabel('Message', { exact: true })
        .fill('Plan a new dashboard feature');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page.locator('.message').first().waitFor();
      assert.equal(await page.locator('.empty-planning').count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'general settings save an optional title model, warn on unsaved edits, show subscription controls, and update titles live',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), 'factory-settings-titles-ui-'),
    );
    const deps = fixture();
    deps.models.completeSimple = async () =>
      fauxAssistantMessage('Plan dashboard feature');
    const service = await startService({ dataDir, port: 0, chat: deps });
    const browser = await launch();
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(7000);
      await page.goto(`${service.url}/settings`);
      await page.getByLabel('Title provider').selectOption('requesty');
      await page.getByLabel('Title model', { exact: true }).fill('offline');
      let warned = false;
      page.once('dialog', async (d) => {
        warned = true;
        await d.dismiss();
      });
      await page.getByRole('link', { name: 'Home', exact: true }).click();
      assert.ok(warned);
      assert.ok(page.url().endsWith('/settings'));
      await page
        .getByRole('button', { name: 'Save title generator', exact: true })
        .click();
      await page
        .getByRole('status')
        .filter({ hasText: 'Title generator saved.' })
        .waitFor();
      assert.equal((await client.titleGenerator()).selection?.model, 'offline');
      await page.reload();
      assert.equal(
        await page.getByLabel('Title model', { exact: true }).inputValue(),
        'offline',
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'Connect ChatGPT', exact: true })
          .isEnabled(),
        true,
      );
      await page
        .getByText('Secure storage is ready.', { exact: false })
        .waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: resolve('test-results/general-settings-mobile.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      const c = await client.createConversation(
        'New planning conversation',
        'ai-ui',
      );
      await page.goto(`${service.url}/?conversation=${c.id}`);
      await page
        .getByLabel('Message', { exact: true })
        .fill('Add a dashboard to the project');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page
        .locator('.chat-header')
        .getByRole('heading', { name: 'Plan dashboard feature', exact: true })
        .waitFor();
      await page
        .locator('.session-link strong', { hasText: 'Plan dashboard feature' })
        .waitFor();
      await page.getByRole('link', { name: 'Home', exact: true }).click();
      await page
        .locator('.home-recent strong', { hasText: 'Plan dashboard feature' })
        .waitFor();
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'Home prioritizes attention and in-progress runs without duplicating recent items',
  { timeout: 30000 },
  async () => {
    const adapter = simulationAdapter(),
      execute = adapter.execute;
    adapter.execute = (run, attempt, signal) =>
      attempt.stage === 'developer'
        ? new Promise(() => {})
        : execute(run, attempt, signal);
    const f = await workflowFixture(adapter);
    const browser = await launch();
    try {
      const first = await f.issue('first');
      const a = await f.client.startRun(first, 'first-run');
      await until(
        () => f.client.run(a.id),
        (r) => r.stage === 'developer',
      );
      await f.client.command(a.id, {
        action: 'pause',
        operationId: 'pause-first',
        expectedRevision: (await f.client.run(a.id)).revision,
      });
      await until(
        () => f.client.run(a.id),
        (r) => r.status === 'paused',
      );
      const second = await f.issue('second');
      const b = await f.client.startRun(second, 'second-run');
      await until(
        () => f.client.run(b.id),
        (r) => r.stage === 'developer',
      );
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(7000);
      await page.goto(f.service.url);
      await page
        .getByRole('heading', { name: 'Your workspace', exact: true })
        .waitFor();
      await page
        .getByRole('region', { name: 'Needs attention' })
        .getByText('Paused', { exact: true })
        .waitFor();
      await page
        .getByRole('region', { name: 'In progress' })
        .getByText('Running', { exact: true })
        .waitFor();
      assert.deepEqual(await page.locator('.home-section').allTextContents(), [
        'Needs attention',
        'In progress',
        'Recent activity',
        'Projects',
      ]);
      assert.equal(
        await page
          .getByRole('region', { name: 'Recent activity' })
          .locator('.run-status-badge')
          .count(),
        0,
      );
      await page.screenshot({
        path: resolve('test-results/home-active.png'),
        fullPage: true,
      });
    } finally {
      await browser.close();
      await f.close();
    }
  },
);
