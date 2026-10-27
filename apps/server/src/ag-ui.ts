import { EventEncoder } from '@ag-ui/encoder';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import type { BaseEvent } from '@ag-ui/core';
import type { ServerResponse } from 'node:http';
import {
  AG_UI_VERSION,
  ApiError,
  AgUiConversationEvents,
  agUiViewEvents,
  type ChatFrame,
  type RunActivityFrame,
  type ConversationSnapshot,
  type TranscriptEntry,
} from '../../../packages/shared/src/index.js';
import type { ChatService } from './chat.js';

const encoder = new EventEncoder({ accept: 'text/event-stream' });
export const encodeAgUi = (events: BaseEvent[]) =>
  events.map((event) => encoder.encode(event)).join('');
export const encodeAgUiConversation = (frame: ChatFrame) => ({
  payload: encodeAgUi(agUiViewEvents(frame, 'conversation')),
});
export const encodeAgUiActivity = (frame: RunActivityFrame) =>
  encodeAgUi(agUiViewEvents(frame, 'activity'));

export function agUiSnapshot(snapshot: ConversationSnapshot) {
  return agUiViewEvents(
    {
      apiVersion: 'v1',
      streamId: 'snapshot',
      sequence: 1,
      type: 'snapshot',
      snapshot,
    },
    'conversation',
  );
}

/** Restore durable presentation history independently of bounded live windows.
 * Cursors fix each older page's upper bound even if work commits during a read. */
async function historySince(chat: ChatService, id: string, after = '0') {
  const entries: TranscriptEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await chat.history(id, cursor, 100);
    entries.unshift(
      ...page.entries.filter((entry) => Number(entry.id) > Number(after)),
    );
    if (page.entries.some((entry) => Number(entry.id) <= Number(after))) break;
    cursor = page.cursor;
  } while (cursor);
  return entries;
}

export async function runAgUi(
  chat: ChatService,
  value: unknown,
  res: ServerResponse,
) {
  const parsed = RunAgentInputSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError('INVALID_INPUT', 'Invalid AG-UI RunAgentInput.', 400);
  const input = parsed.data;
  if (input.protocolVersion && input.protocolVersion !== AG_UI_VERSION)
    throw new ApiError(
      'UNSUPPORTED_VERSION',
      'This endpoint supports AG-UI 1.0.',
      400,
    );
  if (input.tools.length || input.resume?.length)
    throw new ApiError(
      'INVALID_INPUT',
      'Frontend tools and AG-UI resume actions are not supported. Use the factory control APIs.',
      400,
    );
  const message = input.messages.at(-1);
  if (
    !message ||
    message.role !== 'user' ||
    !message.id ||
    message.id.length > 512 ||
    /^\d+:(entry|live|result):/.test(message.id) ||
    !input.runId ||
    input.runId.length > 512
  )
    throw new ApiError(
      'INVALID_INPUT',
      'End the input with a user message with a stable ID; run and message IDs must be 1–512 characters.',
      400,
    );
  const content =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
  if (!content.trim() || Buffer.byteLength(content) > 32768)
    throw new ApiError(
      'INVALID_INPUT',
      'Provide non-empty user text of at most 32 KiB.',
      400,
    );
  // Capture history before admitting this message so fast new replies still
  // produce generation events, while earlier work only hydrates the client.
  const history = await historySince(chat, input.threadId);
  let newestEntry = history.at(-1)?.id ?? '0';
  const admission = await chat.submitAgUi(
    input.threadId,
    input.runId,
    message.id,
    content,
  );
  const projection = new AgUiConversationEvents(
    input.threadId,
    input.runId,
    history,
  );
  let started = false;
  await chat.stream(
    input.threadId,
    res,
    async (frame) => {
      const events: BaseEvent[] = [];
      if (!started) {
        events.push({
          type: 'RUN_STARTED',
          threadId: input.threadId,
          runId: input.runId,
          protocolVersion: AG_UI_VERSION,
        } as BaseEvent);
        started = true;
      }
      // The bounded view may have evicted an old receipt; resolve this exchange
      // directly rather than inferring completion from the conversation's status.
      const submission = await chat.lookup(input.threadId, admission.requestId);
      const terminal = [
        'completed',
        'failed',
        'withdrawn',
        'interrupted',
      ].includes(submission.status);
      const needsInput = (snapshot: ConversationSnapshot) =>
        Boolean(
          snapshot.workflow &&
            ['needs_input', 'paused'].includes(snapshot.workflow.status),
        );
      // The receipt can advance after the watch captured this frame. A terminal
      // receipt must be paired with a subsequent read, which includes its answer.
      const snapshot =
        terminal || needsInput(frame.snapshot)
          ? await chat.activitySnapshot(input.threadId)
          : frame.snapshot;
      const additions =
        snapshot.entries[0] &&
        Number(snapshot.entries[0].id) > Number(newestEntry)
          ? await historySince(chat, input.threadId, newestEntry)
          : snapshot.entries;
      for (const entry of additions)
        if (Number(entry.id) > Number(newestEntry)) newestEntry = entry.id;
      events.push(...projection.update(snapshot, additions));
      const awaitingInput = needsInput(snapshot);
      const done = terminal || awaitingInput;
      if (done) {
        events.push(...projection.finish());
        if (submission.status === 'failed')
          events.push({
            type: 'RUN_ERROR',
            message: submission.reason ?? 'The submission failed.',
            code: 'SUBMISSION_FAILED',
          } as BaseEvent);
        else
          events.push({
            type: 'RUN_FINISHED',
            threadId: input.threadId,
            runId: input.runId,
            outcome: {
              type: ['withdrawn', 'interrupted'].includes(submission.status)
                ? 'cancelled'
                : 'success',
            },
            result: {
              factory: {
                requestId: admission.requestId,
                status: submission.status,
                awaitingInput: Boolean(awaitingInput),
              },
            },
          } as BaseEvent);
      }
      return { payload: encodeAgUi(events), done: Boolean(done) };
    },
    () =>
      encodeAgUi([
        {
          type: 'RUN_ERROR',
          code: 'STREAM_FAILED',
          message:
            'The conversation stream failed. Reconcile durable history before retrying.',
        } as BaseEvent,
      ]),
  );
}
