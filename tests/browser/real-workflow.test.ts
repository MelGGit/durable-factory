import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { realFixture } from '../fixtures/real.js';
import { until } from '../fixtures/chat.js';
async function openDetails(page: Page, name = 'Details') {
  const tab = page.getByRole('tab', { name, exact: true });
  if (
    (page.viewportSize()?.width ?? 1280) < 1200 &&
    !(await page
      .getByRole('dialog', { name: 'Implementation details', exact: true })
      .isVisible())
  )
    await page
      .getByRole('button', { name: 'Show details', exact: true })
      .click();
  await tab.click();
}

test(
  'browser starts a real issue, shows its workspace and verified PR, and preserves responsive inspection',
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
      await page.goto(`${fixture.service.url}/runs`);
      await page.getByLabel('GitHub issue number').fill('7');
      await page
        .getByRole('button', { name: 'Start implementation', exact: true })
        .click();
      const run = await until(
        async () => {
          const state = await fixture.client.workflow();
          return state.runs[0];
        },
        (r) => Boolean(r) && ['pr_ready', 'needs_input'].includes(r.status),
        30000,
      );
      assert.equal(run.status, 'pr_ready');
      await openDetails(page);
      await page
        .getByRole('heading', { name: 'Run timeline', exact: true })
        .waitFor();
      await page.getByRole('list', { name: 'Run timeline' }).waitFor();
      await page
        .getByRole('heading', { name: 'Implementation reports', exact: true })
        .waitFor();
      await page
        .locator('summary')
        .filter({ hasText: 'Current implementation' })
        .waitFor();
      await page
        .locator('summary')
        .filter({ hasText: 'reviewer: passed' })
        .click();
      await page
        .getByRole('heading', { name: 'AC-1: met', exact: true })
        .waitFor();
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
      await openDetails(page);
      await page
        .locator('summary')
        .filter({ hasText: 'checks: passed' })
        .click();
      await page
        .locator('details')
        .filter({ hasText: 'checks: passed' })
        .locator('.command-output > summary')
        .click();
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
      await openDetails(page);
      await page
        .locator('summary')
        .filter({ hasText: 'checks: passed' })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve('test-results/real-workflow-mobile-evidence.png'),
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
      await page
        .getByRole('heading', { name: 'Models and usage', exact: true })
        .waitFor();
      await page
        .getByText(/Reported tokens:/)
        .first()
        .waitFor();
      await page.reload();
      await openDetails(page);
      await page.getByRole('list', { name: 'Run timeline' }).waitFor();
      await page
        .locator('summary')
        .filter({ hasText: 'Current implementation' })
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
      await page.getByLabel('Run inspector').waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
);

test(
  'browser clarifies incomplete issues, explicitly adopts proof requirements and inspects regression output',
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
      await page.goto(`${f.service.url}/runs`);
      await page
        .getByRole('button', { name: 'Conversations', exact: true })
        .click();
      await page.getByLabel('GitHub issue number').fill('7');
      await page
        .getByRole('button', { name: 'Start implementation', exact: true })
        .click();
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
      await openDetails(page);
      await page
        .locator('summary')
        .filter({ hasText: 'checks: passed' })
        .click();
      await page
        .getByText(/^Regression proof: Regression demonstrated:/)
        .waitFor();
      await page
        .getByRole('region', { name: 'Regression proof resources' })
        .waitFor();
      await page
        .locator('summary')
        .filter({ hasText: 'Base snapshot · removed' })
        .click();
      await page
        .getByRole('region', { name: 'Regression proof resources' })
        .locator('.command-output > summary')
        .first()
        .click();
      await page.getByText('REGRESSION', { exact: true }).waitFor();
      await page.reload();
      await openDetails(page);
      await page.getByRole('list', { name: 'Run timeline' }).waitFor();
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
