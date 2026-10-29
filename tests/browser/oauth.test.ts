import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startService } from '../helpers/credentials.js';
import { FactoryClient } from '../../packages/shared/src/index.js';
import { until } from '../fixtures/chat.js';
import type { OAuthLogin } from '../../apps/server/src/oauth.js';

const login: OAuthLogin = async (provider, store, interaction) => {
  await interaction.prompt({
    type: 'select',
    message: 'Choose method',
    options: [
      { id: 'browser', label: 'Browser login (default)' },
      { id: 'copy_code', label: 'Copy code login (headless)' },
    ],
  });
  interaction.notify({
    type: 'auth_url',
    url:
      provider === 'anthropic'
        ? 'https://claude.ai/oauth/authorize?state=fake'
        : 'https://auth.openai.com/authorize?state=fake',
  });
  const answer = await interaction.prompt({
    type: 'manual_code',
    message: 'Code',
  });
  assert.equal(answer, 'fake-browser-authorization-code');
  await store.modify(provider, async () => ({
    type: 'oauth',
    access: 'sentinel-browser-access',
    refresh: 'sentinel-browser-refresh',
    expires: Date.now() + 3600000,
  }));
};

test(
  'Settings subscription login supports both providers, reload, cancellation and secret-free responses',
  { timeout: 60000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oauth-browser-'));
    const service = await startService({ dataDir, port: 0, oauthLogin: login });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const context = await browser.newContext();
      // External sign-in pages are fixtures too; never contact real providers in tests.
      await context.route('https://claude.ai/**', (route) =>
        route.fulfill({ body: 'Fake provider sign-in page' }),
      );
      const page = await context.newPage();
      const bodies: string[] = [],
        errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (response.url().includes('/api/'))
          void response.text().then(
            (text) => bodies.push(text),
            () => {},
          );
      });
      await page.goto(`${service.url}/settings`);
      await page.getByLabel('Parallel runs').fill('3');
      await page
        .getByRole('button', { name: 'Connect Claude', exact: true })
        .click();
      let dialog = page.getByRole('dialog', {
        name: 'Connect Claude',
        exact: true,
      });
      await dialog.getByLabel('Choose a sign-in method').waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await mkdir(resolve('test-results'), { recursive: true });
      await page.screenshot({
        path: resolve('test-results/oauth-dialog-mobile.png'),
      });
      assert.equal(
        await dialog.getByLabel('Choose a sign-in method').inputValue(),
        'browser',
      );
      await dialog
        .getByRole('button', { name: 'Continue', exact: true })
        .click();
      const link = dialog.getByRole('link', { name: 'Open sign-in page' });
      await link.waitFor();
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      const popupPromise = page.waitForEvent('popup');
      await link.click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      assert.match(popup.url(), /^https:\/\/claude.ai\//);
      await popup.close();
      // Connection metadata refresh must not reset unrelated unsaved settings.
      await dialog
        .getByLabel('Paste the authorization code or final redirect URL')
        .fill('fake-browser-authorization-code');
      assert.equal(
        await dialog.locator('input').getAttribute('type'),
        'password',
      );
      await dialog
        .getByRole('button', { name: 'Continue', exact: true })
        .click();
      await dialog
        .getByRole('status')
        .filter({ hasText: 'Credentials stored securely' })
        .waitFor();
      assert.equal(await dialog.locator('input').count(), 0);
      await dialog
        .getByRole('button', { name: 'Close connect claude' })
        .click();
      assert.equal(await page.getByLabel('Parallel runs').inputValue(), '3');
      await page
        .getByRole('button', { name: 'Reconnect Claude', exact: true })
        .waitFor();
      await page
        .getByRole('button', { name: 'Connect ChatGPT', exact: true })
        .click();
      dialog = page.getByRole('dialog', {
        name: 'Connect ChatGPT',
        exact: true,
      });
      await dialog.getByLabel('Choose a sign-in method').waitFor();
      // Reload resumes an existing session instead of creating another authorization flow.
      page.on('dialog', (dialog) => void dialog.accept());
      await page.reload();
      dialog = page.getByRole('dialog', {
        name: 'Connect ChatGPT',
        exact: true,
      });
      await dialog.getByLabel('Choose a sign-in method').waitFor();
      await dialog
        .getByRole('button', { name: 'Continue', exact: true })
        .click();
      await dialog
        .getByLabel('Paste the authorization code or final redirect URL')
        .fill('fake-browser-authorization-code');
      await dialog
        .getByRole('button', { name: 'Continue', exact: true })
        .click();
      await dialog
        .getByRole('status')
        .filter({ hasText: 'Credentials stored securely' })
        .waitFor();
      await dialog
        .getByRole('button', { name: 'Close connect chatgpt' })
        .click();
      await page
        .getByRole('button', { name: 'Reconnect ChatGPT', exact: true })
        .click();
      dialog = page.getByRole('dialog', {
        name: 'Connect ChatGPT',
        exact: true,
      });
      await dialog.getByLabel('Choose a sign-in method').waitFor();
      await dialog
        .getByRole('button', { name: 'Close connect chatgpt' })
        .click();
      await until(
        () => new FactoryClient(service.url).loginStatus('openai'),
        (result) => result.session?.state === 'cancelled',
      );
      assert.equal(
        (await new FactoryClient(service.url).loginStatus('openai')).session
          ?.state,
        'cancelled',
      );
      assert.equal(
        (await new FactoryClient(service.url).settings()).credentials.openai,
        true,
        'cancelling reconnect preserves the existing connection',
      );
      assert.doesNotMatch(bodies.join(''), /sentinel-browser/);
      assert.doesNotMatch(
        await page.evaluate(() =>
          JSON.stringify({
            local: { ...localStorage },
            session: { ...sessionStorage },
          }),
        ),
        /sentinel-browser|fake-browser-authorization-code/,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await mkdir(resolve('test-results'), { recursive: true });
      await page.screenshot({
        path: resolve('test-results/oauth-settings-mobile.png'),
        fullPage: true,
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'login dialog can be dismissed with the close button or Escape when cancellation fails',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oauth-dismiss-'));
    const service = await startService({ dataDir, port: 0, oauthLogin: login });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
      });
      const page = await browser.newPage();
      const client = new FactoryClient(service.url);
      let cancellationFails = false;
      await page.route('**/api/v1/auth/**', (route) =>
        cancellationFails ? route.abort('connectionfailed') : route.continue(),
      );
      await page.goto(`${service.url}/settings`);
      for (const method of ['button', 'escape']) {
        await page
          .getByRole('button', { name: 'Connect Claude', exact: true })
          .click();
        const dialog = page.getByRole('dialog', {
          name: 'Connect Claude',
          exact: true,
        });
        await dialog.getByLabel('Choose a sign-in method').waitFor();
        const pending = (await client.loginStatus('anthropic')).session!;
        await dialog
          .getByRole('button', { name: 'Continue', exact: true })
          .click();
        await dialog
          .getByLabel('Paste the authorization code or final redirect URL')
          .fill('unsent-fake-authorization-code');
        cancellationFails = true;
        if (method === 'button')
          await dialog
            .getByRole('button', { name: 'Close connect claude' })
            .click();
        else await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 3000 });
        assert.equal(
          await page
            .locator('dialog[aria-label="Connect Claude"] input')
            .count(),
          0,
          'dismissal discards unsent authorization input',
        );
        await page
          .getByRole('alert')
          .filter({ hasText: 'Sign-in cancellation could not be confirmed' })
          .waitFor();
        await page.getByLabel('Parallel runs').fill('3');
        assert.equal(await page.getByLabel('Parallel runs').inputValue(), '3');
        assert.equal(
          (await client.loginStatus('anthropic')).session?.state,
          'pending',
          'the UI must not claim that a failed cancellation stopped the server session',
        );
        cancellationFails = false;
        // A successful status poll must not reopen the locally dismissed session.
        const polled = page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            response.url().endsWith('/auth/anthropic/login') &&
            response.status() === 200,
        );
        await polled;
        assert.equal(await dialog.isVisible(), false);
        await client.cancelLogin('anthropic', pending.id);
      }
    } finally {
      await browser?.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
