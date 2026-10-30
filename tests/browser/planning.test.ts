import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startService } from '../helpers/credentials.js';
import { ChatClient } from '../../packages/shared/src/index.js';
import { configure } from '../fixtures/chat.js';
import { FakeGitHub, planningFixture } from '../fixtures/planning.js';

test(
  'browser keeps planning in chat without ticket panels, accepts approval, and restores issue controls',
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
        .getByText(
          'Here is the saved plan. Should I create this GitHub issue?',
          { exact: true },
        )
        .waitFor();
      const assertNoTicket = async () => {
        assert.equal(
          await page.locator('.ticket-panel, .planning-ticket').count(),
          0,
        );
        assert.equal(
          await page
            .getByRole('button', { name: /^(Show|Hide) ticket$/ })
            .count(),
          0,
        );
        assert.equal(
          await page.getByRole('dialog', { name: 'Saved ticket' }).count(),
          0,
        );
      };
      await assertNoTicket();
      const proposal = page.locator('.tool-card').filter({
        has: page.locator('summary strong', { hasText: 'propose_issue' }),
      });
      await proposal.locator('summary').click();
      await proposal
        .locator('pre')
        .filter({ hasText: '## Regression proof' })
        .waitFor();
      assert.equal(github.calls, 0);
      await page.getByLabel('Message', { exact: true }).fill('yes');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page.getByText('Issue: uncertain', { exact: true }).waitFor();
      await page
        .getByRole('button', { name: 'Retry reconciliation', exact: true })
        .click();
      await page.getByRole('link', { name: 'View issue #1' }).waitFor();
      await assertNoTicket();
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
      await page.getByRole('link', { name: 'View issue #1' }).waitFor();
      await assertNoTicket();
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
      await assertNoTicket();
      await page.screenshot({
        path: resolve('test-results/planning-tablet.png'),
        fullPage: true,
      });
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
