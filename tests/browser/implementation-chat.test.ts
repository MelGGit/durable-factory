import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workflowFixture } from '../fixtures/workflow.js';
import { simulationAdapter } from '../../apps/server/src/workflow.js';
import { Processes } from '../../apps/server/src/processes.js';
import { context } from '../../apps/server/src/storage.js';
import { fauxAssistantMessage } from '../../apps/server/src/chat-fixtures.js';
import { until } from '../fixtures/chat.js';
import {
  activityView,
  viewSnapshotEvents,
  type RunActivityItem,
} from '../../packages/shared/src/index.js';
import { installAgUiStream } from './ag-ui-stream.js';

test(
  'implementation chat retains live command updates outside the history window, paginates, and stays independent from planning',
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
      let run = await fixture.client.startRun(
        planning,
        'implementation-window',
      );
      run = await until(
        () => fixture.client.run(run.id),
        (r) => r.stage === 'developer',
      );
      const harness = fixture.service.workflow['harness'];
      const folder = join(fixture.dataDir, 'artifacts', 'commands');
      await mkdir(folder, { recursive: true });
      const artifact = join(folder, 'preview.log');
      await writeFile(artifact, 'Early output');
      const startedAt = Date.now();
      await harness.commit(async (tx) => {
        const processes = await tx.doc(Processes);
        processes.records.preview = {
          id: 'preview',
          runId: run.id,
          attemptId: run.attempts.at(-1)!.id,
          command: 'preview-command',
          state: 'authorized',
          descendants: [],
          startedAt,
          artifact,
        };
        for (let i = 0; i < 125; i++)
          await tx.appendEntry(Number(run.developerConversationId) as never, {
            kind: 'pi.assistant',
            model: [
              {
                ...fauxAssistantMessage(`Development update ${i}`),
                timestamp: startedAt + i + 1,
              },
            ],
          });
      }, context);
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(
        `${fixture.service.url}/?conversation=${run.developerConversationId}`,
      );
      await page.waitForURL(`**/?conversation=${run.developerConversationId}`);
      const command = page
        .locator('.run-event')
        .filter({ has: page.getByText('preview-command', { exact: true }) });
      await command.locator('summary').click();
      await command.getByText('Early output', { exact: true }).waitFor();
      await appendFile(artifact, '\nFinal output');
      await harness.commit(async (tx) => {
        const record = (await tx.doc(Processes)).records.preview;
        record.state = 'finished';
        record.exitCode = 0;
        record.finishedAt = Date.now();
      }, context);
      await command.getByText('Exit 0', { exact: true }).waitFor();
      await command
        .getByText('Early output\nFinal output', { exact: true })
        .waitFor();
      while (
        await page
          .getByRole('button', { name: 'Load older activity', exact: true })
          .count()
      ) {
        await page
          .getByRole('button', { name: 'Load older activity', exact: true })
          .click();
        await until(
          async () =>
            page
              .getByRole('button', { name: 'Load older activity', exact: true })
              .isDisabled()
              .catch(() => false),
          (disabled) => !disabled,
        );
      }
      assert.equal(
        await page
          .locator('.implementation-events .message-text')
          .filter({ hasText: /^Development update \d+$/ })
          .count(),
        125,
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'View activity', exact: true })
          .count(),
        0,
      );
      await page
        .getByLabel('Message', { exact: true })
        .fill('Draft implementation guidance');
      await page
        .getByRole('navigation', { name: /sessions$/ })
        .getByRole('button', { name: /^Workflow plan/ })
        .click();
      await page.waitForURL(`**/?conversation=${planning}`);
      assert.equal(await page.locator('.implementation-events').count(), 0);
      assert.equal(
        await page.locator('.page-cards').count(),
        0,
        'Run cards clear when returning to planning',
      );
      assert.equal(
        await page.getByText('Development update 124', { exact: true }).count(),
        0,
      );
      await page.goBack();
      await page.waitForURL(`**/?conversation=${run.developerConversationId}`);
      assert.equal(
        await page.getByLabel('Message', { exact: true }).inputValue(),
        'Draft implementation guidance',
      );
      await page
        .getByRole('heading', { name: 'Information', exact: true })
        .waitFor();
      assert.equal(
        await page.locator('[data-card-id="run-ticket"]').count(),
        0,
      );
      await page.reload();
      await page.getByText('Development update 124', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await fixture.close();
    }
  },
);

test(
  'an explicit planner start opens its independent implementation and returning to planning keeps it selected',
  { timeout: 30000 },
  async () => {
    const fixture = await workflowFixture();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
      });
      const planning = await fixture.issue();
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(10000);
      await page.goto(`${fixture.service.url}/?conversation=${planning}`);
      await page
        .getByLabel('Message', { exact: true })
        .fill('start implementation');
      await page.getByRole('button', { name: 'Send', exact: false }).click();
      const run = await until(
        async () => (await fixture.client.workflow()).runs[0],
        (value) => Boolean(value),
      );
      await page.waitForURL(`**/?conversation=${run.developerConversationId}`);
      await page
        .getByRole('link', { name: 'Open planning conversation', exact: true })
        .click();
      await page.waitForURL(`**/?conversation=${planning}`);
      await page
        .getByRole('button', { name: 'Start simulated run', exact: true })
        .waitFor();
      assert.equal(
        new URL(page.url()).searchParams.get('conversation'),
        planning,
      );
      await page
        .getByRole('button', { name: 'Start simulated run', exact: true })
        .click();
      await page.waitForURL(`**/?conversation=${run.developerConversationId}`);
      assert.equal((await fixture.client.workflow()).runs.length, 1);
    } finally {
      await browser?.close();
      await fixture.close();
    }
  },
);

test(
  'two implementation tabs keep requests and pause controls responsive',
  { timeout: 30000 },
  async () => {
    const adapter = simulationAdapter(),
      execute = adapter.execute;
    adapter.execute = (run, attempt, signal) =>
      attempt.stage === 'developer'
        ? new Promise(() => {})
        : execute(run, attempt, signal);
    const fixture = await workflowFixture(adapter);
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const admitted = await fixture.client.startRun(
        await fixture.issue(),
        'two-tabs',
      );
      const run = await until(
        () => fixture.client.run(admitted.id),
        (r) => r.stage === 'developer',
      );
      // Pages must share a context to exercise the browser's per-origin connection limit.
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const first = await context.newPage(),
        second = await context.newPage();
      for (const page of [first, second]) {
        page.setDefaultTimeout(10000);
        await page.goto(
          `${fixture.service.url}/?conversation=${run.developerConversationId}`,
        );
        await page
          .locator('.chat-conversation[data-activity="connected"]')
          .waitFor();
      }
      const result = await first.evaluate(async () => {
        const response = await fetch('/health', {
          signal: AbortSignal.timeout(3000),
        });
        return response.status;
      });
      assert.equal(result, 200);
      await first
        .getByRole('button', { name: 'Pause run', exact: true })
        .click();
      await second
        .getByRole('button', { name: 'Resume run', exact: true })
        .waitFor();
      await first
        .getByLabel('Message', { exact: true })
        .fill('Keep this guidance queued');
      await first.getByRole('button', { name: 'Send', exact: false }).click();
      await second
        .getByText('Keep this guidance queued', { exact: true })
        .first()
        .waitFor();
      assert.equal((await fixture.client.run(run.id)).status, 'paused');
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
);

test(
  'expanded tool output survives live history commits and loading older calls',
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
      const run = await fixture.client.startRun(
        await fixture.issue(),
        'stable-tool',
      );
      await until(
        () => fixture.client.run(run.id),
        (r) => r.status === 'pr_ready',
      );
      const conversationId = run.developerConversationId;
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(10000);
      const tool = {
        id: 'stable-call',
        name: 'worktree_read',
        status: 'running' as const,
        output: 'Early preview',
        artifact: 'task-1',
      };
      const initial = {
        items: [],
        live: [
          { conversationId, role: 'development', partial: '', tools: [tool] },
        ],
      };
      const emit = await installAgUiStream(page, {
        match: '/activity/ag-ui/events',
        threadId: run.id,
        view: activityView,
        initial,
      });
      await page.route('**/artifacts/task-1?*', (route) =>
        route.fulfill({ json: { text: 'Complete output stays loaded' } }),
      );
      await page.goto(`${fixture.service.url}/?conversation=${conversationId}`);
      const card = page
        .locator('.implementation-events details')
        .filter({ hasText: 'worktree_read' });
      await card.locator('summary').click();
      await card
        .getByRole('button', { name: 'Read complete output', exact: true })
        .click();
      await card
        .getByText('Complete output stays loaded', { exact: true })
        .waitFor();
      const call: RunActivityItem = {
        id: `entry:${conversationId}:9999`,
        at: Date.now(),
        actor: 'development',
        title: 'Developer agent',
        conversationId,
        entry: {
          id: '9999',
          kind: 'pi.assistant',
          text: '',
          tools: [
            {
              id: tool.id,
              name: tool.name,
              status: 'pending',
              arguments: '{}',
            },
          ],
        },
      };
      await emit({ ...initial, items: [call] });
      await card.getByText('{}', { exact: true }).last().waitFor();
      await card
        .getByText('Complete output stays loaded', { exact: true })
        .waitFor();
      assert.equal(await card.getAttribute('open'), '');
      const result = {
        ...call,
        id: `entry:${conversationId}:10000`,
        at: Date.now() + 1,
        entry: {
          id: '10000',
          kind: 'pi.tool-result',
          text: '',
          tools: [{ ...tool, status: 'completed' }],
        },
      };
      // The call can initially be outside the loaded history window.
      emit.startFrom(initial);
      await page.reload();
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { __agUiPush?: unknown }).__agUiPush ===
          'function',
      );
      await emit({ items: [result], live: [], cursor: 'older-call' });
      await card
        .locator('.tool-status')
        .getByText('completed', { exact: true })
        .waitFor();
      await card.locator('summary').click();
      await card
        .getByRole('button', { name: 'Read complete output', exact: true })
        .click();
      await card
        .getByText('Complete output stays loaded', { exact: true })
        .waitFor();
      await page.route('**/activity/ag-ui?*', (route) =>
        route.fulfill({
          json: {
            events: viewSnapshotEvents(
              activityView({ items: [call], live: [] }),
            ),
          },
        }),
      );
      await page
        .getByRole('button', { name: 'Load older activity', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Load older activity', exact: true })
        .waitFor({ state: 'detached' });
      assert.equal(await card.getAttribute('open'), '');
      await card
        .getByText('Complete output stays loaded', { exact: true })
        .waitFor();
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
);

test(
  'header toggles information and usage cards, run controls stay inside information, and all viewports fit',
  { timeout: 30000 },
  async () => {
    const adapter = simulationAdapter(),
      execute = adapter.execute;
    adapter.execute = (run, attempt, signal) =>
      attempt.stage === 'developer'
        ? new Promise(() => {})
        : execute(run, attempt, signal);
    const fixture = await workflowFixture(adapter);
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const admitted = await fixture.client.startRun(
        await fixture.issue(),
        'page-cards',
      );
      const run = await until(
        () => fixture.client.run(admitted.id),
        (r) => r.stage === 'developer',
      );
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(7000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route(`**/runs/${run.id}/inspection`, (route) =>
        route.fulfill({
          json: {
            commands: [],
            conversations: [
              {
                id: 'development',
                role: 'development',
                tools: [],
                usage: {
                  input: 1200,
                  output: 300,
                  cacheRead: 600,
                  cacheWrite: 10,
                  messages: 2,
                  estimatedCost: 0.0123,
                  partial: false,
                },
              },
              {
                id: 'review',
                role: 'review',
                tools: [],
                usage: {
                  input: 800,
                  output: 100,
                  cacheRead: 200,
                  cacheWrite: 0,
                  messages: 1,
                  estimatedCost: 0.0045,
                  partial: false,
                },
              },
              {
                id: 'repair',
                role: 'development',
                tools: [],
                usage: {
                  input: 300,
                  output: 50,
                  cacheRead: 100,
                  cacheWrite: 5,
                  messages: 1,
                  partial: true,
                },
              },
            ],
          },
        }),
      );
      await page.goto(
        `${fixture.service.url}/?conversation=${run.developerConversationId}`,
      );
      await page
        .getByRole('region', { name: 'Information', exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator('.implementation-sidebar, .run-sidebar-tabs')
          .count(),
        0,
      );
      const conversation = await page
        .getByRole('region', { name: 'Conversation', exact: true })
        .boundingBox();
      const cards = await page
        .getByRole('region', { name: 'Chat trails', exact: true })
        .boundingBox();
      assert.ok(
        conversation && cards && cards.x >= conversation.x + conversation.width,
      );
      const checkImplementationStyle = async (sidebarVisible = true) => {
        await page
          .locator('.chat-header .mode-tag')
          .getByText('Implementation', { exact: true })
          .waitFor();
        const colors = await page
          .locator('[data-card-id="run-information"]')
          .evaluate((card) => {
            const step = card.querySelector('[aria-current="step"]')!;
            const badge = card.querySelector('.run-status-badge')!;
            return {
              step: getComputedStyle(step, '::before').backgroundColor,
              text: getComputedStyle(card).color,
              badge: getComputedStyle(badge).color,
            };
          });
        assert.equal(
          colors.step,
          colors.text,
          'current progress step uses neutral text color',
        );
        assert.equal(
          colors.badge,
          colors.text,
          'progress status uses neutral text color',
        );
        if (sidebarVisible) {
          const colors = await page
            .locator('.chat-sidebar:visible')
            .evaluate((sidebar) => ({
              implementation: getComputedStyle(
                sidebar.querySelector('.session-kind.implementation')!,
              ).color,
              planning: getComputedStyle(
                sidebar.querySelector('.session-kind[aria-label="Planning"]')!,
              ).color,
            }));
          assert.equal(
            colors.implementation,
            colors.planning,
            'session icons share the same neutral color',
          );
        }
      };
      await checkImplementationStyle();
      const information = page.locator('.page-cards');
      assert.deepEqual(
        await information.locator('.page-card-heading h2').allTextContents(),
        ['Information', 'Usage'],
      );
      const usage = page.getByRole('region', { name: 'Usage', exact: true });
      await usage.getByText('2,300', { exact: true }).waitFor();
      await usage.getByText('450', { exact: true }).waitFor();
      await usage.getByText('900', { exact: true }).waitFor();
      await usage.getByText('15', { exact: true }).waitFor();
      await usage.getByText('1,500 in · 350 out', { exact: true }).waitFor();
      await usage.getByText('$0.0168', { exact: true }).waitFor();
      await usage
        .getByText('Cost includes available estimates only.', { exact: true })
        .waitFor();
      await usage
        .getByText(
          'Partial usage; some history or token counts are unavailable.',
          { exact: true },
        )
        .waitFor();
      const informationCard = page.getByRole('region', {
        name: 'Information',
        exact: true,
      });
      await informationCard
        .getByRole('button', { name: 'Pause run', exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator(
            '[data-card-id="models"], [data-card-id="configuration"], [data-card-id="run-controls"]',
          )
          .count(),
        0,
      );
      await page
        .getByRole('button', { name: 'Pause run', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Resume run', exact: true })
        .waitFor();
      const chatGeometry = () =>
        page.evaluate(() => ({
          viewport: { width: window.innerWidth, height: window.innerHeight },
          elements: [
            '.chat-conversation',
            '.composer-area',
            '.chat-header h1',
          ].map((selector) => {
            const { x, y, width, height } = document
              .querySelector(selector)!
              .getBoundingClientRect();
            return { x, y, width, height };
          }),
        }));
      const geometryBefore = await chatGeometry();
      await page
        .locator('.chat-header')
        .getByRole('button', { name: 'Hide chat trails', exact: true })
        .click();
      assert.equal(await page.locator('.page-cards').isVisible(), false);
      assert.deepEqual(
        await chatGeometry(),
        geometryBefore,
        'hiding chat trails preserves the viewport and chat layout',
      );
      assert.equal(
        await page.locator('#page-information').getAttribute('inert'),
        '',
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'Show chat trails', exact: true })
          .getAttribute('aria-expanded'),
        'false',
      );
      await page
        .getByRole('button', { name: 'Show chat trails', exact: true })
        .click();
      await informationCard
        .getByRole('button', { name: 'Resume run', exact: true })
        .waitFor();
      assert.deepEqual(
        await chatGeometry(),
        geometryBefore,
        'showing chat trails preserves the viewport and chat layout',
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'Hide chat trails', exact: true })
          .getAttribute('aria-expanded'),
        'true',
      );
      await mkdir('test-results', { recursive: true });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.colorScheme = theme;
        }, colorScheme);
        for (const width of [1440, 1200, 1024, 390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          if (width < 1200) {
            const trigger = page.getByRole('button', {
              name: 'Show chat trails',
              exact: true,
            });
            await trigger.click();
            await page
              .getByRole('dialog', { name: 'Chat trails', exact: true })
              .waitFor();
          }
          await checkImplementationStyle(width >= 760);
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
          const overflow = await page
            .locator('.page-cards')
            .evaluate((el) => el.scrollWidth > el.clientWidth);
          assert.equal(overflow, false, `${colorScheme}, ${width}px`);
          if (width === 1440 || width === 390) {
            const cardsScroll = page.locator(
              width < 1200 ? '.page-cards-overlay' : '.page-cards',
            );
            await cardsScroll.evaluate((el) => (el.scrollTop = 0));
            await page.screenshot({
              path: `test-results/run-information-${colorScheme}-${width}.png`,
            });
            await cardsScroll.evaluate(
              (el) => (el.scrollTop = el.scrollHeight),
            );
            await page.screenshot({
              path: `test-results/run-details-${colorScheme}-${width}.png`,
            });
          }
          if (width < 1200) {
            await page.keyboard.press('Escape');
            assert.ok(
              await page
                .getByRole('button', { name: 'Show chat trails', exact: true })
                .evaluate((el) => el === document.activeElement),
            );
          }
        }
      }
      await page.goto(`${fixture.service.url}/settings`);
      await page
        .getByRole('heading', { name: 'Appearance', exact: true })
        .waitFor();
      assert.equal(await page.locator('.page-cards').count(), 0);
      assert.equal(
        await page
          .getByRole('button', { name: 'Show chat trails', exact: true })
          .count(),
        0,
      );
      await page.goBack();
      await page
        .getByRole('button', { name: 'Show chat trails', exact: true })
        .click();
      await page
        .getByRole('region', { name: 'Information', exact: true })
        .waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
);
