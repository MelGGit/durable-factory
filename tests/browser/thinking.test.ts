import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startService } from '../helpers/credentials.js';
import { fixture, configure } from '../fixtures/chat.js';
import {
  ChatClient,
  conversationView,
  type ConversationSnapshot,
  type TranscriptEntry,
} from '../../packages/shared/src/index.js';
import { installAgUiStream } from './ag-ui-stream.js';

test(
  'thinking remains compact, ordered, independently expandable, and stable through streaming and saved history',
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-thinking-ui-'));
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
        'Thinking flow',
        'thinking-flow',
      );
      let snapshot: ConversationSnapshot = {
        conversation,
        entries: [
          {
            id: '1',
            kind: 'pi.user',
            text: 'Check validation coverage.',
            tools: [],
          },
        ],
        partial: '',
        tools: [],
        submissions: [],
        execution: 'running',
        olderCursor: 'older',
        liveParts: [
          {
            id: 'generation:thinking',
            type: 'thinking',
            text: '### Checking validation coverage\n\nThe **form tests** need one more case.',
          },
        ],
      };
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      page.setDefaultTimeout(6000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() =>
        localStorage.setItem('factory.theme.v1', 'system'),
      );
      const push = await installAgUiStream(page, {
        channel: `chat:${conversation.id}`,
        threadId: conversation.id,
        view: conversationView,
        initial: snapshot,
      });
      let artifactReads = 0;
      await page.route('**/artifacts/entry-4-part-0-0?*', (route) => {
        artifactReads++;
        return route.fulfill({
          json: { text: 'Complete thinking supplied by the provider.' },
        });
      });
      await page.goto(`${service.url}/?conversation=${conversation.id}`);
      const thought = page.locator('[data-thinking-id="generation:thinking"]');
      await thought.locator('summary').waitFor();
      await expect(thought).not.toHaveAttribute('open');
      await expect(thought.locator('.thinking-label')).toHaveText('Thinking…');
      await expect(thought.locator('.thinking-preview')).toHaveText(
        'Checking validation coverage',
      );
      await expect(thought.locator('.thinking-content')).toBeHidden();
      assert.equal(
        await page.locator('.response-text > .message-text').count(),
        0,
        'Thinking is not response prose',
      );
      await thought.locator('summary').click();
      await expect(thought.locator('.thinking-content')).toBeVisible();
      snapshot = {
        ...snapshot,
        liveParts: [
          {
            ...snapshot.liveParts![0],
            type: 'thinking',
            text: '### Checking validation coverage\n\nThe **form tests** need one more case. Checking the error state too.',
          },
        ],
      };
      await push(snapshot);
      await expect(thought.locator('.thinking-content')).toContainText(
        'Checking the error state too.',
      );
      await expect(thought).toHaveAttribute('open', '');
      const parts = [
        ...snapshot.liveParts!,
        { id: 'generation:tool', type: 'tool' as const, toolId: 'coverage' },
        {
          id: 'generation:answer',
          type: 'text' as const,
          text: 'Checking validation coverage is complete.\n\nThe tests cover the error state.',
        },
      ];
      snapshot = {
        ...snapshot,
        liveParts: parts,
        partial:
          'Checking validation coverage is complete.\n\nThe tests cover the error state.',
        tools: [
          {
            id: 'coverage',
            name: 'worktree_command',
            arguments: '{"command":"bun test"}',
            status: 'completed',
            output: 'Passed',
          },
        ],
      };
      await push(snapshot);
      await expect(thought.locator('.thinking-label')).toHaveText('Thinking');
      await expect(
        page.locator('.response-text > .message-text'),
      ).toContainText('The tests cover the error state.');
      await expect(thought).toHaveAttribute('open', '');
      const response = page.locator('.agent-response');
      assert.equal(await response.count(), 1);
      assert.deepEqual(
        await response
          .locator(
            '.thinking-activity, [data-tool-id], .response-text > .message-text',
          )
          .evaluateAll((nodes) =>
            nodes.map((node) =>
              node.matches('.thinking-activity')
                ? 'thinking'
                : node.matches('[data-tool-id]')
                  ? 'tool'
                  : 'text',
            ),
          ),
        ['thinking', 'tool', 'text'],
      );
      const saved: TranscriptEntry = {
        id: '3',
        kind: 'pi.assistant',
        text: snapshot.partial,
        parts,
        tools: snapshot.tools,
      };
      snapshot = {
        ...snapshot,
        entries: [...snapshot.entries, saved],
        liveParts: undefined,
        partial: '',
        tools: [],
        execution: 'idle',
      };
      await push(snapshot);
      await expect(thought).toHaveAttribute('open', '');
      assert.equal(await page.locator('.thinking-activity').count(), 1);
      // Adding older history changes the containing response's first key.
      snapshot = {
        ...snapshot,
        entries: [
          snapshot.entries[0],
          {
            id: '2',
            kind: 'pi.assistant',
            text: 'I will inspect the tests.',
            tools: [],
          },
          ...snapshot.entries.slice(1),
        ],
      };
      await push(snapshot);
      await expect(thought).toHaveAttribute('open', '');
      await page.evaluate(async () => {
        const stream = window as unknown as {
          __agUiInit(): Promise<string>;
          __agUiPush(data: string): void;
        };
        stream.__agUiPush(await stream.__agUiInit());
      });
      await expect(thought).toHaveAttribute('open', '');
      await thought.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(thought).not.toHaveAttribute('open');
      await page.keyboard.press('Space');
      await expect(thought).toHaveAttribute('open', '');
      const styles = await thought.evaluate((element) => {
        const summary = getComputedStyle(element.querySelector('summary')!);
        const heading = getComputedStyle(element.querySelector('h3')!);
        return {
          size: summary.fontSize,
          weight: summary.fontWeight,
          headingSize: heading.fontSize,
          headingWeight: heading.fontWeight,
          sameFamily:
            summary.fontFamily === getComputedStyle(document.body).fontFamily,
        };
      });
      assert.deepEqual(styles, {
        size: '14px',
        weight: '400',
        headingSize: '14px',
        headingWeight: '400',
        sameFamily: true,
      });
      // A full reload starts collapsed; completed and thinking-only entries remain visible.
      snapshot = {
        ...snapshot,
        entries: [
          ...snapshot.entries,
          {
            id: '4',
            kind: 'pi.assistant',
            text: '',
            tools: [],
            interrupted: true,
            parts: [
              {
                id: 'long-thinking',
                type: 'thinking',
                text: 'Considering the remaining validation cases. '.repeat(
                  200,
                ),
                artifact: 'entry-4-part-0-0',
              },
            ],
          },
        ],
      };
      await push(snapshot);
      const longThought = page.locator('[data-thinking-id="long-thinking"]');
      await expect(longThought).not.toHaveAttribute('open');
      await longThought.locator('summary').click();
      await longThought
        .getByRole('button', { name: 'Read complete thinking' })
        .click();
      await expect(longThought.locator('.artifact-output')).toContainText(
        'Complete thinking supplied by the provider.',
      );
      assert.equal(artifactReads, 1);
      await page.reload();
      await expect(thought).not.toHaveAttribute('open');
      await expect(longThought).not.toHaveAttribute('open');
      assert.equal(await page.locator('.thinking-activity').count(), 2);
      await mkdir(resolve('test-results'), { recursive: true });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await page.reload();
        await thought.waitFor();
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme',
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
            path: resolve(`test-results/thinking-${colorScheme}-${width}.png`),
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
