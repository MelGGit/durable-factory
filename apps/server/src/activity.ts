import { randomUUID } from 'node:crypto';
import { contentVersion, writeSse } from './sse.js';
import type { ServerResponse } from 'node:http';
import {
  API_VERSION,
  ApiError,
  mergeActivity,
  runTimeline,
  type RunActivityItem,
  type RunActivityPage,
  type RunActivityFrame,
} from '../../../packages/shared/src/index.js';
import { preview, type ChatService } from './chat.js';
import type { WorkflowService } from './workflow.js';
import type { ProcessSupervisor } from './processes.js';

/** Read-only projection: original agent entries and process/workflow records remain authoritative. */
export class RunActivityService {
  private streams = new Set<() => void>();
  private inflight = new Set<Promise<unknown>>();
  constructor(
    private workflow: WorkflowService,
    private chat: ChatService,
    private processes: ProcessSupervisor,
  ) {}
  async page(
    id: string,
    cursor?: string,
    limit = 50,
    withLive = true,
  ): Promise<RunActivityPage> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor?.length ?? 0) > 2048
    )
      throw new ApiError('INVALID_INPUT', 'Invalid activity page.', 400);
    let boundary: RunActivityItem | undefined;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          value.runId !== id ||
          !Number.isFinite(value.at) ||
          typeof value.id !== 'string'
        )
          throw new Error();
        boundary = { id: value.id, at: value.at } as RunActivityItem;
      } catch {
        throw new ApiError('INVALID_INPUT', 'Invalid activity cursor.', 400);
      }
    }
    const run = await this.workflow.get(id);
    const before = (item: RunActivityItem) =>
      !boundary || mergeActivity([item, boundary])[0].id !== boundary.id;
    const items: RunActivityItem[] = [
      {
        id: `admission:${run.id}`,
        at: run.createdAt,
        actor: 'code',
        title: `Issue #${run.issue.number} admitted`,
        detail:
          run.mode === 'simulation' ? 'Simulation' : 'Implementation queued',
      },
      ...(run.activity?.map(({ signature: _signature, ...event }) => ({
        ...event,
        id: `workflow:${event.id}`,
        actor: 'code' as const,
      })) ?? []),
      ...runTimeline(run)
        .filter(
          (event) =>
            !run.activity?.some((record) => record.attemptId === event.id),
        )
        .map((event) => ({
          ...event,
          id: `timeline:${event.id}`,
          actor: event.actor === 'agent' ? ('code' as const) : event.actor,
        })),
      ...run.inputs.map((input) => ({
        id: `input:${input.requestId}`,
        at: input.at,
        actor: 'human' as const,
        title: `Guidance ${input.status}`,
        detail: input.content,
      })),
    ];
    for (const command of await this.processes.records(id))
      items.push({
        id: `command:${command.id}`,
        at: command.startedAt,
        actor: 'code',
        title: command.command,
        detail:
          command.state === 'finished'
            ? `Exit ${command.exitCode}${command.interrupted ? ' · Interrupted' : ''}`
            : command.state,
        attemptId: command.attemptId,
        command: {
          id: command.id,
          state: command.state,
          exitCode: command.exitCode,
          finishedAt: command.finishedAt,
        },
      });
    // Mutable records can finish after their start has left the newest history window.
    // Send bounded patches as well, so an already displayed command never stays stale.
    const updates: RunActivityItem[] = [];
    let updateBytes = 0;
    if (!cursor)
      for (const item of items.slice().reverse()) {
        if (
          !item.command &&
          !item.id.startsWith('input:') &&
          !item.id.startsWith('timeline:question-')
        )
          continue;
        const size = Buffer.byteLength(JSON.stringify(item));
        if (updateBytes + size > 128 * 1024) continue;
        updates.push(item);
        updateBytes += size;
      }
    const live: RunActivityPage['live'] = [];
    const sourceIds = [
      ...new Set([
        run.developerConversationId,
        ...run.attempts.map((attempt) => attempt.conversationId),
      ]),
    ];
    for (const conversationId of sourceIds) {
      const summary = await this.chat.summary(conversationId);
      let pageCursor: string | undefined,
        olderCount = 0;
      do {
        const page = await this.chat.history(conversationId, pageCursor, 100);
        for (const entry of page.entries) {
          // The service's JSON task prompt is model context, not a human message.
          if (entry.kind === 'pi.user') {
            if (
              /^\{"role":"(?:developer|reviewer)","contractVersion":/.test(
                entry.text,
              )
            )
              continue;
            try {
              const prompt = JSON.parse(entry.text);
              if (
                ['developer', 'reviewer'].includes(prompt.role) &&
                prompt.specification
              )
                continue;
            } catch {
              /* ordinary user text */
            }
          }
          if (
            entry.kind === 'factory.workflow' &&
            run.attempts.some((attempt) => attempt.message === entry.text)
          )
            continue;
          if (!entry.text && !entry.tools.length && !entry.interrupted)
            continue;
          const budget = Math.max(
            1,
            Math.floor((64 * 1024) / Math.max(1, entry.tools.length)),
          );
          entry.tools = entry.tools.map((tool) => {
            const args =
              tool.arguments === undefined
                ? undefined
                : preview(tool.arguments, budget);
            const output =
              tool.output === undefined
                ? undefined
                : preview(tool.output, budget);
            const truncated =
              tool.truncated || args?.truncated || output?.truncated;
            return {
              ...tool,
              ...(args ? { arguments: args.text } : {}),
              ...(output ? { output: output.text } : {}),
              ...(truncated
                ? {
                    truncated: true,
                    artifact: tool.artifact ?? `entry-${entry.id}`,
                  }
                : {}),
            };
          });
          const item: RunActivityItem = {
            id: `entry:${conversationId}:${entry.id}`,
            at: entry.at,
            actor:
              entry.kind === 'pi.user'
                ? 'human'
                : entry.kind === 'factory.workflow'
                  ? 'code'
                  : summary.role === 'review'
                    ? 'review'
                    : 'development',
            title:
              entry.kind === 'pi.user'
                ? 'You'
                : entry.kind === 'factory.workflow'
                  ? 'Workflow'
                  : summary.role === 'review'
                    ? 'Review agent'
                    : 'Developer agent',
            conversationId,
            entry,
          };
          if (before(item)) {
            items.push(item);
            olderCount++;
          }
        }
        pageCursor = page.cursor;
      } while (pageCursor && olderCount <= limit);
      if (
        withLive &&
        !cursor &&
        run.status === 'running' &&
        run.attempts.at(-1)?.conversationId === conversationId
      ) {
        const snapshot = await this.chat.activitySnapshot(conversationId);
        live.push({
          conversationId,
          role: summary.role,
          partial: snapshot.partial,
          tools: snapshot.tools,
        });
      }
    }
    const transcriptTexts = new Set(
      items.flatMap((item) => (item.entry?.text ? [item.entry.text] : [])),
    );
    for (const item of items)
      if (
        !item.entry &&
        item.id.startsWith('workflow:') &&
        item.detail &&
        transcriptTexts.has(item.detail)
      )
        delete item.detail;
    const ordered = mergeActivity(items.filter(before));
    const selected: RunActivityItem[] = [];
    let bytes = 0;
    for (const item of ordered.slice().reverse()) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (
        selected.length &&
        (selected.length >= limit || bytes + size > 512 * 1024)
      )
        break;
      selected.unshift(item);
      bytes += size;
    }
    const first = selected[0];
    // The activity stream supplies composer state too, so implementation chats
    // do not need a second persistent conversation stream.
    const developer =
      withLive && !cursor
        ? await this.chat.activitySnapshot(run.developerConversationId)
        : undefined;
    return {
      ...(developer
        ? {
            conversation: {
              conversation: developer.conversation,
              workflow: developer.workflow,
              submissions: developer.submissions,
              execution: developer.execution,
            },
          }
        : {}),
      items: selected,
      updates,
      live,
      ...(first && ordered.length > selected.length
        ? {
            cursor: Buffer.from(
              JSON.stringify({ runId: id, at: first.at ?? 0, id: first.id }),
            ).toString('base64url'),
          }
        : {}),
    };
  }
  async stream(
    id: string,
    res: ServerResponse,
    encode?: (frame: RunActivityFrame) => string,
    /** The id of the page a reconnecting client already holds. */
    resume?: string,
  ) {
    const initial = await this.page(id);
    if (res.destroyed) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.flushHeaders();
    const streamId = randomUUID();
    const held = JSON.stringify(initial);
    let sequence = 0,
      last = !encode && resume === contentVersion(held) ? held : '',
      closed = false,
      busy = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      this.streams.delete(close);
      res.end();
    };
    const write = (text: string) => {
      if (closed || busy) return;
      if (res.writableLength + Buffer.byteLength(text) > 1048576) {
        close();
        return;
      }
      res.write(text);
    };
    const emit = async (snapshot: RunActivityPage) => {
      const value = JSON.stringify(snapshot);
      if (closed || value === last) return;
      last = value;
      const frame: RunActivityFrame = {
        apiVersion: API_VERSION,
        streamId,
        sequence: ++sequence,
        type: sequence === 1 ? 'snapshot' : 'update',
        snapshot,
      };
      if (
        !(await writeSse(
          res,
          encode
            ? encode(frame)
            : `id: ${contentVersion(value)}\ndata: ${JSON.stringify(frame)}\n\n`,
        ))
      )
        close();
    };
    const poll = setInterval(() => {
      if (busy || closed) return;
      busy = true;
      const work = this.page(id)
        .then(emit)
        .catch(close)
        .finally(() => {
          busy = false;
        });
      this.inflight.add(work);
      void work.finally(() => this.inflight.delete(work));
    }, 500);
    const heartbeat = setInterval(
      () => write('event: heartbeat\ndata: {}\n\n'),
      15000,
    );
    res.on('close', close);
    this.streams.add(close);
    busy = true;
    try {
      await emit(initial);
    } finally {
      busy = false;
    }
  }
  async close() {
    for (const stop of this.streams) stop();
    await Promise.allSettled([...this.inflight]);
  }
}
