import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startService } from '../helpers/credentials.js';
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
    // Unnamed, the first project is called after its folder.
    const first = join(directory, 'alpha');
    await mkdir(first);
    execFileSync('git', ['init', '-q', first]);
    const firstSaved = await client.settings();
    firstSaved.settings.repository = {
      path: first,
      github: 'example/first',
      baseBranch: 'main',
    };
    await client.saveSettings({
      expectedRevision: firstSaved.revision,
      settings: firstSaved.settings,
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

    await page.getByRole('region', { name: 'alpha' }).waitFor();
    assert.equal(await page.getByText('Default project').count(), 0);
    assert.equal(await page.getByLabel('Search conversations').count(), 0);
    assert.equal(
      await page
        .getByRole('button', { name: 'New conversation', exact: true })
        .count(),
      0,
    );
    assert.equal(await page.getByText('PLANNING', { exact: true }).count(), 0);
    assert.equal(
      await page.getByText('IMPLEMENTATION', { exact: true }).count(),
      0,
    );
    // Session kinds are inline icons instead of separate text rows.
    const alpha = page.getByRole('region', { name: 'alpha' });
    await alpha.getByRole('img', { name: 'Planning', exact: true }).waitFor();
    // Settings is the last thing in the sidebar, at its bottom edge.
    const sidebar = await page.locator('.chat-sidebar').boundingBox();
    const settings = await page.locator('.settings-link').boundingBox();
    assert.ok(
      sidebar &&
        settings &&
        sidebar.y + sidebar.height - (settings.y + settings.height) < 40,
      'Settings is pinned to the bottom',
    );
  } finally {
    await browser.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('projects are added from their own page, not from settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-add-project-'));
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
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(10000);
    await page.goto(service.url);
    assert.equal(await page.getByLabel('Project name').count(), 0);
    assert.equal(
      await page.getByRole('link', { name: 'New project' }).count(),
      0,
    );
    await page.getByRole('link', { name: 'Add project', exact: true }).click();
    await page.waitForURL('**/projects/new');
    await page.getByLabel('Project name').fill('Brand new');
    await page.getByLabel('GitHub repository').fill('example/brand-new');
    await page.getByLabel('Provider').first().waitFor();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.waitForURL(`${service.url}/`);
    await page.getByRole('region', { name: 'Brand new' }).waitFor();
  } finally {
    await browser.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('settings and project settings open inside the app', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-views-'));
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
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(10000);
    await page.goto(service.url);
    await page.evaluate(() => {
      (window as unknown as { marker: string }).marker = 'same page';
    });
    await page.locator('.settings-link').click();
    await page.waitForURL(`${service.url}/settings`);
    await page.getByRole('heading', { name: 'Your connections' }).waitFor();
    assert.equal(await page.getByLabel('Base branch').count(), 0);
    await page.getByLabel('Parallel runs').waitFor();
    await page
      .getByRole('link', { name: /^Settings for/ })
      .first()
      .click();
    await page.waitForURL('**/projects/*/settings');
    await page.getByLabel('Base branch').waitFor();
    assert.equal(await page.getByLabel('Requesty token').count(), 0);
    await page.goBack();
    await page.getByRole('heading', { name: 'Your connections' }).waitFor();
    await page.getByRole('link', { name: 'Home' }).click();
    await page.waitForURL(`${service.url}/`);
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { marker: string }).marker,
      ),
      'same page',
      'views switch without a page load',
    );
    assert.equal(await page.locator('.chat-sidebar').count(), 1);
  } finally {
    await browser.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('every view shows its page title and chats show their mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-titles-'));
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
    const chat = await client.createConversation('Title check', 'title-1');
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(10000);
    const title = (name: string) =>
      page.locator('.chat-header').getByRole('heading', { name, exact: true });
    await page.goto(service.url);
    await title('Home').waitFor();
    await page.locator('.settings-link').click();
    await title('Settings').waitFor();
    await page.getByRole('link', { name: 'Add project', exact: true }).click();
    await title('Add project').waitFor();
    await page.goto(`${service.url}/?conversation=${chat.id}`);
    await title('Title check').waitFor();
    await page
      .locator('.chat-header .mode-tag', { hasText: 'Planning' })
      .waitFor();
    assert.equal(await page.locator('.chat-header .header-project').count(), 0);
    assert.equal(await page.getByText(/Browser: |Agent: /).count(), 0);
    assert.equal(await page.locator('.chat-header .eyebrow').count(), 0);
  } finally {
    await browser.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('history, unsaved edits and finished forms keep views consistent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-leave-'));
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
    const chat = await client.createConversation('Leave check', 'leave-1');
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(10000);
    const title = (name: string) =>
      page.locator('.chat-header').getByRole('heading', { name, exact: true });
    await page.goto(`${service.url}/?conversation=${chat.id}`);
    await title('Leave check').waitFor();

    // Back and Forward move between views without being bounced to chat.
    await page.locator('.settings-link').click();
    await title('Settings').waitFor();
    await page.goBack();
    await title('Leave check').waitFor();
    await page.goForward();
    await title('Settings').waitFor();
    assert.equal(new URL(page.url()).pathname, '/settings');

    // Unsaved edits ask before an in-app navigation discards them.
    await page.goto(`${service.url}/projects/default/settings`);
    await page.getByLabel('Base branch').fill('edited');
    const prompts: string[] = [];
    let accept = false;
    page.on('dialog', (dialog) => {
      prompts.push(dialog.message());
      void (accept ? dialog.accept() : dialog.dismiss());
    });
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    assert.equal(prompts.length, 1);
    assert.equal(await page.getByLabel('Base branch').inputValue(), 'edited');
    accept = true;
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await title('Home').waitFor();

    // Creating a project lands on Home, not on the previously open chat.
    await page.goto(`${service.url}/?conversation=${chat.id}`);
    await title('Leave check').waitFor();
    await page.getByRole('link', { name: 'Add project', exact: true }).click();
    await page.getByLabel('Project name').fill('Fresh');
    await page.getByRole('button', { name: 'Create project' }).click();
    await title('Home').waitFor();
    assert.equal(new URL(page.url()).search, '');
    assert.equal(prompts.length, 2, 'a finished form does not prompt');
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
