import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startService } from '../helpers/credentials.js';

test(
  'settings browser flow, credential privacy, stale saves, restart, and mobile layout',
  { timeout: 60000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-browser-'));
    let service = await startService({ dataDir, port: 0 });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const responseBodies: string[] = [];
      page.on('response', (response) => {
        if (response.url().includes('/api/'))
          void response
            .text()
            .then((value) => responseBodies.push(value))
            // Navigating or restarting can discard an unfinished response.
            .catch(() => {});
      });
      await page.goto(`${service.url}/projects/default/settings`);
      await page.getByRole('heading', { name: 'Repository' }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Save settings' }).isDisabled(),
        true,
      );
      await page.getByLabel('Local repository path').fill(resolve('.'));
      await page
        .getByLabel('GitHub repository')
        .fill('example/durable-factory');
      await page
        .getByLabel('Required checks')
        .fill('bun run check\nbun run test');
      await page
        .getByLabel('Provider', { exact: true })
        .first()
        .selectOption('requesty');
      await page
        .getByLabel('Model', { exact: true })
        .first()
        .fill('explicit/model');
      await page.getByRole('button', { name: 'Save settings' }).click();
      await page
        .getByRole('status')
        .filter({ hasText: 'Settings saved' })
        .waitFor();
      await page.reload();
      await page.getByLabel('GitHub repository').waitFor();
      assert.equal(
        await page.getByLabel('GitHub repository').inputValue(),
        'example/durable-factory',
      );
      assert.equal(
        await page.getByLabel('Required checks').inputValue(),
        'bun run check\nbun run test',
      );
      const stale = await context.newPage();
      await stale.goto(`${service.url}/projects/default/settings`);
      await stale.getByLabel('Base branch').waitFor();
      await page.getByLabel('Base branch').fill('develop');
      await page.getByRole('button', { name: 'Save settings' }).click();
      await page
        .getByRole('status')
        .filter({ hasText: 'Settings saved' })
        .waitFor();
      await stale.getByLabel('Base branch').fill('feature/stale');
      await stale.getByRole('button', { name: 'Save settings' }).click();
      await stale
        .getByRole('alert')
        .filter({ hasText: 'another window' })
        .waitFor();
      assert.equal(
        await stale.getByLabel('Base branch').inputValue(),
        'feature/stale',
      );
      // Connections are shared and live on the general settings page.
      await page.goto(`${service.url}/settings`);
      await page.getByRole('heading', { name: 'Your connections' }).waitFor();
      assert.equal(await page.getByLabel('Base branch').count(), 0);
      await page.getByLabel('Requesty token').fill('browser-secret-fixture');
      await page
        .locator('.connection-row')
        .filter({
          has: page.getByRole('heading', { name: 'Requesty', exact: true }),
        })
        .getByRole('button', { name: 'Store token' })
        .click();
      await page
        .getByRole('status')
        .filter({ hasText: 'Requesty token saved privately' })
        .waitFor();
      assert.equal(await page.getByLabel('Requesty token').inputValue(), '');
      assert.ok(!responseBodies.join('').includes('browser-secret-fixture'));
      const port = service.port;
      await service.close();
      service = await startService({ dataDir, port });
      await page.reload();
      await page.getByLabel('Requesty token').waitFor();
      assert.equal(await page.getByLabel('Requesty token').inputValue(), '');
      await page.goto(`${service.url}/projects/default/settings`);
      await page.getByLabel('Base branch').waitFor();
      assert.equal(
        await page.getByLabel('Base branch').inputValue(),
        'develop',
      );
      await mkdir(resolve('test-results'), { recursive: true });
      // Check the actual scrolling pane: the app shell can hide overflow
      // even when the document itself still fits the screen.
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        for (const width of [1440, 1024, 390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          for (const [view, route, heading] of [
            ['general', '/settings', 'Appearance'],
            ['project', '/projects/default/settings', 'Repository'],
          ]) {
            await page.goto(`${service.url}${route}`);
            await page
              .getByRole('heading', { name: heading, exact: true })
              .waitFor();
            const layout = await page
              .locator('.view-scroll')
              .evaluate((pane) => {
                const bounds = pane.getBoundingClientRect();
                return {
                  overflow: pane.scrollWidth > pane.clientWidth,
                  clippedControls: Array.from(
                    pane.querySelectorAll('input, select, textarea, button'),
                  ).filter((control) => {
                    const rect = control.getBoundingClientRect();
                    return (
                      rect.width > 0 &&
                      (rect.left < bounds.left || rect.right > bounds.right)
                    );
                  }).length,
                };
              });
            assert.deepEqual(
              layout,
              { overflow: false, clippedControls: 0 },
              `${view}, ${colorScheme}, ${width}px`,
            );
            if (width === 1440 || width === 390) {
              await page.screenshot({
                path: resolve(
                  `test-results/settings-${view}-${colorScheme}-${width}.png`,
                ),
              });
            }
          }
        }
      }
      // Keep save and discard reachable together on small screens.
      await page.getByLabel('Base branch').fill('discard-me');
      await page.getByRole('button', { name: 'Discard edits' }).click();
      assert.equal(
        await page.getByLabel('Base branch').inputValue(),
        'develop',
      );
      assert.equal(
        await page.getByRole('button', { name: 'Save settings' }).isDisabled(),
        true,
      );
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'damaged connections show actionable errors without blocking settings or token repair',
  { timeout: 30000 },
  async () => {
    const { writeFile } = await import('node:fs/promises');
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-browser-damage-'));
    const service = await startService({ dataDir, port: 0 });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      await writeFile(
        join(dataDir, 'credentials/openai.json'),
        '{broken-secret-fixture',
        { mode: 0o600 },
      );
      await writeFile(join(dataDir, 'credentials/requesty.json'), 'null', {
        mode: 0o600,
      });
      const { FactoryClient } = await import(
        '../../packages/shared/src/index.js'
      );
      await new FactoryClient(service.url).retryCredentialStorage();
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${service.url}/settings`);
      await page.getByRole('heading', { name: 'Your connections' }).waitFor();
      const openai = page.locator('.connection-row').filter({
        has: page.getByRole('heading', { name: 'OpenAI', exact: true }),
      });
      await openai.getByText('Needs attention', { exact: true }).waitFor();
      await openai.getByRole('alert').waitFor();
      assert.equal(
        await page
          .locator('body')
          .innerText()
          .then((text) => text.includes('broken-secret-fixture')),
        false,
      );
      await page.goto(`${service.url}/projects/default/settings`);
      await page.getByLabel('GitHub repository').fill('still/editable');
      await page.getByRole('button', { name: 'Save settings' }).click();
      await page
        .getByRole('status')
        .filter({ hasText: 'Settings saved' })
        .waitFor();
      await page.goto(`${service.url}/settings`);
      await page.getByLabel('Requesty token').fill('repaired-requesty-fixture');
      const requesty = page.locator('.connection-row').filter({
        has: page.getByRole('heading', { name: 'Requesty', exact: true }),
      });
      await requesty.getByRole('button', { name: 'Store token' }).click();
      await requesty.getByText('Credentials stored', { exact: true }).waitFor();
      await openai.getByRole('button', { name: 'Remove connection' }).click();
      await openai.getByText('Not connected', { exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
