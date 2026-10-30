import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { workflowFixture } from '../fixtures/workflow.js';
import { simulationAdapter } from '../../apps/server/src/workflow.js';
import { until } from '../fixtures/chat.js';

async function browser() {
  return chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
}

test(
  'planning deletion confirms, cancels, clears selection and drafts in multiple tabs',
  { timeout: 40000 },
  async () => {
    const f = await workflowFixture();
    const b = await browser();
    try {
      const plan = await f.chat.createConversation(
        'Delete this plan',
        'delete-plan',
      );
      const context = await b.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      const second = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      second.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${f.service.url}/?conversation=${plan.id}`);
      await second.goto(`${f.service.url}/?conversation=${plan.id}`);
      await page
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill('Discard my draft');
      await page
        .getByRole('button', {
          name: 'Actions for Delete this plan',
          exact: true,
        })
        .click();
      await page
        .getByRole('button', { name: 'Delete Delete this plan', exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Delete chat',
        exact: true,
      });
      await dialog
        .getByRole('heading', { name: 'Delete “Delete this plan”?' })
        .waitFor();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.ok(
        (await f.chat.conversations()).conversations.some(
          (item) => item.id === plan.id,
        ),
      );
      await page
        .getByRole('button', {
          name: 'Actions for Delete this plan',
          exact: true,
        })
        .click();
      await page
        .getByRole('button', { name: 'Delete Delete this plan', exact: true })
        .click();
      await dialog
        .getByRole('button', { name: 'Delete permanently', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Your workspace' }).waitFor();
      await second.getByRole('heading', { name: 'Your workspace' }).waitFor();
      assert.equal(new URL(page.url()).searchParams.has('conversation'), false);
      assert.equal(
        new URL(second.url()).searchParams.has('conversation'),
        false,
      );
      assert.equal(
        await page.evaluate(
          (id) => localStorage.getItem(`factory.chat.v1.draft.${id}`),
          plan.id,
        ),
        null,
      );
      await page.reload();
      await page.getByRole('heading', { name: 'Your workspace' }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await b.close();
      await f.close();
    }
  },
);

test(
  'mobile implementation deletion shows blocked progress and retries while keeping its plan',
  { timeout: 45000 },
  async () => {
    const adapter = simulationAdapter();
    const execute = adapter.execute;
    let canStop = false;
    adapter.execute = (run, attempt, signal) =>
      attempt.stage === 'developer'
        ? new Promise(() => {})
        : execute(run, attempt, signal);
    adapter.cancel = async () => canStop;
    const f = await workflowFixture(adapter);
    const b = await browser();
    try {
      const plan = await f.issue();
      let run = await f.client.startRun(plan, 'mobile-run');
      run = await until(
        () => f.client.run(run.id),
        (r) => r.stage === 'developer',
      );
      const page = await b.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(
        `${f.service.url}/?conversation=${run.developerConversationId}`,
      );
      await page
        .getByRole('button', { name: 'Conversations', exact: true })
        .click();
      await page
        .getByRole('button', {
          name: `Actions for ${run.specification.title}`,
          exact: true,
        })
        .click();
      await page
        .getByRole('button', {
          name: `Delete ${run.specification.title}`,
          exact: true,
        })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Delete chat',
        exact: true,
      });
      await dialog
        .getByText(/including all files and unpublished changes/)
        .waitFor();
      await dialog
        .getByRole('button', { name: 'Delete permanently', exact: true })
        .click();
      const retry = page.getByRole('button', {
        name: `Retry deleting ${run.specification.title}`,
        exact: true,
      });
      await page
        .getByRole('status')
        .filter({ hasText: /could not|blocked|termination|stop/i })
        .first()
        .waitFor();
      await page
        .getByRole('button', {
          name: `Actions for ${run.specification.title}`,
          exact: true,
        })
        .click();
      await retry.waitFor();
      assert.equal((await f.client.run(run.id)).status, 'termination_blocker');
      canStop = true;
      await retry.click();
      await dialog
        .getByRole('button', { name: 'Delete permanently', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Close conversations', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Your workspace' }).waitFor();
      assert.ok(
        (await f.chat.conversations()).conversations.some(
          (item) => item.id === plan,
        ),
      );
    } finally {
      await b.close();
      await f.close();
    }
  },
);
