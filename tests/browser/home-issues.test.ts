import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { issuesFixture } from '../fixtures/issues.js';

const launch = () =>
  chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });

test(
  'Home lists issues per project, edits the selected issue in planning, and opens its implementation',
  { timeout: 45000 },
  async () => {
    const fixture = await issuesFixture();
    const browser = await launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(7000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(fixture.service.url);
      const alpha = page
        .locator('.home')
        .getByRole('region', { name: 'Alpha issues', exact: true });
      const beta = page
        .locator('.home')
        .getByRole('region', { name: 'Beta issues', exact: true });
      await alpha.getByText('Find saved work', { exact: true }).waitFor();
      await beta
        .getByText('Update the project dashboard', { exact: true })
        .waitFor();
      assert.equal(await alpha.locator('.home-issues li').count(), 2);
      assert.equal(await beta.locator('.home-issues li').count(), 1);
      await alpha
        .getByRole('button', { name: 'Load more issues', exact: true })
        .click();
      await alpha
        .getByText(
          'A longer issue title that must wrap neatly on a small screen',
          { exact: true },
        )
        .waitFor();
      // A lost response must reuse the conversation that was already created.
      await page.route(
        `**/projects/${fixture.beta.id}/issues/1/planning`,
        async (route) => {
          await route.fetch();
          await route.abort('failed');
        },
      );
      await beta
        .getByRole('button', { name: 'Edit issue #1', exact: true })
        .click();
      await beta.getByRole('alert').waitFor();
      assert.equal(
        (await fixture.chat(fixture.beta.id).conversations()).conversations
          .length,
        1,
      );
      await page.unroute(`**/projects/${fixture.beta.id}/issues/1/planning`);
      await page.reload();
      await beta
        .getByRole('button', { name: 'Edit issue #1', exact: true })
        .click();
      await page
        .getByRole('heading', {
          name: 'Edit #1 · Update the project dashboard',
          exact: true,
        })
        .waitFor();
      await page
        .locator('.transcript')
        .getByText(
          /We are editing existing GitHub issue #1: Update the project dashboard/,
        )
        .waitFor();
      assert.equal(fixture.github.repository('example/beta').updates, 0);
      await page.getByLabel('Message', { exact: true }).fill('plan');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page
        .locator('.tool-card summary strong')
        .getByText('propose_issue', { exact: true })
        .waitFor();
      await page.getByLabel('Message', { exact: true }).fill('update it');
      await page.getByRole('button', { name: /^Send/ }).click();
      await page.getByText('Issue: updated', { exact: true }).waitFor();
      assert.equal(fixture.github.repository('example/beta').updates, 1);
      assert.equal(fixture.github.repository('example/beta').calls, 1);
      assert.equal(fixture.github.repository('example/alpha').updates, 0);
      await page.getByRole('link', { name: 'Home', exact: true }).click();
      await beta
        .getByRole('button', {
          name: 'Start simulated run for issue #1',
          exact: true,
        })
        .click();
      await page
        .getByRole('region', { name: 'Information', exact: true })
        .waitFor();
      const run = (await fixture.workflow(fixture.beta.id).workflow()).runs[0];
      assert.equal(run.projectId, fixture.beta.id);
      assert.equal(run.repository.github, 'example/beta');
      assert.equal(
        new URL(page.url()).searchParams.get('conversation'),
        run.developerConversationId,
      );
      await page.getByRole('link', { name: 'Home', exact: true }).click();
      await beta
        .getByRole('button', {
          name: 'Open implementation for issue #1',
          exact: true,
        })
        .click();
      await page
        .getByRole('region', { name: 'Information', exact: true })
        .waitFor();
      assert.equal(
        (await fixture.workflow(fixture.beta.id).workflow()).runs.length,
        1,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
);

test(
  'Home issue lists recover from loading errors and fit desktop/mobile in both themes',
  { timeout: 30000 },
  async () => {
    const fixture = await issuesFixture();
    const browser = await launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(7000);
      let fail = true;
      await page.route('**/projects/default/issues?*', async (route) => {
        if (fail)
          await route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'PROVIDER_UNAVAILABLE',
                message: 'Reconnect GitHub in Settings.',
              },
            },
          });
        else await route.continue();
      });
      await page.goto(fixture.service.url);
      const alpha = page
        .locator('.home')
        .getByRole('region', { name: 'Alpha issues', exact: true });
      await alpha
        .getByRole('alert')
        .getByText('Reconnect GitHub in Settings.', { exact: true })
        .waitFor();
      fail = false;
      await alpha.getByRole('button', { name: 'Refresh', exact: true }).click();
      await alpha.getByText('Find saved work', { exact: true }).waitFor();
      await alpha
        .getByRole('button', { name: 'Load more issues', exact: true })
        .click();
      await alpha
        .getByText(
          'A longer issue title that must wrap neatly on a small screen',
          { exact: true },
        )
        .waitFor();
      await mkdir('test-results', { recursive: true });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.evaluate(
          (theme) => localStorage.setItem('factory.theme.v1', theme),
          colorScheme,
        );
        await page.reload();
        await alpha
          .getByRole('button', { name: 'Load more issues', exact: true })
          .click();
        await alpha
          .getByText(
            'A longer issue title that must wrap neatly on a small screen',
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await page.locator('html').getAttribute('data-theme'),
          colorScheme,
        );
        for (const width of [1440, 1024, 390, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          const bounds = await page.locator('.home').evaluate((home) => ({
            overflow: home.scrollWidth > home.clientWidth,
            clipped: Array.from(
              home.querySelectorAll('button, .home-issue-title'),
            ).some((el) => {
              const rect = el.getBoundingClientRect();
              return rect.left < 0 || rect.right > innerWidth;
            }),
          }));
          assert.deepEqual(
            bounds,
            { overflow: false, clipped: false },
            `${colorScheme}, ${width}px`,
          );
          if (width === 1440 || width === 390)
            await page.screenshot({
              path: `test-results/home-issues-${colorScheme}-${width}.png`,
            });
        }
      }
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
);
