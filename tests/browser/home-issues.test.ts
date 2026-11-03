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
      const proposal = page.locator('.tool-card').filter({
        has: page.locator('.tool-name', { hasText: 'propose_issue' }),
      });
      await proposal.waitFor({ state: 'attached' });
      const activity = page.locator('.tool-group').filter({ has: proposal });
      if (await activity.count())
        await activity.locator(':scope > summary').click();
      await proposal
        .locator('summary')
        .getByText('Proposed issue', { exact: true })
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
  'existing-issue planning shows captured source issue in Chat trails, switches, restores and never refetches',
  { timeout: 90000 },
  async () => {
    const fixture = await issuesFixture();
    const browser = await launch();
    try {
      const remote = fixture.github.repository('example/beta');
      const longToken = 'x'.repeat(200);
      remote.issues[0].body = [
        '# Source heading',
        '',
        `Full body paragraph with **bold** text ${longToken}`,
        '',
        '<script>window.__pwned = true</script>',
        '<img src="x" onerror="window.__pwned = true">',
        '[unsafe](javascript:window.__pwned=true)',
        '',
        '```',
        `${'code '.repeat(60)}`,
        '```',
        '',
        '| a | b |',
        '| - | - |',
        `| ${longToken} | ${longToken} |`,
        '',
        'Final line of the source body.',
      ].join('\n');
      const createsBefore = remote.calls;
      let reads = 0;
      const getIssue = remote.getIssue.bind(remote);
      remote.getIssue = async (...args) => {
        reads++;
        return getIssue(...args);
      };
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(7000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(fixture.service.url);
      const betaHome = page
        .locator('.home')
        .getByRole('region', { name: 'Beta issues', exact: true });
      await betaHome
        .getByText('Update the project dashboard', { exact: true })
        .waitFor();
      await betaHome
        .getByRole('button', { name: 'Edit issue #1', exact: true })
        .click();
      const trails = page.locator('#page-information');
      const cardIds = () =>
        trails
          .locator('[data-card-id]')
          .evaluateAll((cards) =>
            cards.map((card) => card.getAttribute('data-card-id')),
          );
      const ticket = trails.getByRole('region', {
        name: 'Ticket information',
        exact: true,
      });
      await ticket.waitFor();
      // Nothing was sent or saved: the cards come from the captured snapshot.
      assert.equal(await page.locator('.tool-card').count(), 0);
      assert.deepEqual(await cardIds(), [
        'planning-context',
        'planning-ticket-information',
      ]);
      const context = trails.getByRole('region', {
        name: 'Planning context',
        exact: true,
      });
      const contextText = await context.innerText();
      for (const expected of ['Beta', 'example/beta', 'main', 'Existing issue'])
        assert.ok(contextText.includes(expected), expected);
      assert.ok(contextText.includes('beta'), 'local path');
      const checkTicket = async () => {
        const text = (await ticket.innerText()).replace(
          'Captured source issue',
          'captured source issue',
        );
        for (const expected of [
          'captured source issue',
          'not an unsaved proposal',
          'Open',
          'Update the project dashboard',
          'Final line of the source body.',
        ])
          assert.ok(text.includes(expected), expected);
        const link = ticket.getByRole('link', { name: 'Issue #1' });
        assert.equal(
          await link.getAttribute('href'),
          'https://github.com/example/beta/issues/1',
        );
        await ticket
          .getByRole('heading', { name: 'Source heading', exact: true })
          .waitFor();
        assert.equal(await ticket.locator('script, img').count(), 0);
        assert.equal(await ticket.locator('[onerror]').count(), 0);
        assert.equal(await ticket.locator('a[href^="javascript:"]').count(), 0);
        assert.equal(
          await page.evaluate(
            () => (window as unknown as { __pwned?: boolean }).__pwned,
          ),
          undefined,
        );
      };
      await checkTicket();
      const readsAfterOpen = reads;
      // A later GitHub or settings change does not alter the captured card.
      remote.issues[0].body = 'Changed on GitHub.';
      remote.details.set(1, {
        title: 'Changed title',
        updatedAt: '2026-02-01T00:00:00.000Z',
        state: 'open',
      });

      // Open the real cards at every width with long content.
      for (const width of [1440, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        let container = trails;
        if (width < 1200) {
          await page
            .getByRole('button', { name: 'Show chat trails', exact: true })
            .click();
          container = page.getByRole('dialog', {
            name: 'Chat trails',
            exact: true,
          });
          await container
            .getByRole('region', { name: 'Ticket information', exact: true })
            .waitFor();
        }
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${width}px: no page overflow`,
        );
        assert.ok(
          await container.evaluate((el) => el.scrollWidth <= el.clientWidth),
          `${width}px: card content fits`,
        );
        assert.equal(
          await container.evaluate(
            (el) =>
              Array.from(el.querySelectorAll('.page-card')).filter((card) => {
                const rect = card.getBoundingClientRect();
                return rect.left < 0 || rect.right > innerWidth;
              }).length,
          ),
          0,
          `${width}px: cards inside viewport`,
        );
        if (width < 1200) {
          await page.keyboard.press('Escape');
          await container.waitFor({ state: 'detached' });
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 });

      // Hide and show use the shared controls and never refetch.
      await page
        .getByRole('button', { name: 'Hide chat trails', exact: true })
        .click();
      assert.equal(await trails.getAttribute('aria-hidden'), 'true');
      await page
        .getByRole('button', { name: 'Show chat trails', exact: true })
        .click();
      assert.equal(await trails.getAttribute('aria-hidden'), 'false');

      // A second, new-issue conversation shows only its own context.
      await page
        .locator('.chat-sidebar')
        .getByRole('button', { name: 'Start a chat in Beta', exact: true })
        .click();
      await page
        .getByRole('heading', { name: 'New planning conversation' })
        .waitFor();
      await trails
        .getByRole('region', { name: 'Planning context', exact: true })
        .waitFor();
      assert.deepEqual(await cardIds(), ['planning-context']);
      assert.ok((await trails.innerText()).includes('New issue'));
      assert.ok(!(await trails.innerText()).includes('Update the project'));
      assert.equal(await ticket.count(), 0);

      // Switching back restores the source issue from persisted state.
      await page
        .locator('.chat-sidebar .session-link', {
          hasText: 'Edit #1 · Update the project dashboard',
        })
        .click();
      await ticket.waitFor();
      assert.deepEqual(await cardIds(), [
        'planning-context',
        'planning-ticket-information',
      ]);
      await checkTicket();
      await page.reload();
      await ticket.waitFor();
      await checkTicket();
      assert.deepEqual(await cardIds(), [
        'planning-context',
        'planning-ticket-information',
      ]);

      assert.equal(reads, readsAfterOpen, 'cards never fetch the issue');

      // Leaving planning removes the cards.
      await page.getByRole('link', { name: 'Home', exact: true }).click();
      await betaHome.waitFor();
      assert.equal(await page.locator('#page-information').count(), 0);
      assert.equal(
        await page
          .getByRole('button', { name: /chat trails$/, exact: false })
          .count(),
        0,
      );

      // Only the explicit planning start fetched the issue; nothing wrote.
      assert.ok(readsAfterOpen >= 1);
      assert.equal(remote.updates, 0);
      assert.equal(remote.calls, createsBefore);
      assert.equal(
        (await fixture.workflow(fixture.beta.id).workflow()).runs.length,
        0,
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
