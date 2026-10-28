import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startService } from '../../apps/server/src/service.js';
import { ChatClient, WorkflowClient } from '../../packages/shared/src/index.js';
import { configure } from '../fixtures/chat.js';
import { planningFixture } from '../fixtures/planning.js';

test('the sidebar groups conversations by project and has no issue starter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-projects-ui-'));
  const service = await startService({
    port: 0,
    dataDir: join(directory, 'data'),
    chat: planningFixture(),
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const client = new ChatClient(service.url);
    await configure(client);
    const second = await client.createProject('Second');
    const path = join(directory, 'second');
    await mkdir(path);
    execFileSync('git', ['init', '-q', path]);
    const scoped = new ChatClient(service.url, undefined, second.id);
    const saved = await scoped.settings();
    saved.settings.repository = {
      path,
      github: 'example/second',
      baseBranch: 'main',
    };
    await scoped.saveSettings({
      expectedRevision: saved.revision,
      settings: saved.settings,
    });
    await client.createConversation('Default chat', 'one');
    await scoped.createConversation('Second chat', 'two');

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(10000);
    await page.goto(service.url);
    const groups = page.locator('.project-group');
    await groups.nth(1).waitFor();
    assert.equal(await groups.count(), 2);
    assert.equal(await page.getByLabel('GitHub issue number').count(), 0);
    const mine = page.getByRole('region', { name: 'Second' });
    await mine.getByText('Second chat').waitFor();
    assert.equal(await mine.getByText('Default chat').count(), 0);

    await mine
      .getByRole('button', { name: /Second/ })
      .first()
      .click();
    assert.equal(await mine.getByText('Second chat').count(), 0);
    await page.reload();
    await groups.nth(1).waitFor();
    assert.equal(
      await page
        .getByRole('region', { name: 'Second' })
        .getByText('Second chat')
        .count(),
      0,
      'collapsed state survives a reload',
    );

    await page.getByLabel('Search conversations').fill('default');
    assert.equal(await groups.count(), 1);
  } finally {
    await browser.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the number of parallel runs is saved from the settings page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-runners-ui-'));
  const service = await startService({
    port: 0,
    dataDir: join(directory, 'data'),
    chat: planningFixture(),
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(`${service.url}/settings`);
    const input = page.getByLabel('Parallel runs');
    assert.equal(await input.inputValue(), '1');
    await input.fill('3');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Up to 3 runs will work at once.').waitFor();
    await page.reload();
    assert.equal(await page.getByLabel('Parallel runs').inputValue(), '3');
    assert.equal((await new WorkflowClient(service.url).workflow()).runners, 3);
  } finally {
    await browser.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
