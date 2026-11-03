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
      // The context card is there before any message or saved draft exists.
      const emptyTrails = page.locator('#page-information');
      await emptyTrails
        .getByRole('region', { name: 'Planning context', exact: true })
        .waitFor();
      assert.deepEqual(
        await emptyTrails
          .locator('[data-card-id]')
          .evaluateAll((cards) =>
            cards.map((card) => card.getAttribute('data-card-id')),
          ),
        ['planning-context'],
      );
      assert.equal(await page.locator('.tool-card').count(), 0);
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
      const trails = page.locator('#page-information');
      await trails
        .getByRole('region', { name: 'Planning context', exact: true })
        .waitFor();
      assert.equal(await trails.locator('[data-card-id]').count(), 1);
      assert.match(await trails.innerText(), /example\/project/);
      assert.match(await trails.innerText(), /New issue/);
      assert.equal(
        await trails
          .getByRole('region', { name: 'Ticket information' })
          .count(),
        0,
      );
      const proposal = page.locator('.tool-card').filter({
        has: page.locator('.tool-name', { hasText: 'propose_issue' }),
      });
      await proposal.waitFor({ state: 'attached' });
      const activity = page.locator('.tool-group').filter({ has: proposal });
      if (await activity.count())
        await activity.locator(':scope > summary').click();
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
      // Later settings changes must not replace the captured repository.
      const elsewhere = join(directory, 'elsewhere');
      await mkdir(elsewhere);
      execFileSync('git', ['init', '-q', elsewhere]);
      const changed = await client.settings();
      changed.settings.repository = {
        path: elsewhere,
        github: 'example/changed',
        baseBranch: 'develop',
      };
      await client.saveSettings({
        expectedRevision: changed.revision,
        settings: changed.settings,
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
      const restored = page.locator('#page-information');
      await restored
        .getByRole('region', { name: 'Planning context', exact: true })
        .waitFor();
      for (const expected of ['example/project', repo, 'main', 'New issue'])
        assert.ok(
          (await restored.innerText()).includes(expected),
          `restored context shows ${expected}`,
        );
      assert.ok(!(await restored.innerText()).includes('example/changed'));
      assert.equal(await restored.locator('[data-card-id]').count(), 1);
      // The shared controls hide and show the desktop panel.
      await page
        .getByRole('button', { name: 'Hide chat trails', exact: true })
        .click();
      assert.equal(await restored.getAttribute('aria-hidden'), 'true');
      await page
        .getByRole('button', { name: 'Show chat trails', exact: true })
        .click();
      assert.equal(await restored.getAttribute('aria-hidden'), 'false');
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
      for (const width of [390, 320, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        await page
          .getByRole('button', { name: 'Show chat trails', exact: true })
          .click();
        const overlay = page.getByRole('dialog', {
          name: 'Chat trails',
          exact: true,
        });
        await overlay
          .getByRole('region', { name: 'Planning context', exact: true })
          .waitFor();
        assert.equal(await overlay.locator('[data-card-id]').count(), 1);
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${width}px open overlay has no page overflow`,
        );
        assert.ok(
          await overlay.evaluate((el) => el.scrollWidth <= el.clientWidth),
          `${width}px overlay content fits`,
        );
        await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' });
      }
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
