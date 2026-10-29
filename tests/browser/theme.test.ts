import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../../apps/server/src/service.js';

test(
  'theme setting follows system, persists and applies',
  { timeout: 60000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-theme-'));
    const service = await startService({ dataDir, port: 0 });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const context = await browser.newContext({ colorScheme: 'dark' });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const theme = () =>
        page.evaluate(() => document.documentElement.dataset.theme);
      const background = () =>
        page.evaluate(
          () => getComputedStyle(document.body.parentElement!).backgroundColor,
        );
      const palette = () =>
        page.evaluate(() => {
          return {
            canvas: getComputedStyle(document.querySelector('.chat-main')!)
              .backgroundColor,
            sidebar: getComputedStyle(document.querySelector('.chat-sidebar')!)
              .backgroundColor,
            input: getComputedStyle(document.querySelector('#requesty-token')!)
              .backgroundColor,
            meta: document
              .querySelector('meta[name="theme-color"]')
              ?.getAttribute('content'),
            scheme: document.documentElement.style.colorScheme,
          };
        });

      await page.goto(`${service.url}/settings`);
      await page.getByRole('heading', { name: 'Appearance' }).waitFor();
      assert.equal(await theme(), 'dark');
      assert.equal(await background(), 'rgb(25, 25, 25)');
      assert.deepEqual(await palette(), {
        canvas: 'rgb(25, 25, 25)',
        sidebar: 'rgb(38, 38, 36)',
        input: 'rgb(48, 48, 46)',
        meta: '#191919',
        scheme: 'dark',
      });

      await page.getByRole('radio', { name: 'Light' }).check();
      assert.equal(await theme(), 'light');
      assert.equal(await background(), 'rgb(250, 249, 245)');
      assert.deepEqual(await palette(), {
        canvas: 'rgb(250, 249, 245)',
        sidebar: 'rgb(245, 244, 238)',
        input: 'rgb(255, 255, 255)',
        meta: '#faf9f5',
        scheme: 'light',
      });
      await page.reload();
      await page.getByRole('heading', { name: 'Appearance' }).waitFor();
      assert.equal(await theme(), 'light');

      await page.getByRole('radio', { name: 'System' }).check();
      assert.equal(await theme(), 'dark');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === 'light',
      );
      assert.equal(await theme(), 'light');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
