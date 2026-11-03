import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startService } from '../helpers/credentials.js';
import {
  ChatClient,
  conversationView,
  historyView,
  viewSnapshotEvents,
  type ConversationSnapshot,
  type ToolView,
} from '../../packages/shared/src/index.js';
import { installAgUiStream } from './ag-ui-stream.js';
import { fixture, configure } from '../fixtures/chat.js';

const pushers = new WeakMap<
  Page,
  (value: ConversationSnapshot) => Promise<void>
>();
async function installSnapshotStream(
  page: Page,
  initial: ConversationSnapshot,
) {
  pushers.set(
    page,
    await installAgUiStream(page, {
      channel: `chat:${initial.conversation.id}`,
      threadId: initial.conversation.id,
      view: conversationView,
      initial,
    }),
  );
}
async function pushSnapshot(page: Page, snapshot: ConversationSnapshot) {
  await pushers.get(page)!(snapshot);
}

test(
  'one response combines Markdown and interleaved tools with stable output and restrained typography',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-response-flow-'));
    const service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'A continuous response',
        'response-flow',
      );
      const read: ToolView = {
        id: 'read-settings',
        name: 'read_repository',
        arguments: '{"path":"apps/web/src/settings.tsx"}',
        status: 'pending',
      };
      const edit: ToolView = {
        id: 'edit-settings',
        name: 'worktree_edit',
        arguments: '{"path":"apps/web/src/settings.tsx"}',
        status: 'pending',
      };
      const command: ToolView = {
        id: 'validation',
        name: 'worktree_command',
        arguments: '{"command":"bun run check"}',
        status: 'running',
        artifact: 'task-validation',
      };
      const at = Date.now();
      let snapshot: ConversationSnapshot = {
        conversation,
        execution: 'running',
        submissions: [],
        partial: 'I’m checking the last edge case.',
        tools: [command],
        entries: [
          {
            id: '1',
            kind: 'pi.user',
            text: 'Make the settings flow clearer.',
            tools: [],
          },
          {
            id: '2',
            at,
            kind: 'pi.assistant',
            text: 'I’ll inspect the settings code, update the form, and run focused checks.',
            tools: [read],
          },
          {
            id: '3',
            kind: 'pi.tool-result',
            text: '',
            tools: [
              {
                ...read,
                status: 'completed',
                output: 'Settings form inspected.',
              },
            ],
          },
          {
            id: '4',
            at: at + 1,
            kind: 'pi.assistant',
            text: '### Updating the form\nThe draft can keep related controls together, with validation beside each field.',
            tools: [edit],
          },
          {
            id: '5',
            kind: 'pi.tool-result',
            text: '',
            tools: [{ ...edit, status: 'completed', output: 'Form updated.' }],
          },
          {
            id: '6',
            at: at + 2,
            kind: 'pi.assistant',
            text: '## Changes\n\nThe **setup helper** now keeps related controls together.\n\n- Repository settings stay in one section.\n  - Changes remain in the draft until saved.\n- Validation points to the relevant field.\n\n### Validation\n\n```ts\nconst ready = true;\n```\n\n| Check | Result |\n| --- | --- |\n| Draft | Preserved |',
            tools: [],
          },
        ],
      };
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1150 },
      });
      page.setDefaultTimeout(6000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          /unique.*key|same key/.test(message.text())
        )
          errors.push(message.text());
      });
      await page.addInitScript(() =>
        localStorage.setItem('factory.theme.v1', 'system'),
      );
      await installSnapshotStream(page, snapshot);
      let requests = 0;
      await page.route('**/artifacts/task-validation?*', (route) => {
        requests++;
        return route.fulfill({ json: { text: 'TypeScript check passed.' } });
      });
      await page.goto(`${service.url}/?conversation=${conversation.id}`);
      const response = page.locator('.agent-response');
      const card = page.locator('[data-tool-id="validation"]');
      await response
        .getByText('I’m checking the last edge case.', { exact: true })
        .waitFor();
      assert.equal(await response.count(), 1);
      assert.equal(await response.locator('.message-author').count(), 1);
      assert.equal(await page.locator('.tool-agent').count(), 0);
      assert.equal(await response.locator('.markdown ul ul').count(), 1);
      assert.equal(await response.locator('.markdown pre code').count(), 1);
      assert.equal(await response.locator('.markdown table').count(), 1);
      const styles = await response.evaluate((element) => {
        const p = element.querySelector('p')!;
        const heading = element.querySelector('h2')!;
        const strong = element.querySelector('strong:not(.tool-label)')!;
        const appBody = getComputedStyle(document.body);
        const prose = getComputedStyle(p);
        return {
          body: prose.fontSize,
          heading: getComputedStyle(heading).fontSize,
          bold: getComputedStyle(strong).fontWeight,
          bodyWeight: prose.fontWeight,
          sameFamily: prose.fontFamily === appBody.fontFamily,
          sameSize: prose.fontSize === appBody.fontSize,
          sameLineHeight: prose.lineHeight === appBody.lineHeight,
          gap: getComputedStyle(element.querySelector('.response-content')!)
            .gap,
        };
      });
      assert.deepEqual(styles, {
        body: '16px',
        heading: '16px',
        bold: '400',
        bodyWeight: '400',
        sameFamily: true,
        sameSize: true,
        sameLineHeight: true,
        gap: '12px',
      });
      const proseLeft = await response
        .locator('.response-text')
        .first()
        .evaluate((element) => element.getBoundingClientRect().left);
      assert.ok(
        Math.abs(
          (await card
            .locator(':scope > summary')
            .evaluate((element) => element.getBoundingClientRect().left)) -
            proseLeft,
        ) < 1,
      );
      await card.locator(':scope > summary').click();
      await card.getByRole('button', { name: 'Read complete output' }).click();
      await card
        .getByText('TypeScript check passed.', { exact: true })
        .waitFor();
      snapshot = {
        ...snapshot,
        execution: 'idle',
        partial: 'All checks passed.',
        tools: [],
        entries: [
          ...snapshot.entries,
          {
            id: '7',
            kind: 'pi.assistant',
            text: '',
            tools: [{ ...command, artifact: undefined, status: 'pending' }],
          },
          {
            id: '8',
            kind: 'pi.tool-result',
            text: '',
            tools: [
              {
                ...command,
                status: 'completed',
                output: 'Validation complete.',
              },
            ],
          },
        ],
      };
      await pushSnapshot(page, snapshot);
      await response.getByText('All checks passed.', { exact: true }).waitFor();
      await card
        .getByText('TypeScript check passed.', { exact: true })
        .waitFor();
      assert.equal(await response.count(), 1);
      assert.equal(
        await response.locator('.response-author > time').count(),
        1,
      );
      assert.equal(requests, 1);
      await card.locator(':scope > summary').click();
      await mkdir(resolve('test-results'), { recursive: true });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await page.reload();
        await response
          .getByText('All checks passed.', { exact: true })
          .waitFor();
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1150 });
          await page
            .getByLabel('Conversation transcript')
            .evaluate((element) => {
              element.scrollTop = 0;
            });
          await page.screenshot({
            path: resolve(
              `test-results/continuous-response-${colorScheme}-${width}.png`,
            ),
            fullPage: true,
          });
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          );
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'tool groups stay compact, retain disclosures and in-flight output through regrouping, and reveal new failures once',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-tool-groups-'));
    const service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    let release = () => {};
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'Compact tool activity',
        'tool-groups',
      );
      const read: ToolView = {
        id: 'read',
        name: 'read_repository',
        arguments: '{"path":"README.md"}',
        status: 'running',
        artifact: 'task-read',
        output: 'Reading…',
      };
      const command: ToolView = {
        id: 'command',
        name: 'worktree_command',
        arguments: '{"command":"bun test"}',
        status: 'running',
      };
      let snapshot: ConversationSnapshot = {
        conversation,
        execution: 'running',
        partial: '',
        submissions: [],
        entries: [],
        tools: [read],
      };
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await page.addInitScript(() =>
        localStorage.setItem('factory.theme.v1', 'system'),
      );
      await page.addInitScript(() => {
        const cancelled: boolean[] = [];
        Object.assign(window, { __activityClicksCancelled: cancelled });
        document.addEventListener('click', (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('.tool-card > summary, .tool-group > summary')
          )
            cancelled.push(event.defaultPrevented);
        });
      });
      page.setDefaultTimeout(6000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await installSnapshotStream(page, snapshot);
      let requests = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/artifacts/task-read?*', async (route) => {
        requests++;
        await gate;
        await route.fulfill({
          json: { text: 'Complete output survives regrouping ✓' },
        });
      });
      await page.goto(`${service.url}/?conversation=${conversation.id}`);
      const readCard = page.locator('.tool-card[data-tool-id="read"]');
      await readCard.getByText('Reading README.md', { exact: true }).waitFor();
      assert.equal(await readCard.getAttribute('open'), null);
      assert.equal(requests, 0);
      const group = page.locator('.tool-group');
      snapshot = { ...snapshot, tools: [read, command] };
      await pushSnapshot(page, snapshot);
      await group
        .locator(':scope > summary')
        .getByText('Running bun test · 2 calls', { exact: true })
        .waitFor();
      assert.equal(await group.getAttribute('open'), null);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(
        await group
          .locator(':scope > summary .tool-indicator')
          .evaluate((node) => getComputedStyle(node).animationName),
        'none',
      );
      assert.equal(requests, 0);
      snapshot = { ...snapshot, tools: [read] };
      await pushSnapshot(page, snapshot);
      await group.waitFor({ state: 'detached' });
      await readCard.locator(':scope > summary').focus();
      await page.keyboard.press('Enter');
      await readCard
        .getByRole('button', { name: 'Read complete output' })
        .click();
      snapshot = {
        ...snapshot,
        tools: [{ ...read, status: 'completed' }, command],
      };
      await pushSnapshot(page, snapshot);
      await group
        .locator(':scope > summary')
        .getByText('Running bun test · 2 calls', { exact: true })
        .waitFor();
      assert.equal(await group.getAttribute('open'), '');
      assert.equal(await readCard.getAttribute('open'), '');
      assert.equal(
        await readCard
          .getByRole('button', { name: 'Read complete output' })
          .isDisabled(),
        true,
      );
      release();
      await readCard
        .getByText('Complete output survives regrouping ✓', { exact: true })
        .waitFor();
      assert.equal(requests, 1);

      // Another call changes the group key and remounts its children.
      const edited: ToolView = {
        id: 'edit',
        name: 'worktree_edit',
        arguments: '{"path":"app.ts"}',
        status: 'completed',
      };
      const completed = [
        { ...read, status: 'completed' as const },
        { ...command, status: 'completed' as const },
        edited,
      ];
      snapshot = {
        ...snapshot,
        execution: 'idle',
        tools: [],
        entries: [
          {
            id: '10',
            kind: 'pi.assistant',
            text: 'I checked the files.',
            tools: completed.map((tool) => ({ ...tool, status: 'pending' })),
          },
          { id: '11', kind: 'pi.tool-result', text: '', tools: completed },
        ],
      };
      await pushSnapshot(page, snapshot);
      await group
        .locator(':scope > summary')
        .getByText('Read 1 file, ran 1 command, edited 1 file', { exact: true })
        .waitFor();
      await readCard
        .getByText('Complete output survives regrouping ✓', { exact: true })
        .waitFor();
      assert.equal(await readCard.count(), 1);
      assert.equal(await readCard.getAttribute('open'), '');
      assert.equal(requests, 1);
      assert.equal(
        await readCard.locator('.artifact-output').count(),
        2,
        'Input and output remain distinct even when they reference the same artifact',
      );
      await group.locator(':scope > summary').click();
      await page.waitForFunction(
        () => !document.querySelector('.tool-group')?.hasAttribute('open'),
      );

      // A failure opens both levels, but unrelated updates respect a manual collapse.
      snapshot = {
        ...snapshot,
        entries: snapshot.entries.map((entry) =>
          entry.kind === 'pi.tool-result'
            ? {
                ...entry,
                tools: completed.map((tool) =>
                  tool.id === 'command'
                    ? {
                        ...tool,
                        status: 'failed',
                        output: 'Assertion failed: expected 200',
                      }
                    : tool,
                ),
              }
            : entry,
        ),
      };
      await pushSnapshot(page, snapshot);
      const failed = page.locator('.tool-card[data-tool-id="command"]');
      await failed
        .getByText('Assertion failed: expected 200', { exact: true })
        .waitFor();
      assert.equal(await group.getAttribute('open'), '');
      assert.equal(await failed.getAttribute('open'), '');
      await failed
        .locator(':scope > summary')
        .getByText('Failed', { exact: true })
        .waitFor();
      await failed.locator(':scope > summary').click();
      await group.locator(':scope > summary').click();
      await page.waitForFunction(
        () => !document.querySelector('.tool-group')?.hasAttribute('open'),
      );
      snapshot = { ...snapshot, partial: 'Checking the failure.' };
      await pushSnapshot(page, snapshot);
      await page.getByText('Checking the failure.', { exact: true }).waitFor();
      assert.equal(await group.getAttribute('open'), null);
      assert.equal(await failed.getAttribute('open'), null);
      // Opening the group restores the still-open read without fetching again.
      await group.locator(':scope > summary').click();
      await readCard
        .getByText('Complete output survives regrouping ✓', { exact: true })
        .waitFor();
      assert.equal(requests, 1);
      assert.equal(await failed.getAttribute('open'), null);
      assert.deepEqual(errors, []);
      const cancelled = await page.evaluate(
        () =>
          (window as unknown as { __activityClicksCancelled: boolean[] })
            .__activityClicksCancelled,
      );
      assert.ok(cancelled.length > 0);
      assert.equal(
        cancelled.some(Boolean),
        false,
        'Native summary activation must remain uncancelled so Safari can toggle it',
      );

      await mkdir(resolve('test-results'), { recursive: true });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        await page.reload();
        await failed
          .getByText('Assertion failed: expected 200', { exact: true })
          .waitFor();
        assert.equal(
          await page.locator('html').getAttribute('data-theme'),
          colorScheme,
        );
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page
            .getByLabel('Conversation transcript')
            .evaluate((element) => {
              element.scrollTop = 0;
            });
          await page.screenshot({
            path: resolve(
              `test-results/tool-activity-${colorScheme}-${width}.png`,
            ),
            fullPage: true,
          });
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          );
          assert.equal(await group.locator('.tool-indicator').count(), 0);
          await group.locator(':scope > summary').click();
          await page.screenshot({
            path: resolve(
              `test-results/tool-activity-${colorScheme}-${width}-collapsed.png`,
            ),
            fullPage: true,
          });
          await group.locator(':scope > summary').click();
        }
      }
    } finally {
      release();
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'growing tool artifacts stay readable after EOF, completion and in-flight reads',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-artifact-growth-'));
    const service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'Growing output',
        'growth',
      );
      let snapshot: ConversationSnapshot = {
        conversation,
        execution: 'running',
        partial: '',
        submissions: [],
        entries: [],
        tools: [
          {
            id: 'call',
            name: 'probe',
            status: 'running',
            output: 'Preview',
            artifact: 'task-1',
          },
        ],
      };
      const page = await browser.newPage();
      page.setDefaultTimeout(6000);
      await installSnapshotStream(page, snapshot);
      const offsets: number[] = [];
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pending = false;
      await page.route('**/artifacts/task-1?*', async (route) => {
        const offset = Number(
          new URL(route.request().url()).searchParams.get('offset'),
        );
        offsets.push(offset);
        if (offsets.length === 1)
          await route.fulfill({ json: { text: 'Early ✓' } });
        else if (offsets.length === 2) {
          pending = true;
          await gate;
          await route.fulfill({ json: { text: '\nStill running' } });
        } else await route.fulfill({ json: { text: '\nFinal output' } });
      });
      await page.goto(`${service.url}/?conversation=${conversation.id}`);
      const tool = page.locator('.tool-card[data-tool-id="call"]');
      await tool.locator('summary').click();
      await tool
        .getByRole('button', { name: 'Read complete output', exact: true })
        .click();
      await tool
        .locator('.artifact-output pre')
        .filter({ hasText: 'Early ✓' })
        .waitFor();
      await tool
        .getByRole('button', { name: 'Load more output', exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLButtonElement>('.artifact-output button')
            ?.disabled,
      );
      // Finish while the earlier running-phase request is still in flight.
      assert.ok(pending);
      snapshot = {
        ...snapshot,
        execution: 'idle',
        tools: [],
        entries: [
          {
            id: '1',
            kind: 'pi.assistant',
            text: '',
            tools: [
              {
                id: 'call',
                name: 'probe',
                arguments: '{}',
                status: 'completed',
              },
            ],
          },
          {
            id: '2',
            kind: 'pi.tool-result',
            text: '',
            tools: [
              {
                id: 'call',
                name: 'probe',
                status: 'completed',
                output: 'Final preview',
                artifact: 'task-1',
                truncated: true,
              },
            ],
          },
        ],
      };
      await pushSnapshot(page, snapshot);
      await tool.getByText('Final preview', { exact: true }).waitFor();
      release();
      await tool
        .getByRole('button', { name: 'Load more output', exact: true })
        .waitFor();
      await tool
        .locator('.artifact-output pre')
        .filter({ hasText: 'Still running' })
        .waitFor();
      await tool
        .getByRole('button', { name: 'Load more output', exact: true })
        .click();
      await tool
        .locator('.artifact-output pre')
        .filter({ hasText: 'Final output' })
        .waitFor();
      assert.deepEqual(offsets, [
        0,
        Buffer.byteLength('Early ✓'),
        Buffer.byteLength('Early ✓\nStill running'),
      ]);
      assert.equal(
        await tool.locator('.artifact-output pre').textContent(),
        'Early ✓\nStill running\nFinal output',
      );
      assert.equal(
        await tool
          .getByRole('button', { name: 'Load more output', exact: true })
          .count(),
        0,
      );
      assert.equal(await tool.getAttribute('open'), '');
      await browser.close();
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'pagination preserves a visible message when an orphan tool card moves to its older call',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), 'factory-tool-history-anchor-'),
    );
    const service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'History anchor',
        'anchor',
      );
      const entries = Array.from({ length: 16 }, (_, i) => ({
        id: String(i + 10),
        kind: i % 2 ? 'pi.assistant' : 'pi.user',
        text: `History row ${i}: ${'Readable history. '.repeat(7)}`,
        tools: [],
      }));
      const snapshot: ConversationSnapshot = {
        conversation,
        execution: 'idle',
        partial: '',
        submissions: [],
        olderCursor: 'older',
        tools: [],
        entries: [
          ...entries,
          {
            id: '30',
            kind: 'pi.tool-result',
            text: '',
            tools: [
              {
                id: 'old-call',
                name: 'probe',
                output: 'Final output',
                artifact: 'task-old-call',
                status: 'completed',
              },
            ],
          },
        ],
      };
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(6000);
      await installSnapshotStream(page, snapshot);
      await page.route('**/ag-ui/history?*', (route) =>
        route.fulfill({
          json: {
            events: viewSnapshotEvents(
              historyView(conversation.id, [
                {
                  id: '1',
                  kind: 'pi.assistant',
                  text: 'Older assistant context',
                  tools: [
                    {
                      id: 'older-neighbor',
                      name: 'read_repository',
                      arguments: '{"path":"README.md"}',
                      status: 'completed',
                    },
                    {
                      id: 'old-call',
                      name: 'probe',
                      arguments: '{}',
                      status: 'pending',
                    },
                  ],
                },
              ]),
            ),
          },
        }),
      );
      await page.route('**/artifacts/task-old-call?*', (route) =>
        route.fulfill({
          json: { text: 'Loaded output stays through history regrouping' },
        }),
      );
      await page.goto(`${service.url}/?conversation=${conversation.id}`);
      const tool = page.locator('.tool-card[data-tool-id="old-call"]');
      await tool.locator('summary').click();
      await tool.getByRole('button', { name: 'Read complete output' }).click();
      await tool
        .getByText('Loaded output stays through history regrouping', {
          exact: true,
        })
        .waitFor();
      await page.getByLabel('Conversation transcript').evaluate((element) => {
        element.scrollTop = 0;
      });
      const message = page.getByText(entries[0].text, { exact: true });
      const top = await message.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await page.getByRole('button', { name: 'Load older messages' }).click();
      await page
        .getByText('Older assistant context', { exact: true })
        .waitFor();
      const restored = await message.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      assert.ok(
        Math.abs(restored - top) < 2,
        `Visible message shifted by ${restored - top}px`,
      );
      assert.equal(await tool.count(), 1);
      assert.equal(await tool.getAttribute('open'), '');
      assert.equal(await page.locator('.tool-group').getAttribute('open'), '');
      await tool
        .getByText('Loaded output stays through history regrouping', {
          exact: true,
        })
        .waitFor();
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'conversation formatting, stable tool cards, reading position, composer keys and role restrictions',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-conversation-ui-'));
    const service = await startService({ dataDir, port: 0, chat: fixture() });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const client = new ChatClient(service.url);
      await configure(client);
      const conversation = await client.createConversation(
        'Improve conversation UI',
        'ui-test',
      );
      let snapshot: ConversationSnapshot = {
        conversation,
        execution: 'running',
        partial: '',
        submissions: [],
        entries: Array.from({ length: 22 }, (_, i) => ({
          id: String(i + 1),
          kind: i % 2 ? 'pi.assistant' : 'pi.user',
          text:
            i % 2
              ? `Response ${i}: readable conversation history.`
              : `Question ${i}: keep this reading position.`,
          tools: [],
        })),
        tools: [
          {
            id: 'read-call',
            name: 'read_file',
            arguments: '{"path":"apps/web/src/chat.tsx"}',
            status: 'running',
            output: 'Reading conversation renderer…',
          },
        ],
      };
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(6000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await installSnapshotStream(page, snapshot);
      const push = () => pushSnapshot(page, snapshot);
      await page.goto(`${service.url}/?conversation=${conversation.id}`);
      await page.locator('.agent-activity').waitFor();
      const tool = page.locator('.tool-card[data-tool-id="read-call"]');
      await tool.locator('summary').click();
      const transcript = page.getByLabel('Conversation transcript');
      await transcript.evaluate((element) => {
        element.scrollTop = 80;
      });
      await page.getByRole('button', { name: 'Jump to latest ↓' }).waitFor();
      const before = await transcript.evaluate((element) => element.scrollTop);
      snapshot = {
        ...snapshot,
        partial:
          '## A clearer conversation\n\n- Formatted **replies**\n- Unified tools\n\n```ts\nconst readable = true;\n```\n\n| Part | Change |\n| --- | --- |\n| Tools | One card |\n\n[Documentation](https://example.com)\n\n<script>window.bad = true</script><a href="javascript:alert(1)">Unsafe link</a><img src=x onerror="alert(1)">',
        tools: [],
        entries: [
          ...snapshot.entries,
          {
            id: '23',
            kind: 'pi.assistant',
            text: 'I checked the renderer.',
            tools: [
              {
                id: 'read-call',
                name: 'read_file',
                arguments: '{"path":"apps/web/src/chat.tsx"}',
                status: 'pending',
              },
            ],
          },
          {
            id: '24',
            kind: 'pi.tool-result',
            text: '',
            tools: [
              {
                id: 'read-call',
                name: 'read_file',
                status: 'completed',
                output: 'Renderer inspected.',
              },
            ],
          },
        ],
      };
      await push();
      await tool.getByText('Renderer inspected.', { exact: true }).waitFor();
      assert.equal(await tool.count(), 1);
      assert.equal(await tool.getAttribute('open'), '');
      assert.ok(
        Math.abs(
          (await transcript.evaluate((element) => element.scrollTop)) - before,
        ) < 3,
      );
      const markdown = page.locator('.markdown').last();
      assert.equal(
        await markdown.locator('h2').textContent(),
        'A clearer conversation',
      );
      assert.equal(await markdown.locator('table').count(), 1);
      assert.equal(await markdown.locator('pre code').count(), 1);
      assert.equal(
        await markdown
          .locator('script, img, [onerror], a[href^="javascript:"]')
          .count(),
        0,
      );
      await page.getByRole('button', { name: 'Jump to latest ↓' }).click();
      assert.ok(
        await transcript.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight < 3,
        ),
      );
      const input = page.getByLabel('Message', { exact: true });
      await input.fill('First line');
      await input.press('Shift+Enter');
      await input.press('End');
      assert.match(await input.inputValue(), /\n/);
      await input.dispatchEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        isComposing: true,
      });
      assert.equal((await client.history(conversation.id)).entries.length, 0);
      await input.fill('Send with Enter');
      await input.press('Enter');
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLTextAreaElement>('#chat-message')
            ?.value === '',
      );
      assert.equal(
        (await client.history(conversation.id)).entries.filter(
          (e) => e.kind === 'pi.user',
        ).length,
        1,
      );
      snapshot = {
        ...snapshot,
        conversation: { ...conversation, role: 'development' },
      };
      await push();
      await page
        .locator('.response-author > span')
        .getByText('Development agent', { exact: true })
        .last()
        .waitFor();
      snapshot = {
        ...snapshot,
        conversation: { ...conversation, role: 'review' },
      };
      await push();
      await page
        .locator('.response-author > span')
        .getByText('Review agent', { exact: true })
        .last()
        .waitFor();
      assert.equal(await input.count(), 0);
      assert.equal(
        await page
          .getByRole('button', { name: 'Interrupt conversation' })
          .count(),
        0,
      );
      snapshot = {
        ...snapshot,
        conversation: { ...conversation, role: 'development' },
        workflow: {
          runId: 'run',
          status: 'running',
          stage: 'developer',
          acceptsInput: false,
        },
      };
      await push();
      await page.getByText(/Implementation input is closed/).waitFor();
      assert.equal(await input.count(), 0);
      assert.ok(
        await page
          .getByRole('button', { name: 'Interrupt conversation' })
          .isEnabled(),
      );
      snapshot = { ...snapshot, conversation, workflow: undefined };
      await push();
      await input.waitFor();
      await mkdir(resolve('test-results'), { recursive: true });
      await page.screenshot({
        path: resolve('test-results/conversation-redesign-desktop.png'),
      });
      for (const width of [1024, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        assert.ok(
          await page
            .locator('.composer')
            .evaluate(
              (element) =>
                element.getBoundingClientRect().bottom <= innerHeight,
            ),
        );
        await page.screenshot({
          path: resolve(`test-results/conversation-redesign-${width}.png`),
        });
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
