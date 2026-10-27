import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventSchema } from '@ag-ui/core/schemas';
import { simulationAdapter } from '../apps/server/src/workflow.js';
import { AgUiRunActivityClient } from '../packages/shared/src/index.js';
import { workflowFixture } from './fixtures/workflow.js';
import { until } from './fixtures/chat.js';
import { context } from '../apps/server/src/storage.js';
import { fauxAssistantMessage } from '../apps/server/src/chat-fixtures.js';

test(
  'AG-UI developer guidance uses workflow admission and combined activity retains both agents',
  { timeout: 20000 },
  async () => {
    const adapter = simulationAdapter();
    const execute = adapter.execute;
    let release: (() => void) | undefined;
    let held = false;
    adapter.execute = async (run, attempt, signal) => {
      if (attempt.stage === 'checks' && !held) {
        held = true;
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      }
      return execute(run, attempt, signal);
    };
    const s = await workflowFixture(adapter);
    let stop: (() => void) | undefined;
    try {
      let run = await s.client.startRun(await s.issue(), 'ag-ui-workflow');
      run = await until(
        () => s.client.run(run.id),
        (value) => value.stage === 'checks' && Boolean(release),
      );
      const headers = {
        'Content-Type': 'application/json',
        'X-Factory-CSRF': (
          await (await fetch(`${s.service.url}/api/v1/session`)).json()
        ).csrfToken,
      };
      const input = {
        threadId: run.developerConversationId,
        runId: 'developer-exchange',
        protocolVersion: '1.0',
        messages: [
          {
            id: 'developer-message',
            role: 'user',
            content: 'Keep the change focused',
          },
        ],
      };
      const send = (body: unknown) =>
        fetch(`${s.service.url}/api/v1/ag-ui/run`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      const response = await send(input);
      assert.equal(response.status, 200);
      const queued = await s.chat.submission(
        run.developerConversationId,
        (
          await s.service.chat!.activitySnapshot(run.developerConversationId)
        ).submissions.find(
          (item) => item.content === 'Keep the change focused',
        )!.requestId,
      );
      assert.equal(queued.status, 'queued');
      const activity = new AgUiRunActivityClient(s.service.url);
      let connected = false;
      stop = activity.watch(
        run.id,
        () => {},
        (value) => {
          connected = value;
        },
      );
      await until(async () => connected, Boolean);
      // Steering remains a separately authorized factory operation.
      await s.chat.submit(
        run.developerConversationId,
        'Preserve the existing API',
        'factory-steering',
        'steer',
      );
      release!();
      const text = await response.text();
      const events = text
        .split('\n\n')
        .filter((frame) => frame.startsWith('data:'))
        .map((frame) => JSON.parse(frame.slice(5)));
      for (const event of events) EventSchema.parse(event);
      assert.equal(events.at(-1).type, 'RUN_FINISHED');
      run = await until(
        () => s.client.run(run.id),
        (value) => value.status === 'pr_ready',
      );
      assert.equal(
        run.inputs.filter((item) => item.content === 'Keep the change focused')
          .length,
        1,
      );
      assert.equal(
        run.inputs.find((item) => item.content === 'Keep the change focused')!
          .status,
        'consumed',
      );
      const reviewerId = run.attempts.find(
        (attempt) => attempt.stage === 'reviewer',
      )!.conversationId;
      // Simulation does not generate model messages; persist controlled replies
      // in both actual conversations to exercise the combined protocol projection.
      await s.service.workflow['harness'].commit(async (tx) => {
        for (const id of [run.developerConversationId, reviewerId])
          await tx.appendEntry(Number(id) as never, {
            kind: 'pi.assistant',
            model: [fauxAssistantMessage(`Reply from ${id}`)],
          });
      }, context);
      const page = await activity.activity(run.id, undefined, 100);
      assert.ok(
        page.items.some(
          (item) => item.conversationId === run.developerConversationId,
        ),
      );
      assert.ok(
        page.items.some(
          (item) =>
            item.conversationId ===
            run.attempts.find((attempt) => attempt.stage === 'reviewer')!
              .conversationId,
        ),
      );
      assert.equal(
        (
          await send({
            ...input,
            runId: 'late',
            messages: [
              { id: 'late', role: 'user', content: 'Make another change' },
            ],
          })
        ).status,
        409,
      );
      assert.equal(
        (await send({ ...input, runId: 'reviewer', threadId: reviewerId }))
          .status,
        403,
      );
    } finally {
      stop?.();
      release?.();
      await s.close();
    }
  },
);

test(
  'a workflow question closes an AG-UI exchange without consuming or duplicating queued input',
  { timeout: 20000 },
  async () => {
    const adapter = simulationAdapter();
    const execute = adapter.execute;
    adapter.execute = async (run, attempt, signal) =>
      attempt.stage === 'developer'
        ? {
            outcome: 'needs_input',
            message: 'Which behavior should be implemented?',
          }
        : execute(run, attempt, signal);
    const s = await workflowFixture(adapter);
    try {
      let run = await s.client.startRun(await s.issue(), 'needs-input');
      run = await until(
        () => s.client.run(run.id),
        (value) => value.status === 'needs_input',
      );
      const headers = {
        'Content-Type': 'application/json',
        'X-Factory-CSRF': (
          await (await fetch(`${s.service.url}/api/v1/session`)).json()
        ).csrfToken,
      };
      const response = await fetch(`${s.service.url}/api/v1/ag-ui/run`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          threadId: run.developerConversationId,
          runId: 'waiting-exchange',
          messages: [
            {
              id: 'waiting-message',
              role: 'user',
              content: 'Some guidance for later',
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const events = (await response.text())
        .split('\n\n')
        .filter((frame) => frame.startsWith('data:'))
        .map((frame) => JSON.parse(frame.slice(5)));
      assert.equal(events.at(-1).type, 'RUN_FINISHED');
      assert.equal(events.at(-1).result.factory.awaitingInput, true);
      assert.equal((await s.client.run(run.id)).status, 'needs_input');
      assert.equal((await s.client.run(run.id)).inputs[0].status, 'queued');
    } finally {
      await s.close();
    }
  },
);
