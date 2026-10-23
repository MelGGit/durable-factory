import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workflowFixture } from '../fixtures/workflow.js';
import { simulationAdapter } from '../../apps/server/src/workflow.js';
import { until } from '../fixtures/chat.js';

test(
  'browser starts labelled simulation, restores question after restart, answers, and inspects evidence on desktop/mobile',
  { timeout: 60000 },
  async () => {
    const adapter = simulationAdapter();
    const execute = adapter.execute;
    let asked = false;
    adapter.execute = async (run, attempt, signal) => {
      if (!asked && attempt.stage === 'developer') {
        asked = true;
        return {
          outcome: 'needs_input',
          message: 'Which search behavior should be used?',
        };
      }
      return execute(run, attempt, signal);
    };
    const s = await workflowFixture(adapter);
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const conversationId = await s.issue();
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${s.service.url}/?conversation=${conversationId}`);
      await page.getByRole('button', { name: 'Start simulated run' }).click();
      await page.getByRole('heading', { name: 'Workflow runs' }).waitFor();
      await page
        .locator('.run-question')
        .getByText('Which search behavior should be used?', { exact: true })
        .waitFor();
      const run = (await s.client.workflow()).runs[0];
      await s.service.close();
      await page.getByText(/Browser: disconnected/).waitFor();
      await s.restart(true, true);
      await page.getByText(/Browser: connected/).waitFor();
      await page.reload();
      await page
        .locator('.run-question')
        .getByText('Which search behavior should be used?', { exact: true })
        .waitFor();
      await mkdir(resolve('test-results'), { recursive: true });
      await page.screenshot({
        path: resolve('test-results/workflow-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: resolve('test-results/workflow-mobile.png'),
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      );
      await page
        .getByLabel('Answer', { exact: true })
        .fill('Use the saved specification.');
      await page.getByRole('button', { name: 'Answer and resume' }).click();
      await until(
        () => s.client.run(run.id),
        (r) => r.status === 'pr_ready',
      );
      await page
        .getByRole('status')
        .filter({ hasText: 'Simulated PR' })
        .waitFor();
      await page
        .getByRole('link', { name: 'Open reviewer conversation', exact: true })
        .click();
      await page
        .getByText('Simulated reviewer passed.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel('Message', { exact: true }).count(),
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await s.close();
    }
  },
);

test(
  'browser pause, resume, cancellation and queued guidance stay linked to durable run',
  { timeout: 60000 },
  async () => {
    const adapter = simulationAdapter();
    const execute = adapter.execute;
    adapter.execute = async (run, attempt, signal) =>
      attempt.stage === 'developer'
        ? new Promise(() => {})
        : execute(run, attempt, signal);
    const s = await workflowFixture(adapter);
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const run = await s.client.startRun(await s.issue(), 'browser-start');
      await until(
        () => s.client.run(run.id),
        (r) => r.stage === 'developer',
      );
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(`${s.service.url}/runs#${run.id}`);
      await page
        .getByLabel('Developer guidance', { exact: true })
        .fill('Keep the accepted scope.');
      await page.getByRole('button', { name: 'Queue guidance' }).click();
      await page.getByRole('button', { name: 'Withdraw input' }).click();
      await page
        .getByText('Keep the accepted scope. · withdrawn', { exact: true })
        .waitFor();
      await page
        .getByRole('button', { name: 'Pause run', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Resume run', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
      await page
        .getByRole('button', {
          name: 'Start explicit new simulated run',
          exact: true,
        })
        .waitFor();
      assert.equal((await s.client.run(run.id)).status, 'cancelled');
    } finally {
      await browser.close();
      await s.close();
    }
  },
);

test(
  'browser reconciles paused publication and resumes only on explicit request',
  { timeout: 60000 },
  async () => {
    const adapter = simulationAdapter();
    const execute = adapter.execute;
    let publishCalls = 0;
    let resumePublication = false;
    adapter.execute = async (run, attempt, signal) => {
      if (attempt.stage === 'publishing') {
        publishCalls++;
        if (!resumePublication) return new Promise(() => {});
      }
      return execute(run, attempt, signal);
    };
    const s = await workflowFixture(adapter);
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const run = await s.client.startRun(
        await s.issue(),
        'browser-publication',
      );
      await until(
        async () => publishCalls,
        (calls) => calls === 1,
      );
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(`${s.service.url}/runs#${run.id}`);
      await page
        .getByRole('button', { name: 'Pause run', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Reconcile run', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Resume run', exact: true })
        .waitFor();
      assert.equal((await s.client.run(run.id)).status, 'paused');
      assert.equal(publishCalls, 1);
      assert.equal(await page.getByRole('alert').count(), 0);
      resumePublication = true;
      await page
        .getByRole('button', { name: 'Resume run', exact: true })
        .click();
      await until(
        () => s.client.run(run.id),
        (r) => r.status === 'pr_ready',
      );
      assert.equal(publishCalls, 2);
    } finally {
      await browser.close();
      await s.close();
    }
  },
);

test(
  'explicit new-run retry keeps its operation identity after a lost response and reload',
  { timeout: 60000 },
  async () => {
    const fixture = await workflowFixture();
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const conversation = await fixture.issue();
      const original = await fixture.client.startRun(
        conversation,
        'original-run',
      );
      await until(
        () => fixture.client.run(original.id),
        (r) => r.status === 'pr_ready',
      );
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(`${fixture.service.url}/runs#${original.id}`);
      let operationId = '';
      await page.route('**/api/v1/runs', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        operationId = route.request().postDataJSON().operationId;
        await route.fetch();
        await route.abort('failed');
      });
      await page
        .getByRole('button', {
          name: 'Start explicit new simulated run',
          exact: true,
        })
        .click();
      await until(
        () => fixture.client.workflow(),
        (s) =>
          s.runs.length === 2 && s.runs.every((r) => r.status === 'pr_ready'),
      );
      await page.getByRole('alert').waitFor();
      await page.unroute('**/api/v1/runs');
      await page.reload();
      let retryId = '';
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          request.url().endsWith('/api/v1/runs')
        )
          retryId = request.postDataJSON().operationId;
      });
      await page
        .getByRole('button', {
          name: 'Start explicit new simulated run',
          exact: true,
        })
        .click();
      await until(
        async () => new URL(page.url()).hash,
        (hash) => hash !== `#${original.id}`,
      );
      assert.equal(retryId, operationId);
      assert.equal((await fixture.client.workflow()).runs.length, 2);
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
);
