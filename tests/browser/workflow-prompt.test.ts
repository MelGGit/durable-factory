import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { workflowFixture } from '../fixtures/workflow.js';
import { until } from '../fixtures/chat.js';
import { context } from '../../apps/server/src/storage.js';

test(
  'workflow prompts collapse separately from human replies and retain the complete payload',
  { timeout: 30000 },
  async () => {
    const fixture = await workflowFixture();
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const started = await fixture.client.startRun(
        await fixture.issue(),
        'prompt-disclosure',
      );
      const run = await until(
        () => fixture.client.run(started.id),
        (value) => value.status === 'pr_ready',
      );
      const payload = `Continue work.\n\n${JSON.stringify({ answers: ['Yes, use the existing helper.'], ticket: 'context '.repeat(12000), end: 'COMPLETE-PROMPT-END' })}`;
      await fixture.service.workflow['harness'].commit(async (tx) => {
        await tx.appendEntry(Number(run.developerConversationId) as never, {
          kind: 'pi.user',
          model: [
            {
              role: 'user',
              content: 'Yes, use the existing helper.',
              timestamp: Date.now(),
            },
          ],
        });
        await tx.appendEntry(Number(run.developerConversationId) as never, {
          kind: 'factory.agent-input',
          data: {
            provenance: {
              author: 'workflow',
              reason: 'continuation',
              sourceIds: [run.id],
            },
            presentation: {
              summary: 'Continued developer attempt · 1 answer included',
              defaultCollapsed: true,
            },
          },
          model: [{ role: 'user', content: payload, timestamp: Date.now() }],
        });
      }, context);
      const page = await browser.newPage({
        viewport: { width: 1200, height: 900 },
      });
      page.setDefaultTimeout(7000);
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto(
        `${fixture.service.url}/?conversation=${run.developerConversationId}`,
      );
      const prompt = page.locator('.workflow-prompt');
      await prompt.locator('summary').waitFor();
      assert.equal(await prompt.getAttribute('open'), null);
      assert.match(
        await prompt.locator('summary').innerText(),
        /Workflow.*Continued developer attempt/,
      );
      assert.equal(await prompt.locator('pre').count(), 0);
      await page
        .locator('.user-message')
        .getByText('Yes, use the existing helper.', { exact: true })
        .waitFor();
      await prompt.locator('summary').focus();
      await page.keyboard.press('Enter');
      await prompt.locator('pre').waitFor();
      await prompt
        .getByRole('button', { name: 'Copy full prompt', exact: true })
        .click();
      await until(
        () => page.evaluate(() => navigator.clipboard.readText()),
        (text) => text === payload,
      );
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        payload,
      );
      await prompt
        .getByRole('button', { name: 'Read complete prompt', exact: true })
        .click();
      // Artifact paging retains content beyond the bounded transcript preview.
      await prompt
        .getByRole('button', { name: 'Load more prompt', exact: true })
        .click();
      await prompt
        .locator('.artifact-output pre')
        .filter({ hasText: 'COMPLETE-PROMPT-END' })
        .waitFor();
      await prompt.locator('summary').click();
      await page.reload();
      await prompt.locator('summary').waitFor();
      assert.equal(await prompt.getAttribute('open'), null);
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
);
