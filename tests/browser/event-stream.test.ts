import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { simulationAdapter } from '../../apps/server/src/workflow.js';
import { workflowFixture } from '../fixtures/workflow.js';
import { until } from '../fixtures/chat.js';

test(
  'browser follows the project, a chat and a run over one event stream',
  { timeout: 60000 },
  async () => {
    const adapter = simulationAdapter(),
      execute = adapter.execute;
    adapter.execute = (run, attempt, signal) =>
      attempt.stage === 'developer'
        ? new Promise(() => {})
        : execute(run, attempt, signal);
    const fixture = await workflowFixture(adapter);
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
      });
      const planning = await fixture.issue();
      let run = await fixture.client.startRun(planning, 'one-stream');
      run = await until(
        () => fixture.client.run(run.id),
        (r) => r.stage === 'developer',
      );
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // The streams that are open: their response has arrived, and not ended.
      const open = new Map<object, string>();
      const requested: string[] = [];
      page.on('request', (request) => requested.push(request.url()));
      page.on('response', (response) => {
        if (response.headers()['content-type']?.includes('text/event-stream'))
          open.set(response.request(), response.url());
      });
      const done = (request: object) => void open.delete(request);
      page.on('requestfinished', done);
      page.on('requestfailed', done);
      const streams = () =>
        [...open.values()].map((url) => new URL(url).pathname);

      await page.goto(
        `${fixture.service.url}/?conversation=${run.developerConversationId}`,
      );
      await page.locator('.implementation-events').waitFor();
      assert.deepEqual(streams(), ['/api/v1/events'], 'the run is open');

      await page
        .getByRole('navigation', { name: /sessions$/ })
        .getByRole('button', { name: /^Workflow plan/ })
        .click();
      await page.waitForURL(`**/?conversation=${planning}`);
      await page.getByLabel('Message', { exact: true }).waitFor();
      assert.deepEqual(streams(), ['/api/v1/events'], 'the chat is open');

      // The chat still streams live, over the shared connection.
      await fixture.chat.submit(planning, 'Anything new?', 'one-stream-live');
      await page
        .getByLabel('Conversation transcript')
        .getByText('Anything new?', { exact: true })
        .waitFor();
      assert.deepEqual(streams(), ['/api/v1/events']);
      assert.deepEqual(
        requested.filter((url) => /\/ag-ui\/events/.test(url)),
        [],
        'no stream of its own was ever requested',
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await fixture.close();
    }
  },
);
