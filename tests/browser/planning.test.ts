import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startService } from '../../apps/server/src/service.js';
import { ChatClient } from '../../packages/shared/src/index.js';
import { configure } from '../fixtures/chat.js';
import { FakeGitHub, planningFixture } from '../fixtures/planning.js';

test(
  'browser presents the saved proposal, accepts chat approval, restores issue link, and validates GitHub',
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'factory-planning-browser-'),
    );
    const repo = join(directory, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
    const github = new FakeGitHub();
    github.mode = 'lost';
    let service = await startService({
      dataDir: join(directory, 'data'),
      port: 0,
      chat: planningFixture(),
      github,
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
      const saved = await client.settings();
      saved.settings.repository = {
        path: repo,
        github: 'example/project',
        baseBranch: 'main',
      };
      await client.saveSettings({
        expectedRevision: saved.revision,
        settings: saved.settings,
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(service.url);
      await page.getByRole('button', { name: /^Start a chat in/ }).click();
      await page.getByLabel('Message', { exact: true }).fill('plan');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page
        .getByText('Saved ticket · revision 1', { exact: true })
        .waitFor();
      await page
        .getByRole('heading', { name: 'Regression proof', exact: true })
        .waitFor();
      await page
        .getByText('AC-1: Results link to matching files', { exact: true })
        .waitFor();
      await page
        .getByText('Complete proposed GitHub issue body', { exact: true })
        .click();
      await page
        .locator('.planning-ticket pre')
        .filter({ hasText: '## Regression proof' })
        .waitFor();
      await page
        .getByText(
          'Should I create this GitHub issue? Reply “yes” in chat, or describe changes.',
          { exact: true },
        )
        .waitFor();
      assert.equal(github.calls, 0);
      await page.getByLabel('Message', { exact: true }).fill('yes');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page.getByText('Issue: uncertain', { exact: true }).waitFor();
      await page
        .getByRole('button', { name: 'Retry reconciliation', exact: true })
        .click();
      await page.getByRole('link', { name: 'View issue #1' }).waitFor();
      await page
        .getByRole('button', { name: 'Hide ticket', exact: true })
        .click();
      assert.equal(await page.locator('.ticket-panel').isVisible(), false);
      await page
        .getByRole('button', { name: 'Show ticket', exact: true })
        .click();
      assert.equal(github.calls, 1);
      await mkdir(resolve('test-results'), { recursive: true });
      await page.screenshot({
        path: resolve('test-results/planning-desktop.png'),
        fullPage: true,
      });
      const port = service.port;
      await service.close();
      service = await startService({
        dataDir: join(directory, 'data'),
        port,
        chat: planningFixture(),
        github,
      });
      await page.reload();
      await page.getByRole('link', { name: 'View issue #1' }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.ticket-panel').waitFor({ state: 'detached' });
      assert.equal(
        await page.getByRole('link', { name: 'View issue #1' }).isVisible(),
        false,
      );
      const ticketTrigger = page.getByRole('button', {
        name: 'Show ticket',
        exact: true,
      });
      await ticketTrigger.click();
      const dialog = page.getByRole('dialog', { name: 'Saved ticket' });
      await dialog.getByRole('link', { name: 'View issue #1' }).waitFor();
      await dialog.getByRole('button', { name: 'Close saved ticket' }).focus();
      await page.keyboard.press('Shift+Tab');
      assert.ok(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      );
      await page.keyboard.press('Escape');
      assert.ok(
        await ticketTrigger.evaluate(
          (element) => element === document.activeElement,
        ),
      );
      await page
        .getByRole('button', { name: 'Conversations', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Conversations' })
        .getByRole('button', { name: /^Start a chat in/ })
        .waitFor();
      await page.keyboard.press('Escape');
      await page
        .getByRole('button', { name: /^Send/ })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve('test-results/planning-mobile.png'),
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      );
      await page.setViewportSize({ width: 1024, height: 900 });
      await page
        .getByRole('button', { name: 'Show ticket', exact: true })
        .click();
      await page.screenshot({
        path: resolve('test-results/planning-tablet.png'),
        fullPage: true,
      });
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 320, height: 700 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.goto(`${service.url}/projects/default/settings`);
      await page
        .getByRole('button', {
          name: 'Validate GitHub repository',
          exact: true,
        })
        .click();
      await page
        .getByText('Readable; write access unverified.', { exact: true })
        .waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
