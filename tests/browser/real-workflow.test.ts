import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { realFixture } from '../fixtures/real.js';
import { until } from '../fixtures/chat.js';
async function openDetails(page: Page, name = 'Details') {
  if (
    (page.viewportSize()?.width ?? 1280) < 1200 &&
    !(await page
      .getByRole('dialog', { name: 'Run information', exact: true })
      .isVisible())
  )
    await page
      .getByRole('button', { name: 'Run information', exact: true })
      .click();
  if (name === 'Details') {
    for (const summary of await page.locator('.page-card > summary').all())
      if (
        await summary.evaluate((el) => !el.parentElement!.hasAttribute('open'))
      )
        await summary.click();
  }
}

test(
  'browser starts a real issue, shows readable run details and its verified PR across viewports',
  { timeout: 60000 },
  async () => {
    const fixture = await realFixture({
      checkCommand:
        "node -e \"require('node:fs').readFileSync('value.txt'); console.log('Required gate passed')\"",
    });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await fixture.client.startIssue(7, crypto.randomUUID());
      await page.goto(fixture.service.url);
      const run = await until(
        async () => {
          const state = await fixture.client.workflow();
          return state.runs[0];
        },
        (r) => Boolean(r) && ['pr_ready', 'needs_input'].includes(r.status),
        30000,
      );
      assert.equal(run.status, 'pr_ready');
      await page.goto(
        `${fixture.service.url}/?conversation=${run.developerConversationId}`,
      );
      await openDetails(page);
      await page
        .getByRole('region', { name: 'Run progress', exact: true })
        .waitFor();
      assert.deepEqual(
        await page.locator('.page-card-heading h2').allTextContents(),
        ['Run progress', 'Run controls', 'Models', 'Usage', 'Configuration'],
      );
      assert.ok(
        run.evidence.some(
          (evidence) => evidence.kind === 'reviewer' && evidence.passed,
        ),
      );
      assert.match(run.publication!.payload!.body, /Acceptance criteria/);
      await page
        .getByRole('link', { name: 'Open pull request', exact: true })
        .waitFor();
      await page.getByText('Real execution', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Developer guidance').count(), 0);
      assert.equal(
        await page
          .getByRole('link', { name: 'Open pull request', exact: true })
          .getAttribute('href'),
        'https://github.com/example/project/pull/9',
      );
      const check = page
        .locator('.implementation-events .run-event')
        .filter({
          has: page.getByText(run.configuration.requiredChecks[0], {
            exact: true,
          }),
        })
        .last();
      await check.locator('.command-output > summary').click();
      await page.getByText('Required gate passed', { exact: true }).waitFor();
      await mkdir(resolve('test-results'), { recursive: true });
      await page.screenshot({
        path: resolve('test-results/real-workflow-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await openDetails(page);
      await page.screenshot({
        path: resolve('test-results/real-workflow-mobile.png'),
        fullPage: false,
      });
      assert.equal(
        await page
          .getByRole('heading', { name: 'Workflow runs', exact: true })
          .count(),
        0,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      );
      assert.deepEqual(errors, []);
      await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor();
      await page
        .getByRole('heading', { name: 'Reported tokens', exact: true })
        .waitFor();
      await page.reload();
      await openDetails(page);
      await page
        .getByRole('heading', { name: 'Models', exact: true })
        .waitFor();
      await page
        .getByRole('link', { name: 'Open pull request', exact: true })
        .waitFor();
      const originalIssue = fixture.github.getIssue;
      fixture.github.getIssue = async (...args) => ({
        ...(await originalIssue(...args)),
        state: 'closed',
      });
      const pulls = await fixture.github.pulls('example/project', '', 1);
      pulls.pulls[0].merged = true;
      pulls.pulls[0].state = 'closed';
      await until(
        async () => {
          await fixture.service.pollCompletedRuns();
          return fixture.client.workflow();
        },
        (s) => !s.runs.length,
        15000,
      );
      await page.locator('.page-cards').waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
);

test(
  'browser clarifies incomplete issues, explicitly adopts proof requirements and preserves compact run details',
  { timeout: 60000 },
  async () => {
    const { formatTicketBody } = await import(
      '../../packages/shared/src/index.js'
    );
    const { ticket } = await import('../fixtures/planning.js');
    const f = await realFixture({
      issueBody: 'Please improve checkout.',
      proofTest: `const fs=require('node:fs');if(fs.readFileSync('value.txt','utf8')!=='implemented\\n'){console.error('REGRESSION');process.exit(1);}`,
    });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      page.setDefaultTimeout(15000);
      const started = await f.client.startIssue(7, crypto.randomUUID());
      await page.goto(
        `${f.service.url}/?conversation=${started.developerConversationId}`,
      );
      await openDetails(page, 'Run');
      await page
        .getByRole('heading', { name: 'specification_contract', exact: true })
        .waitFor();
      const issue = f.github.getIssue;
      f.github.getIssue = async (...args) => ({
        ...(await issue(...args)),
        body: formatTicketBody({
          ...ticket,
          revision: 0,
          regression: {
            required: true,
            command: 'node regression.test.cjs',
            testPaths: ['regression.test.cjs'],
            expectedFailure: 'REGRESSION',
          },
        }),
      });
      await page
        .getByRole('button', { name: 'Adopt saved specification', exact: true })
        .click();
      await page
        .getByRole('heading', { name: 'specification_contract', exact: true })
        .waitFor({ state: 'detached' });
      await page
        .getByRole('button', { name: 'Resume run', exact: true })
        .click();
      await page
        .getByRole('link', { name: 'Open pull request', exact: true })
        .waitFor();
      const completed = await f.client.run(started.id);
      const proof = completed.evidence.find(
        (evidence) => evidence.kind === 'checks',
      )?.regression;
      assert.match(proof?.message ?? '', /Regression demonstrated:/);
      assert.ok(
        completed.proofWorkspaces?.every(
          (resource) => resource.state === 'removed',
        ),
      );
      assert.equal(await page.locator('[data-card-id="evidence"]').count(), 0);
      await page.reload();
      await openDetails(page);
      await page
        .getByRole('heading', { name: 'Models', exact: true })
        .waitFor();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      );
    } finally {
      await browser.close();
      await f.close();
    }
  },
);
