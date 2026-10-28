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
  agUiViewEvents,
  type RunActivityItem,
} from '../../packages/shared/src/index.js';

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
      await page.goto(`${fixture.service.url}/runs#${run.id}`);
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
        .getByRole('button', { name: /^Planning Workflow plan/ })
        .click();
      await page.waitForURL(`**/?conversation=${planning}`);
      assert.equal(await page.locator('.implementation-events').count(), 0);
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
      await page.getByRole('tab', { name: 'Ticket', exact: true }).click();
      await page
        .getByRole('heading', { name: 'Acceptance criteria', exact: true })
        .waitFor();
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
        await page.getByText(/activity connected/).waitFor();
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
      await page.addInitScript(
        ({ initial }) => {
          const original = window.fetch;
          const state = window as typeof window & {
            emitActivity: (snapshot: unknown) => void;
          };
          window.fetch = (input, init) => {
            if (String(input).includes('/activity/ag-ui/events')) {
              let sequence = 0;
              return Promise.resolve(
                new Response(
                  new ReadableStream({
                    start(controller) {
                      state.emitActivity = (snapshot) =>
                        controller.enqueue(
                          new TextEncoder().encode(
                            `data: ${JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: { factory: { schemaVersion: 1, kind: 'activity', apiVersion: 'v1', streamId: 'test', sequence: ++sequence, type: sequence === 1 ? 'snapshot' : 'update', snapshot } } })}\n\n`,
                          ),
                        );
                      state.emitActivity(initial);
                      init?.signal?.addEventListener('abort', () =>
                        controller.close(),
                      );
                    },
                  }),
                  { headers: { 'Content-Type': 'text/event-stream' } },
                ),
              );
            }
            return original(input, init);
          };
        },
        { initial },
      );
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
      const emit = async (snapshot: unknown) =>
        page.evaluate((snapshot) => {
          (
            window as typeof window & {
              emitActivity: (snapshot: unknown) => void;
            }
          ).emitActivity(snapshot);
        }, snapshot);
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
      await page.reload();
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { emitActivity?: unknown })
            .emitActivity === 'function',
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
            events: agUiViewEvents(
              {
                apiVersion: 'v1',
                streamId: 'page',
                sequence: 1,
                type: 'snapshot',
                snapshot: { items: [call], live: [] },
              },
              'activity',
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
