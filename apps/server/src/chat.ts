import { Deletions, deleting, assertNotDeleting } from './deletion-state.js';
import { createHash, randomUUID } from 'node:crypto';
import { writeSse } from './sse.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import {
  defineDoc,
  configure,
  type Tx,
  type TaskId,
  defineExtension,
  type Harness,
  type ConversationId,
  type SubmissionRecord,
  type ConversationView,
  type EntryRecord,
  type EntryId,
  type ToolRegistration,
  InboxDoc,
  type LiveState,
} from '@earendil-works/pi-durable';
import type { JsonRepresentation } from '@earendil-works/chord';
import type { Models, ModelThinkingLevel } from '@earendil-works/pi-ai';
import {
  API_VERSION,
  ApiError,
  roleCapabilities,
  type ChatFrame,
  type ChatSubmission,
  type ConversationSnapshot,
  type ConversationSummary,
  type HistoryPage,
  type Role,
  type Settings,
  type TranscriptEntry,
  type ToolView,
} from '../../../packages/shared/src/index.js';
import { context } from './storage.js';
import {
  Planning,
  planningInstructions,
  type PlanningService,
} from './planning.js';

export const Catalog = defineDoc({
  kind: 'factory.conversations',
  scope: 'session',
  version: 1,
  initial: () => ({
    items: {} as Record<
      string,
      JsonRepresentation<ConversationSummary> & { requestId: string }
    >,
  }),
  checkpointWhen: () => true,
});
export const Requests = defineDoc({
  kind: 'factory.chat',
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  version: 1,
  initial: () => ({
    interrupting: false as boolean,
    requests: {} as Record<
      string,
      { content: string; mode: 'followUp' | 'steer'; withdrawn?: boolean }
    >,
  }),
  checkpointWhen: () => true,
});
// Conversation-scoped so the existing cleanup removes these receipts with their owner.
const AgUiBindings = defineDoc({
  kind: 'factory.ag-ui',
  scope: 'conversation',
  version: 1,
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    exchanges: {} as Record<
      string,
      { runId: string; messageId: string; content: string; requestId: string }
    >,
  }),
  checkpointWhen: () => true,
});
export interface ChatDependencies {
  models: Models;
  workflowView?: (
    runId: string,
  ) => Promise<NonNullable<ConversationSnapshot['workflow']>>;
  workflowWithdraw?: () => Promise<void>;
  workflowInput?: (id: string, input: unknown) => Promise<unknown>;
  workflowInterrupt?: (id: string) => Promise<unknown>;
  planning?: PlanningService;
  registerRequesty?: (id: string) => void;
  tools?: ToolRegistration[];
  /** Only a future workflow adapter may authorize developer input. Never supplied by HTTP callers. */
  authorizeDeveloper?: (id: string) => boolean;
}
const LIMIT = 65536;
export function preview(text: string, limit = LIMIT) {
  const bytes = Buffer.from(text);
  let end = Math.min(limit, bytes.length);
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    text: bytes.length > limit ? bytes.subarray(0, end).toString('utf8') : text,
    truncated: bytes.length > limit,
  };
}
export function outputPage(bytes: Buffer, offset: number, size: number) {
  if (bytes.length && (bytes[0] & 0xc0) === 0x80)
    invalid('Output offset must be a UTF-8 character boundary.');
  let end = Math.min(LIMIT, bytes.length);
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    text: bytes.subarray(0, end).toString('utf8'),
    ...(offset + end < size ? { nextOffset: offset + end } : {}),
  };
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) =>
      item?.type === 'text'
        ? item.text
        : item?.type === 'thinking'
          ? item.thinking
          : '',
    )
    .filter(Boolean)
    .join('\n');
}
function artifactId(task: unknown) {
  return `task-${String(task)}`;
}
export function transcript(entry: EntryRecord): TranscriptEntry {
  const tools: ToolView[] = [];
  const messages = entry.model ?? [];
  let text =
    entry.kind === 'factory.workflow' &&
    entry.data &&
    typeof entry.data === 'object' &&
    !Array.isArray(entry.data) &&
    typeof entry.data.text === 'string'
      ? entry.data.text
      : '';
  let interrupted = false;
  for (const message of messages) {
    text += textContent(message.content);
    if (message.role === 'assistant') {
      interrupted ||= message.stopReason === 'aborted';
      for (const item of message.content)
        if (item.type === 'toolCall')
          tools.push({
            id: item.id,
            name: item.name,
            arguments: preview(JSON.stringify(item.arguments, null, 2)).text,
            status: 'pending',
            ...(Buffer.byteLength(JSON.stringify(item.arguments)) > LIMIT
              ? { artifact: `entry-${entry.id}`, truncated: true }
              : {}),
          });
    }
    if (message.role === 'toolResult') {
      const output = preview(textContent(message.content));
      tools.push({
        id: message.toolCallId,
        name: message.toolName,
        output: output.text,
        truncated:
          output.truncated ||
          (Array.isArray(
            entry.data &&
              typeof entry.data === 'object' &&
              !Array.isArray(entry.data)
              ? entry.data.diagnostics
              : undefined,
          ) &&
            JSON.stringify(entry.data).includes('"truncated"')),
        status: message.isError ? 'failed' : 'completed',
        ...(entry.byTaskId ? { artifact: artifactId(entry.byTaskId) } : {}),
      });
      text = '';
    }
  }
  return {
    id: String(entry.id),
    kind: entry.kind,
    ...(entry.model?.some((message) => typeof message.timestamp === 'number')
      ? {
          at: entry.model.find(
            (message) => typeof message.timestamp === 'number',
          )!.timestamp,
        }
      : entry.data &&
          typeof entry.data === 'object' &&
          !Array.isArray(entry.data) &&
          typeof entry.data.at === 'number'
        ? { at: entry.data.at }
        : {}),
    text: preview(text).text,
    tools,
    ...(Buffer.byteLength(text) > LIMIT
      ? { textArtifact: `entry-${entry.id}` }
      : {}),
    ...(interrupted ? { interrupted } : {}),
  };
}
function status(
  record: SubmissionRecord,
  content: string,
  mode: 'followUp' | 'steer',
): ChatSubmission {
  const state =
    record.status === 'done'
      ? 'completed'
      : record.status === 'placed'
        ? 'running'
        : record.status === 'queued'
          ? 'queued'
          : record.reason === 'aborted'
            ? record.entry
              ? 'interrupted'
              : 'withdrawn'
            : 'failed';
  return {
    id: String(record.id),
    requestId: record.requestId!,
    content,
    mode,
    status: state,
    ...(record.status === 'unanswered'
      ? {
          reason:
            state === 'failed'
              ? 'The model could not complete this input. Check the selected connection and retry explicitly.'
              : 'Interrupted by request.',
        }
      : {}),
  };
}
function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{1,100}$/.test(value) &&
    !Object.hasOwn(Object.prototype, value)
  );
}
function invalid(message: string): never {
  throw new ApiError('INVALID_INPUT', message, 400);
}

/** Full output is captured before Pi applies its retained-output limits. Only installed service tools use this adapter. */
export function recordingTools(dataDir: string, tools: ToolRegistration[]) {
  return defineExtension({
    name: 'factory-tools',
    tools: tools.map((tool) => ({
      ...tool,
      async execute(args, api, ctx) {
        const directory = join(
          dataDir,
          'artifacts',
          String(api.conversationId),
        );
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = join(directory, `${artifactId(api.taskId)}.log`);
        const append = (value: string | Uint8Array) =>
          appendFileSync(file, value, { mode: 0o600 });
        append('');
        const result = await tool.execute(
          args,
          {
            ...api,
            outputWindow: undefined,
            output(chunk) {
              append(chunk);
              api.output(chunk);
            },
          },
          ctx,
        );
        if (result.output) append(`\n[Result]\n${textContent(result.output)}`);
        return result;
      },
    })),
  });
}

export class ChatService {
  private lines = new Map<string, Promise<unknown>>();
  private streams = new Set<() => Promise<void>>();
  private interrupts = new Set<Promise<void>>();
  private closing = false;
  constructor(
    private harness: Harness,
    private dataDir: string,
    private settings: () => Promise<{ settings: Settings }>,
    private deps: ChatDependencies,
  ) {}
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pending = (this.lines.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    this.lines.set(key, pending);
    void pending
      .finally(() => {
        if (this.lines.get(key) === pending) this.lines.delete(key);
      })
      .catch(() => {});
    return pending;
  }
  async list() {
    return Object.values(
      (await this.harness.snapshot(Catalog, context))?.items ?? {},
    )
      .map(({ requestId: _, ...item }) => item)
      .reverse();
  }
  async summary(id: string) {
    if (!/^\d+$/.test(id))
      throw new ApiError('NOT_FOUND', 'Conversation not found.', 404);
    const item = (await this.harness.snapshot(Catalog, context))?.items[id];
    if (!item) throw new ApiError('NOT_FOUND', 'Conversation not found.', 404);
    const { requestId: _, ...summary } = item;
    return summary;
  }
  private async conversation(id: string) {
    await this.summary(id);
    return (await this.harness.conversation(
      Number(id) as ConversationId,
      context,
    ))!;
  }
  async create(input: unknown, role: Role = 'planning') {
    const body = input as { title?: unknown; requestId?: unknown };
    if (
      !body ||
      !validId(body.requestId) ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      body.title.length > 120
    )
      invalid('Provide a title (1–120 characters) and a stable request ID.');
    const title = body.title.trim(),
      requestId = body.requestId;
    return this.serial('create', async () => {
      const existing = Object.values(
        (await this.harness.snapshot(Catalog, context))?.items ?? {},
      ).find((item) => item.requestId === requestId);
      if (existing) {
        if (existing.title !== title || existing.role !== role)
          throw new ApiError(
            'CONFLICT',
            'This request ID already created another conversation.',
            409,
          );
        return this.summary(existing.id);
      }
      const { settings } = await this.settings();
      const model = settings.roles[role];
      if (!model.provider || !model.model)
        invalid('Select a planning provider and model in settings first.');
      if (model.provider === 'requesty')
        this.deps.registerRequesty?.(model.model);
      // All model resolution uses the private credential adapter; never infer account access from the catalog.
      const conversation = await this.harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: {
            model: { provider: model.provider, modelId: model.model },
            thinkingLevel: model.reasoning as ModelThinkingLevel | null,
            tools: [
              ...(this.deps.tools ?? []),
              ...(role === 'planning'
                ? (this.deps.planning?.tools() ?? [])
                : []),
            ],
            instructions:
              role === 'planning' && this.deps.planning
                ? planningInstructions
                : 'Discuss the user’s software plan. You cannot inspect files, edit code, create GitHub issues, or start development in this stage.',
          },
          init: async (tx, id) => {
            const catalog = await tx.doc(Catalog);
            catalog.items[String(id)] = {
              id: String(id),
              title,
              role,
              requestId,
              repository: {
                path: settings.repository.path,
                github: settings.repository.github,
                baseBranch: settings.repository.baseBranch,
              },
              createdAt: new Date().toISOString(),
              model: structuredClone(model),
            };
            await tx.doc(Requests, id);
            if (role === 'planning')
              await this.deps.planning?.initialize(tx, id, settings.repository);
          },
        },
        context,
      );
      return this.summary(String(conversation.id));
    });
  }
  async lookup(id: string, requestId: string) {
    await this.summary(id);
    if (!validId(requestId)) invalid('Invalid request ID.');
    const requests = await this.harness.snapshot(
      Requests,
      Number(id) as ConversationId,
      context,
    );
    const receipt = requests?.requests[requestId];
    if (!receipt) throw new ApiError('NOT_FOUND', 'Submission not found.', 404);
    const record = await this.harness.commit(
      (tx) => tx.submissionByRequest(Number(id) as ConversationId, requestId),
      context,
    );
    return record
      ? status(record, receipt.content, receipt.mode)
      : {
          id: '',
          requestId,
          content: receipt.content,
          mode: receipt.mode,
          status: receipt.withdrawn
            ? ('withdrawn' as const)
            : ('acknowledged' as const),
        };
  }
  async submitAgUi(
    id: string,
    runId: string,
    messageId: string,
    content: string,
  ) {
    const summary = await this.summary(id);
    await this.harness.commit(
      (tx) => assertNotDeleting(tx, id, summary.runId),
      context,
    );
    if (!roleCapabilities(summary.role).followUp)
      throw new ApiError(
        'FORBIDDEN',
        'This conversation is inspection-only.',
        403,
      );
    return this.serial(`ag-ui:${id}`, async () => {
      if (this.closing)
        throw new ApiError('NOT_READY', 'The service is stopping.', 503);
      const hash = (value: string) =>
        createHash('sha256').update(value).digest('hex');
      const requestId = `agui_${hash(messageId)}`;
      await this.harness.commit(async (tx) => {
        await assertNotDeleting(tx, id, summary.runId);
        const doc = await tx.doc(AgUiBindings, Number(id) as ConversationId);
        const previous = doc.exchanges[hash(runId)];
        if (
          previous &&
          (previous.runId !== runId ||
            previous.messageId !== messageId ||
            previous.content !== content)
        )
          throw new ApiError(
            'CONFLICT',
            'This AG-UI run ID belongs to different input.',
            409,
          );
        if (
          Object.values(doc.exchanges).some(
            (item) => item.messageId === messageId && item.content !== content,
          )
        )
          throw new ApiError(
            'CONFLICT',
            'This AG-UI message ID belongs to different input.',
            409,
          );
        doc.exchanges[hash(runId)] = { runId, messageId, content, requestId };
      }, context);
      try {
        const previous = await this.lookup(id, requestId);
        if (previous.content !== content || previous.mode !== 'followUp')
          throw new ApiError(
            'CONFLICT',
            'This message ID belongs to different input.',
            409,
          );
        return previous;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'NOT_FOUND')
          throw error;
      }
      return this.submit(id, { content, requestId, mode: 'followUp' });
    });
  }
  async submit(id: string, input: unknown) {
    if ((await this.summary(id)).runId && this.deps.workflowInput) {
      await this.deps.workflowInput(id, input);
      return this.lookup(id, (input as { requestId: string }).requestId);
    }
    const body = input as {
      content?: unknown;
      requestId?: unknown;
      mode?: unknown;
    };
    if (
      !body ||
      !validId(body.requestId) ||
      typeof body.content !== 'string' ||
      !body.content.trim() ||
      Buffer.byteLength(body.content) > 32768 ||
      !['followUp', 'steer'].includes(String(body.mode ?? 'followUp'))
    )
      invalid(
        'Provide non-empty text (at most 32 KiB), a stable request ID, and a valid delivery mode.',
      );
    const content = body.content,
      requestId = body.requestId,
      mode = (body.mode ?? 'followUp') as 'followUp' | 'steer';
    return this.serial(id, async () => {
      if (this.closing)
        throw new ApiError('NOT_READY', 'The service is stopping.', 503);
      const summary = await this.summary(id);
      await this.harness.commit(
        (tx) => assertNotDeleting(tx, id, summary.runId),
        context,
      );
      const capability = roleCapabilities(summary.role);
      if (
        !capability.followUp ||
        (mode === 'steer' && !capability.steer) ||
        (summary.role === 'development' && !this.deps.authorizeDeveloper?.(id))
      )
        throw new ApiError(
          'FORBIDDEN',
          'This conversation does not accept this input.',
          403,
        );
      const conversation = await this.conversation(id);
      const shouldSubmit = await this.harness.commit(async (tx) => {
        await assertNotDeleting(tx, id, summary.runId);
        const doc = await tx.doc(Requests, conversation.id);
        if (doc.interrupting)
          throw new ApiError('BUSY', 'Wait for interruption to finish.', 409);
        const previous = doc.requests[requestId];
        if (
          previous &&
          (previous.content !== content || previous.mode !== mode)
        )
          throw new ApiError(
            'CONFLICT',
            'This request ID already belongs to different input.',
            409,
          );
        if (!previous) {
          const inbox = await tx.doc(InboxDoc, conversation.id);
          if (inbox.items.length >= 100)
            throw new ApiError('BUSY', 'The follow-up queue is full.', 409);
          doc.requests[requestId] = { content, mode };
          if (summary.role === 'planning')
            await this.deps.planning?.authorize(
              tx,
              conversation.id,
              requestId,
              content,
            );
        }
        return !previous?.withdrawn;
      }, context);
      if (shouldSubmit)
        await conversation.submit(
          { type: 'input', content, requestId, whenBusy: mode },
          context,
        );
      return this.lookup(id, requestId);
    });
  }
  async withdraw(id: string, submissionId: string) {
    const conversation = await this.conversation(id);
    const record = await (
      await this.harness.submission(Number(submissionId) as never, context)
    )?.status(context);
    if (!record || String(record.conversationId) !== id)
      throw new ApiError('NOT_FOUND', 'Submission not found.', 404);
    const result = await this.harness.abortSubmission(
      record.id,
      context,
      conversation.id,
    );
    if (
      result !== 'aborted' &&
      !(
        result === 'settled' &&
        record.status === 'unanswered' &&
        record.reason === 'aborted' &&
        !record.entry
      )
    )
      throw new ApiError(
        'CONFLICT',
        'This input has already been consumed.',
        409,
      );
    if ((await this.summary(id)).runId) await this.deps.workflowWithdraw?.();
    return this.lookup(id, record.requestId!);
  }
  async interrupt(id: string) {
    if ((await this.summary(id)).runId && this.deps.workflowInterrupt) {
      await this.deps.workflowInterrupt(id);
      return { status: 'interrupting' };
    }
    return this.serial(id, async () => {
      const summary = await this.summary(id);
      if (!roleCapabilities(summary.role).interrupt)
        throw new ApiError(
          'FORBIDDEN',
          'This conversation is inspection-only.',
          403,
        );
      const conversation = await this.conversation(id);
      await this.harness.commit(async (tx) => {
        const doc = await tx.doc(Requests, conversation.id);
        for (const requestId of Object.keys(doc.requests)) {
          if (!(await tx.submissionByRequest(conversation.id, requestId)))
            doc.requests[requestId].withdrawn = true;
        }
        doc.interrupting = true;
      }, context);
      const work = conversation.abort(context).then(async () => {
        await this.harness.commit(async (tx) => {
          (await tx.doc(Requests, conversation.id)).interrupting = false;
        }, context);
      });
      this.interrupts.add(work);
      void work.finally(() => this.interrupts.delete(work)).catch(() => {});
      return { status: 'interrupting' };
    });
  }
  async stopForDeletion(id: string) {
    await this.interrupt(id);
    await Promise.all([...this.interrupts]);
  }
  async recover() {
    const conversations = await this.list();
    for (const summary of conversations)
      if (summary.model.provider === 'requesty')
        this.deps.registerRequesty?.(summary.model.model);
    for (const summary of conversations) {
      if (
        summary.runId ||
        deleting(await this.harness.snapshot(Deletions, context), summary.id)
      )
        continue;
      await this.deps.planning?.upgrade(summary, this.deps.tools);
      await this.deps.planning?.recover(summary.id);
      const conversation = await this.conversation(summary.id);
      const doc = await this.harness.snapshot(
        Requests,
        conversation.id,
        context,
      );
      if (doc?.interrupting) {
        await conversation.abort(context);
        await this.harness.commit(async (tx) => {
          (await tx.doc(Requests, conversation.id)).interrupting = false;
        }, context);
      }
      for (const [requestId, receipt] of Object.entries(doc?.requests ?? {})) {
        const record = await this.harness.commit(
          (tx) => tx.submissionByRequest(conversation.id, requestId),
          context,
        );
        if (!record && !receipt.withdrawn && !doc?.interrupting)
          await conversation.submit(
            {
              type: 'input',
              content: receipt.content,
              requestId,
              whenBusy: receipt.mode,
            },
            context,
          );
      }
    }
  }
  async history(id: string, cursor?: string, limit = 50): Promise<HistoryPage> {
    const conversation = await this.conversation(id);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor && cursor.length > 2048)
    )
      invalid('Invalid history page.');
    try {
      let before: number | undefined;
      if (cursor) {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          decoded.conversationId !== id ||
          !Number.isSafeInteger(decoded.before) ||
          decoded.before < 1
        )
          invalid('Invalid history cursor.');
        before = decoded.before;
      }
      const page = await conversation.entries(
        before ? { maxEntryId: (before - 1) as EntryId } : {},
        limit,
        undefined,
        context,
      );
      const entries = await this.agUiEntryIds(
        id,
        page.items.map(transcript).reverse(),
      );
      return {
        entries,
        ...(page.next && entries.length
          ? { cursor: this.cursor(id, entries[0].id) }
          : {}),
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      invalid('Invalid history cursor.');
    }
  }
  private async agUiEntryIds(id: string, entries: TranscriptEntry[]) {
    const bindings = await this.harness.snapshot(
      AgUiBindings,
      Number(id) as ConversationId,
      context,
    );
    if (!bindings) return entries;
    const wanted = new Set(
      entries
        .filter((entry) => entry.kind === 'pi.user')
        .map((entry) => entry.id),
    );
    const aliases = await this.harness.commit(async (tx) => {
      const result = new Map<string, string>();
      const receipts = new Map(
        Object.values(bindings.exchanges).map((item) => [item.requestId, item]),
      );
      for (const receipt of receipts.values()) {
        const record = await tx.submissionByRequest(
          Number(id) as ConversationId,
          receipt.requestId,
        );
        if (record?.entry && wanted.has(String(record.entry)))
          result.set(String(record.entry), receipt.messageId);
      }
      return result;
    }, context);
    return entries.map((entry) =>
      aliases.has(entry.id)
        ? { ...entry, messageId: aliases.get(entry.id)! }
        : entry,
    );
  }
  async activitySnapshot(id: string) {
    const conversation = await this.conversation(id);
    const watch = await conversation.watch(context);
    try {
      return await this.project(id, watch.value);
    } finally {
      await watch.stop();
    }
  }

  async inspectConversation(id: string) {
    const summary = await this.summary(id);
    const conversation = await this.conversation(id);
    const watch = await conversation.watch(context);
    let tools: { id: string; name: string; status: string }[];
    try {
      const live = watch.value.docs['pi.live'] as LiveState | undefined;
      tools = (live?.tools ?? [])
        .filter((t) => t.status !== 'done')
        .map((t) => ({ id: t.callId, name: t.name, status: t.status }));
    } finally {
      await watch.stop();
    }
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      messages: 0,
      partial: false,
      estimatedCost: undefined as number | undefined,
    };
    let cursor: Parameters<typeof conversation.entries>[2];
    for (let page = 0; page < 100; page++) {
      const entries = await conversation.entries({}, 100, cursor, context);
      for (const entry of entries.items)
        for (const message of entry.model ?? []) {
          if (message.role !== 'assistant' || !message.usage) continue;
          const u = message.usage;
          if (
            ![u.input, u.output, u.cacheRead, u.cacheWrite].every(
              (n) => Number.isFinite(n) && n >= 0,
            )
          )
            continue;
          usage.input += u.input;
          usage.output += u.output;
          usage.cacheRead += u.cacheRead;
          usage.cacheWrite += u.cacheWrite;
          usage.messages++;
          // Subscription tokens are usage, not per-token charges. Only surface
          // positive provider cost estimates for the API-key connection.
          if (
            summary.model.provider === 'requesty' &&
            Number.isFinite(u.cost?.total) &&
            u.cost.total > 0
          )
            usage.estimatedCost = (usage.estimatedCost ?? 0) + u.cost.total;
        }
      cursor = entries.next;
      if (!cursor) break;
    }
    usage.partial = Boolean(cursor);
    return { id, role: summary.role, tools: tools!, usage };
  }

  async searchHistory(id: string, query: string) {
    const matches: { id: string; text: string }[] = [];
    let cursor: string | undefined;
    let scanned = 0;
    let truncated = false;
    for (let page = 0; page < 100; page++) {
      const history = await this.history(id, cursor, 100);
      for (const entry of history.entries) {
        let text = entry.text;
        if (entry.textArtifact) {
          text = '';
          let offset: number | undefined = 0;
          while (offset !== undefined && text.length < 1024 * 1024) {
            const output = await this.artifact(id, entry.textArtifact, offset);
            text += output.text;
            offset = output.nextOffset;
          }
          truncated ||= offset !== undefined;
        }
        scanned += Buffer.byteLength(text);
        const index = text.toLowerCase().indexOf(query.toLowerCase());
        if (index >= 0)
          matches.push({
            id: entry.id,
            text: text.slice(Math.max(0, index - 200), index + 800),
          });
        if (matches.length >= 50 || scanned >= 4 * 1024 * 1024)
          return { matches, truncated: true };
      }
      cursor = history.cursor;
      if (!cursor) return { matches, truncated };
    }
    return { matches, truncated: true };
  }

  private cursor(id: string, before: string) {
    return Buffer.from(
      JSON.stringify({ conversationId: id, before: Number(before) }),
    ).toString('base64url');
  }

  private async project(
    id: string,
    view: ConversationView,
  ): Promise<ConversationSnapshot> {
    const conversation = await this.summary(id);
    const doc = await this.harness.snapshot(
      Requests,
      Number(id) as ConversationId,
      context,
    );
    const submissions = await this.harness.commit(async (tx) => {
      const items: ChatSubmission[] = [];
      for (const [requestId, receipt] of Object.entries(doc?.requests ?? {})) {
        const record = await tx.submissionByRequest(
          Number(id) as ConversationId,
          requestId,
        );
        items.push(
          record
            ? status(record, receipt.content, receipt.mode)
            : {
                id: '',
                requestId,
                content: receipt.content,
                mode: receipt.mode,
                status: receipt.withdrawn ? 'withdrawn' : 'acknowledged',
              },
        );
      }
      return items;
    }, context);
    const live = view.docs['pi.live'] as LiveState | undefined;
    const projectedEntries = view.entries.slice(-50).map((raw) => {
      const entry = transcript(raw);
      const budget = Math.floor((64 * 1024) / Math.max(1, entry.tools.length));
      entry.tools = entry.tools.map((tool) => {
        const args =
          tool.arguments === undefined
            ? undefined
            : preview(tool.arguments, budget);
        const output =
          tool.output === undefined ? undefined : preview(tool.output, budget);
        return {
          ...tool,
          ...(args ? { arguments: args.text } : {}),
          ...(output ? { output: output.text } : {}),
          ...(args?.truncated || output?.truncated
            ? {
                truncated: true,
                artifact: tool.artifact ?? `entry-${entry.id}`,
              }
            : {}),
        };
      });
      return entry;
    });
    const entries = await this.agUiEntryIds(id, projectedEntries);
    // Keep the wire snapshot below the slow-client ceiling; older entries remain pageable.
    while (
      entries.length > 1 &&
      Buffer.byteLength(JSON.stringify(entries)) > 512 * 1024
    )
      entries.shift();
    const active = submissions.filter((item) =>
      ['queued', 'running', 'acknowledged'].includes(item.status),
    );
    const workflow = conversation.runId
      ? await this.deps.workflowView?.(conversation.runId)
      : undefined;
    return {
      conversation,
      ...(workflow ? { workflow } : {}),
      ...(this.deps.planning
        ? { planning: await this.deps.planning.read(id) }
        : {}),
      entries,
      partial: preview(textContent(live?.generation?.message?.content)).text,
      tools: (live?.tools ?? []).map((tool) => ({
        id: tool.callId,
        name: tool.name,
        status:
          tool.status === 'done'
            ? 'completed'
            : (tool.status as 'pending' | 'running'),
        output: preview(
          tool.output ?? '',
          Math.min(
            LIMIT,
            Math.floor((128 * 1024) / Math.max(1, live?.tools?.length ?? 1)),
          ),
        ).text,
        truncated:
          Buffer.byteLength(tool.output ?? '') >
            Math.min(
              LIMIT,
              Math.floor((128 * 1024) / Math.max(1, live?.tools?.length ?? 1)),
            ) || (tool.droppedBytes ?? 0) > 0,
        ...(tool.taskId ? { artifact: artifactId(tool.taskId) } : {}),
      })),
      submissions: [
        ...new Map(
          [...submissions.slice(-50), ...active].map((item) => [
            item.id || item.requestId,
            { ...item, content: preview(item.content, 1024).text },
          ]),
        ).values(),
      ],
      execution: workflow
        ? ['pausing', 'cancelling'].includes(workflow.status)
          ? 'interrupting'
          : workflow.status === 'running'
            ? 'running'
            : 'idle'
        : doc?.interrupting
          ? 'interrupting'
          : live?.run
            ? 'running'
            : 'idle',
      ...(entries.length
        ? { olderCursor: this.cursor(id, entries[0].id) }
        : {}),
    };
  }
  async stream(
    id: string,
    res: ServerResponse,
    encode?: (
      frame: ChatFrame,
    ) =>
      | { payload: string; done?: boolean }
      | Promise<{ payload: string; done?: boolean }>,
    onStreamError?: () => string,
  ) {
    const conversation = await this.conversation(id);
    const watch = await conversation.watch(context);
    const requestsWatch = await this.harness.watchDoc(
      Requests,
      conversation.id,
      context,
    );
    const planningWatch = this.deps.planning
      ? await this.harness.watchDoc(Planning, conversation.id, context)
      : undefined;
    const workflowWatch = (await this.summary(id)).runId
      ? await this.harness.watchDoc(
          (await import('./workflow.js')).Workflow,
          context,
        )
      : undefined;
    const streamId = randomUUID();
    let sequence = 0,
      stopped = false,
      writing = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = async (graceful = false) => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      this.streams.delete(stop);
      res.end();
      if (!graceful && res.writableLength > 0) res.destroy();
      await Promise.all([
        watch.stop(),
        requestsWatch?.stop(),
        planningWatch?.stop(),
        workflowWatch?.stop(),
      ]);
    };
    const fail = () => {
      if (stopped) return;
      if (onStreamError && !res.destroyed) {
        const payload = onStreamError();
        if (res.writableLength + Buffer.byteLength(payload) <= 1024 * 1024)
          res.write(payload);
      }
      void stop(true);
    };
    if (res.destroyed) {
      await stop();
      return;
    }
    this.streams.add(stop);
    res.once('close', () => {
      void stop();
    });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = async (
      view: ConversationView,
      type: 'snapshot' | 'update',
    ) => {
      if (stopped) return;
      const frame: ChatFrame = {
        apiVersion: API_VERSION,
        streamId,
        sequence: ++sequence,
        type,
        snapshot: await this.project(id, view),
      };
      const encoded = encode
        ? await encode(frame)
        : { payload: `data: ${JSON.stringify(frame)}\n\n` };
      const { payload } = encoded;
      if (stopped) return;
      let written: boolean;
      writing = true;
      try {
        written = await writeSse(res, payload);
      } finally {
        writing = false;
      }
      if (!written) {
        void stop();
        return;
      }
      if (encoded.done) void stop(true);
    };
    try {
      await send(watch.value, 'snapshot');
      if (stopped) return;
      heartbeat = setInterval(() => {
        if (writing) return;
        if (res.writableLength + 16 > 1024 * 1024) void stop();
        else res.write(': heartbeat\n\n');
      }, 15000);
      let delivery = Promise.resolve();
      const enqueue = (view: ConversationView) => {
        delivery = delivery.then(() => send(view, 'update')).catch(fail);
        return delivery;
      };
      watch.start((view) => enqueue(view));
      requestsWatch?.start(() => enqueue(watch.value));
      workflowWatch?.start(() => enqueue(watch.value));
      planningWatch?.start(() => enqueue(watch.value));
    } catch (error) {
      fail();
      throw error;
    }
  }
  async artifact(id: string, artifact: string, offset: number) {
    await this.summary(id);
    if (
      !/^(task|entry)-\d+$/.test(artifact) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      invalid('Invalid output page.');
    if (artifact.startsWith('entry-')) {
      const entry = await this.harness.commit(
        (tx) => tx.entry(Number(artifact.slice(6)) as EntryId),
        context,
      );
      if (!entry || String(entry.conversationId) !== id)
        throw new ApiError('NOT_FOUND', 'Output artifact not found.', 404);
      const text = (entry.model ?? [])
        .map(
          (message) =>
            textContent(message.content) +
            (Array.isArray(message.content)
              ? message.content
                  .filter((item) => item.type === 'toolCall')
                  .map((item) => JSON.stringify(item, null, 2))
                  .join('\n')
              : ''),
        )
        .join('\n');
      return outputPage(
        Buffer.from(text).subarray(offset, offset + LIMIT + 4),
        offset,
        Buffer.byteLength(text),
      );
    }
    let file;
    try {
      file = await open(
        join(this.dataDir, 'artifacts', id, `${artifact}.log`),
        'r',
      );
    } catch {
      throw new ApiError('NOT_FOUND', 'Output artifact not found.', 404);
    }
    try {
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(LIMIT + 4);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      // Byte offsets remain stable while a running tool appends output.
      return outputPage(buffer.subarray(0, bytesRead), offset, size);
    } finally {
      await file.close();
    }
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.streams].map((stop) => stop()));
    await Promise.allSettled([...this.lines.values(), ...this.interrupts]);
  }
}

/** Workflow conversations are inert until the stage adapter configures their role. */
export async function createRunConversation(
  tx: Tx,
  runId: string,
  role: 'development' | 'review',
  repository: Settings['repository'],
  model: Settings['roles']['development'],
  taskId?: TaskId,
) {
  const record = await tx.createConversation({
    ownership: taskId ? { kind: 'task', taskId } : { kind: 'ownerless' },
  });
  await configure(tx, record.id, {
    tools: [],
    extensions: [],
    model:
      model.provider && model.model
        ? { provider: model.provider, modelId: model.model }
        : null,
    instructions:
      'Simulated workflow. No repository mutations or publication tools.',
  });
  const catalog = await tx.doc(Catalog);
  catalog.items[String(record.id)] = {
    id: String(record.id),
    runId,
    title: `${role} · ${runId.slice(0, 8)}`,
    role,
    repository,
    model,
    createdAt: new Date().toISOString(),
    requestId: `workflow-${record.id}`,
  };
  await tx.doc(Requests, record.id);
  return String(record.id);
}
