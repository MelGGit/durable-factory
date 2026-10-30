import {
  Deletions,
  deleting,
  assertNotDeleting,
  issueDeletionKey,
} from './deletion-state.js';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { contentVersion } from './sse.js';
import {
  defineDoc,
  defineTask,
  defineExtension,
  type Harness,
  type Tx,
  type ConversationId,
  type SubmissionId,
  type TaskRuntime,
} from '@earendil-works/pi-durable';
import type { JsonRepresentation } from '@earendil-works/chord';
import {
  API_VERSION,
  DEFAULT_PROJECT_ID,
  validateTicketContract,
  parseIssueTicket,
  currentImplementation,
  formatTicketBody,
  normalizeLineEndings,
  validateImplementation,
  validateAssessments,
  acceptsTypedAnswer,
  type BoundImplementation,
  type CriterionAssessment,
  type RegressionEvidence,
  ApiError,
  type WorkflowRun,
  type WorkflowSnapshot,
  type StageAttempt,
  type RunStage,
  type RunCommand,
  type Settings,
  type Ticket,
} from '../../../packages/shared/src/index.js';
import { context, Configuration, projectOf } from './storage.js';
import { Planning } from './planning.js';
import { createRunConversation, Requests, Catalog } from './chat.js';

export const Workflow = defineDoc({
  kind: 'factory.workflow',
  scope: 'session',
  version: 1,
  initial: () => ({
    schemaVersion: 1,
    revision: 0,
    nextOrder: 0,
    slots: [] as string[],
    runs: {} as Record<string, JsonRepresentation<WorkflowRun>>,
    receipts: {} as Record<string, { payload: string; runId: string }>,
  }),
  checkpointWhen: () => true,
});
type State = {
  schemaVersion: number;
  revision: number;
  nextOrder: number;
  /** Runs holding a runner. Older data held a single `slot` instead. */
  slots: string[];
  slot?: string;
  runs: Record<string, WorkflowRun>;
  receipts: Record<string, { payload: string; runId: string }>;
};
/** The runs holding a runner, reading the single `slot` of older data. */
export const occupiedSlots = (
  state: { slots?: readonly string[]; slot?: string } | undefined,
): string[] => [...(state?.slots ?? (state?.slot ? [state.slot] : []))];
export interface WorkflowClock {
  now(): number;
  timer(callback: () => void, milliseconds: number): () => void;
}
export const systemClock: WorkflowClock = {
  now: Date.now,
  timer(callback, milliseconds) {
    const timer = setTimeout(callback, Math.max(0, milliseconds));
    return () => clearTimeout(timer);
  },
};
export interface StageResult {
  outcome: 'passed' | 'failed' | 'needs_input' | 'uncertain';
  message: string;
  source?: string;
  implementation?: BoundImplementation;
  assessments?: CriterionAssessment[];
  regression?: RegressionEvidence;
  verdict?: 'pass' | 'changes_requested' | 'needs_input';
  publicationResult?: string;
  results?: NonNullable<
    import('../../../packages/shared/src/index.js').RunEvidence['results']
  >;
  findings?: import('../../../packages/shared/src/index.js').RunEvidence['findings'];
}

export interface WorkflowAdapter {
  mode: 'simulation' | 'real';
  available?(projectId?: string): Promise<string[]>;
  baseRevision?(settings: Settings, signal?: AbortSignal): Promise<string>;
  issue?(
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<{
    number: number;
    url: string;
    title: string;
    body: string;
    updatedAt: string;
  }>;
  execute(
    run: WorkflowRun,
    attempt: StageAttempt,
    signal: AbortSignal,
  ): Promise<StageResult>;
  inspect(
    run: WorkflowRun,
  ): Promise<{ source: string; base: string; quiescent: boolean }>;
  cancel(run: WorkflowRun, attempt: StageAttempt): Promise<boolean>;
  reconcile(run: WorkflowRun): Promise<{
    quiescent: boolean;
    publicationResult?: string;
    publicationAbsent?: boolean;
  }>;
  specification(
    run: WorkflowRun,
  ): Promise<Ticket & { issueSnapshot?: WorkflowRun['issueSnapshot'] }>;
}
/** This adapter never runs a command, calls a model, changes a repository, or contacts GitHub. */
export function simulationAdapter(clock = systemClock): WorkflowAdapter {
  return {
    mode: 'simulation',
    async execute(run, attempt, signal) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal.removeEventListener('abort', aborted);
          resolve();
        };
        const cancel = clock.timer(done, 100);
        const aborted = () => {
          cancel();
          reject(new Error('Interrupted simulation'));
        };
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      });
      return {
        outcome: 'passed',
        message: `Simulated ${attempt.stage} passed.`,
        ...(attempt.stage === 'developer'
          ? { source: `simulated-tree:${attempt.id}` }
          : {}),
        ...(attempt.stage === 'reviewer' ? { verdict: 'pass' as const } : {}),
        ...(attempt.stage === 'publishing'
          ? {
              publicationResult: `Simulated PR for ${run.publication!.id} (no GitHub PR created)`,
            }
          : {}),
      };
    },
    async inspect(run) {
      return { source: run.source, base: run.currentBase, quiescent: true };
    },
    async specification(run) {
      return clone(run.specification);
    },
    async cancel() {
      return true;
    },
    async reconcile() {
      return { quiescent: true, publicationAbsent: true };
    },
  };
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
function conflict(message: string): never {
  throw new ApiError('CONFLICT', message, 409);
}
function invalid(message: string): never {
  throw new ApiError('INVALID_INPUT', message, 400);
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{1,100}$/.test(value) &&
    !Object.hasOwn(Object.prototype, value)
  );
}
const terminal = (run: WorkflowRun) =>
  ['cancelled', 'pr_ready'].includes(run.status);
const locked = (run: WorkflowRun) =>
  Boolean(run.publicationLocked) ||
  run.stage === 'publishing' ||
  run.status === 'pr_ready';
const done = {
  status: 'terminal' as const,
  outcome: { status: 'completed' as const, result: null },
};
type Runtime = TaskRuntime<
  { runId: string; attemptId: string },
  { phase: 'execute' },
  null,
  object
>;
export function workflowExtension(getService: () => WorkflowService) {
  const task = defineTask<
    { runId: string; attemptId: string },
    { phase: 'execute' },
    null
  >({
    name: 'factory.workflow-stage',
    version: 1,
    initial: () => ({ phase: 'execute' }),
    phases: {
      execute: async (record, runtime) => {
        try {
          await getService().execute(
            record.input.runId,
            record.input.attemptId,
            runtime,
          );
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await getService().taskFailure(record.input.runId, runtime);
        }
      },
    },
    abort: async (record, runtime) => {
      await getService().taskAborted(
        record.input.runId,
        record.input.attemptId,
        runtime,
      );
    },
  });
  return {
    task,
    extension: defineExtension({ name: 'factory-workflow', tasks: [task] }),
  };
}
export class WorkflowService {
  private active = new Map<string, AbortController>();
  private streams = new Set<() => void>();
  private closing = false;
  private recovering = true;
  private releaseActivation!: () => void;
  private activation = new Promise<void>((resolve) => {
    this.releaseActivation = resolve;
  });
  constructor(
    private harness: Harness,
    private task: ReturnType<typeof workflowExtension>['task'],
    private adapter?: WorkflowAdapter,
    private clock = systemClock,
  ) {}
  private compatible(run: WorkflowRun) {
    return Boolean(
      this.adapter &&
        (this.adapter.mode === run.mode ||
          (this.adapter.mode === 'real' && run.mode === 'simulation')),
    );
  }
  private async transaction<T>(change: (state: State, tx: Tx) => Promise<T>) {
    return this.harness.commit(async (tx) => {
      const state = await tx.doc(Workflow);
      if (state.schemaVersion !== 1)
        throw new ApiError('NOT_READY', 'Unsupported workflow schema.', 503);
      const value = state as unknown as State;
      if (!value.slots) {
        value.slots = occupiedSlots(value);
        delete value.slot;
      }
      for (const run of Object.values(value.runs)) {
        const before = JSON.stringify(run.inputs);
        await this.pendingInputs(tx, run);
        if (before !== JSON.stringify(run.inputs)) this.changed(value, run);
      }
      return change(value, tx);
    }, context);
  }
  /** Runs of one project, or of every project when none is named. */
  async snapshot(projectId?: string): Promise<WorkflowSnapshot> {
    const state = await this.harness.snapshot(Workflow, context);
    const missingPrerequisites =
      (await this.adapter?.available?.(projectId)) ?? [];
    return {
      enabled: Boolean(this.adapter) && !missingPrerequisites.length,
      mode: this.adapter?.mode ?? 'disabled',
      missingPrerequisites,
      revision: state?.revision ?? 0,
      runners: await this.runners(),
      slots: occupiedSlots(state),
      ...(occupiedSlots(state)[0] ? { slot: occupiedSlots(state)[0] } : {}),
      runs: Object.values(state?.runs ?? {})
        .map((r) => ({
          ...(clone(r) as WorkflowRun),
          projectId: r.projectId ?? DEFAULT_PROJECT_ID,
        }))
        .filter((r) => !projectId || r.projectId === projectId)
        .sort((a, b) => a.queueOrder - b.queueOrder),
    };
  }
  async prerequisites(projectId: string) {
    return (await this.adapter?.available?.(projectId)) ?? [];
  }
  /** How many runs may work at once. */
  async runners() {
    return Math.max(
      1,
      (await this.harness.snapshot(Configuration, context))?.runners ?? 1,
    );
  }
  /** Starts waiting runs after the number of runners has grown. */
  async reschedule() {
    await this.transaction(async (state, tx) => this.schedule(state, tx));
  }
  private hold(state: State, id: string) {
    if (!state.slots.includes(id)) state.slots.push(id);
  }
  private release(state: State, id: string) {
    state.slots = state.slots.filter((slot) => slot !== id);
  }
  async get(id: string) {
    const run = (await this.snapshot()).runs.find((r) => r.id === id);
    if (!run) throw new ApiError('NOT_FOUND', 'Run not found.', 404);
    return run;
  }
  private changed(state: State, run: WorkflowRun) {
    const attempt = run.attempts.at(-1);
    const labels: Record<RunStage, string> = {
      setup: 'Workspace setup',
      baseline: 'Legacy baseline checks',
      developer: 'Development',
      checks: 'Required checks',
      reviewer: 'Independent review',
      publication: 'Publication preparation',
      publishing: 'PR publication',
    };
    run.activity ??= [];
    const append = (
      signature: string,
      title: string,
      detail = '',
      at = this.clock.now(),
    ) => {
      if (run.activity!.some((event) => event.signature === signature)) return;
      run.activity!.push({
        id: String(run.activity!.length + 1),
        at,
        signature,
        title,
        detail,
        ...(attempt ? { attemptId: attempt.id } : {}),
      });
    };
    if (attempt?.outcome)
      append(
        `outcome:${attempt.id}:${attempt.taskId}:${attempt.outcome}`,
        `${labels[attempt.stage]} · ${attempt.outcome.replaceAll('_', ' ')}`,
        attempt.message ?? '',
        attempt.finishedAt,
      );
    const active =
      attempt?.stage === run.stage && !attempt.outcome ? attempt : undefined;
    // Scheduling sets the next stage before creating its task. Do not report the
    // preceding attempt's outcome as though it belonged to that next stage.
    if (run.status !== 'running' || active) {
      const signature = `state:${JSON.stringify([run.status, run.stage, active?.id, active?.taskId, run.repairCount, run.cleanup, run.publication?.state, run.publication?.pushState, run.publication?.prState])}:${run.decisions.length}`;
      const statuses: Partial<Record<WorkflowRun['status'], string>> = {
        queued: 'Implementation queued',
        pausing: 'Pausing implementation',
        paused: 'Implementation paused',
        needs_input: 'Waiting for your input',
        cancelling: 'Cancelling implementation',
        cancelled: 'Implementation cancelled',
        termination_blocker: 'Process reconciliation required',
        pr_ready: 'Pull request ready',
      };
      append(
        signature,
        run.cleanup
          ? `Cleanup ${run.cleanup.state}`
          : (statuses[run.status] ?? `${labels[run.stage]} started`),
        run.cleanup?.message ?? '',
      );
    }
    state.revision++;
    run.revision++;
  }
  private question(run: WorkflowRun, reason: string, question: string) {
    if (
      run.interventions.some(
        (i) => i.state === 'pending' && i.reason === reason,
      )
    )
      return;
    const attempt = run.attempts.at(-1);
    run.interventions.push({
      id: randomUUID(),
      revision: 0,
      state: 'pending',
      createdAt: this.clock.now(),
      reason,
      question,
      ...(attempt ? { attemptId: attempt.id, taskId: attempt.taskId } : {}),
      conversationId: attempt?.conversationId ?? run.developerConversationId,
    });
  }
  private async entry(
    tx: Tx,
    conversationId: string,
    text: string,
    user = false,
  ) {
    return tx.appendEntry(Number(conversationId) as ConversationId, {
      kind: user ? 'pi.user' : 'factory.workflow',
      model: user
        ? [{ role: 'user', content: text, timestamp: this.clock.now() }]
        : undefined,
      data: { text, at: this.clock.now() },
    });
  }
  private async pendingInputs(tx: Tx, run: WorkflowRun) {
    for (const input of run.inputs.filter((i) => i.status === 'queued')) {
      const record = await tx.submissionByRequest(
        Number(run.developerConversationId) as ConversationId,
        input.requestId,
      );
      if (record?.status === 'unanswered') input.status = 'withdrawn';
    }
    return run.inputs.some((i) => i.status === 'queued');
  }
  private async schedule(state: State, tx: Tx) {
    const deletions = await tx.doc(Deletions);
    if (this.closing || this.recovering || !this.adapter) return;
    const runners = Math.max(1, (await tx.doc(Configuration)).runners ?? 1);
    // Unconfirmed processes keep their runner and exclude new work in the
    // same repository, including legacy runs whose slot was released before
    // recovery discovered the blocker.
    const blocked = new Set<string>();
    for (const blocker of Object.values(state.runs))
      if (blocker.status === 'termination_blocker') {
        this.hold(state, blocker.id);
        blocked.add(blocker.repository.id);
      }
    // The oldest queued runs go first, whichever project they belong to.
    while (state.slots.length < runners) {
      const next = Object.values(state.runs)
        .filter(
          (r) =>
            r.status === 'queued' &&
            this.compatible(r) &&
            !blocked.has(r.repository.id) &&
            !deleting(deletions, undefined, r.id),
        )
        .sort((a, b) => a.queueOrder - b.queueOrder)[0];
      if (!next) break;
      this.hold(state, next.id);
      next.status = 'running';
      this.changed(state, next);
    }
    for (const id of [...state.slots]) {
      const run = state.runs[id];
      if (!run) this.release(state, id);
      else if (run.status === 'running' && state.slots.includes(id))
        await this.advance(state, tx, run);
    }
  }
  private async advance(state: State, tx: Tx, run: WorkflowRun) {
    const deletions = await tx.doc(Deletions);
    if (
      deleting(deletions, undefined, run.id) ||
      !this.compatible(run) ||
      run.status !== 'running' ||
      (run.attempts.length && !run.attempts.at(-1)!.outcome)
    )
      return;
    if (run.contractVersion === 2) {
      try {
        validateTicketContract(run.specification);
      } catch (error) {
        run.status = 'needs_input';
        run.quiescent = true;
        this.release(state, run.id);
        if (
          !run.interventions.some(
            (i) =>
              i.reason === 'specification_contract' && i.state === 'pending',
          )
        )
          this.question(
            run,
            'specification_contract',
            `Update the issue and explicitly adopt its specification: ${(error as Error).message}`,
          );
        this.changed(state, run);
        await this.schedule(state, tx);
        return;
      }
    }
    // Only dependency setup precedes development. Validation follows edits.
    if (run.setupRequired && run.stage !== 'setup') run.stage = 'setup';
    if (run.stage === 'developer' && run.repairPending) {
      if (run.repairCount >= run.repairLimit) {
        this.question(
          run,
          'repair_exhausted',
          'Repair limit reached. Continue to authorize one additional repair.',
        );
        run.status = 'needs_input';
        run.quiescent = true;
        this.release(state, run.id);
        this.changed(state, run);
        await this.schedule(state, tx);
        return;
      }
      run.repairCount++;
      run.repairPending = false;
    }
    const resumed =
      run.attempts.at(-1)?.outcome === 'interrupted' &&
      run.attempts.at(-1)?.stage === run.stage
        ? run.attempts.at(-1)
        : undefined;
    const id = resumed?.id ?? randomUUID();
    const taskId = await tx.createTask(
      this.task,
      { runId: run.id, attemptId: id },
      {
        ownership: { kind: 'conversation' },
        conversationId: Number(run.developerConversationId) as ConversationId,
      },
    );
    const conversationId =
      resumed?.conversationId ??
      (run.stage === 'reviewer'
        ? await createRunConversation(
            tx,
            run.id,
            run.projectId ?? DEFAULT_PROJECT_ID,
            'review',
            run.configuration.repository,
            run.configuration.roles.review,
            taskId,
          )
        : run.developerConversationId);
    const timeout =
      run.mode === 'real'
        ? 86400
        : run.stage === 'setup'
          ? run.configuration.timeouts.setup
          : ['baseline', 'checks'].includes(run.stage)
            ? run.configuration.timeouts.check
            : ['developer', 'reviewer'].includes(run.stage)
              ? run.configuration.timeouts.provider
              : run.configuration.timeouts.tool;
    if (resumed) {
      resumed.taskId = String(taskId);
      resumed.deadline = this.clock.now() + timeout * 1000;
      delete resumed.outcome;
      delete resumed.finishedAt;
      delete resumed.message;
    } else
      run.attempts.push({
        id,
        taskId: String(taskId),
        conversationId,
        stage: run.stage,
        repair: run.repairCount,
        ...(run.stage === 'developer' && run.pendingRepairCauses?.length
          ? { repairCauses: [...run.pendingRepairCauses] }
          : {}),
        startedAt: this.clock.now(),
        deadline: this.clock.now() + timeout * 1000,
        recoveryCount: 0,
      });
    const catalog = await tx.doc(Catalog);
    const item = catalog.items[conversationId];
    if (item)
      item.title = `${run.mode === 'simulation' ? 'Simulation · ' : ''}Issue #${run.issue.number} · ${run.specification.title}${run.stage === 'reviewer' ? ' · Review' : ''}`;
    if (run.stage === 'developer') delete run.pendingRepairCauses;
    run.quiescent = false;
    if (run.stage === 'publishing') {
      run.publicationLocked = true;
      run.publication ??= { id: randomUUID(), state: 'prepared' };
    }
    if (run.stage === 'developer') {
      for (const input of run.inputs.filter((i) => i.status === 'queued')) {
        const entry = await this.entry(tx, conversationId, input.content, true);
        tx.placeSubmission(
          Number(input.submissionId) as SubmissionId,
          entry.id,
        );
        input.status = 'consumed';
      }
    }
    this.changed(state, run);
  }
  async admit(
    input: unknown,
    signal?: AbortSignal,
    expectedConfigurationRevision?: number,
    source: 'explicit' | 'label' = 'explicit',
  ) {
    if (!this.adapter || this.closing)
      throw new ApiError(
        'NOT_READY',
        'Development is unavailable. Launch with explicit workflow simulation mode to simulate a run.',
        503,
      );
    const body = input as {
      operationId: string;
      conversationId: string;
      newRun?: boolean;
      issueNumber?: number;
      sourceRunId?: string;
      projectId?: string;
    };
    if (
      !body ||
      !identifier(body.operationId) ||
      (!identifier(body.conversationId) &&
        !Number.isSafeInteger(body.issueNumber) &&
        !identifier(body.sourceRunId)) ||
      (body.newRun !== undefined && typeof body.newRun !== 'boolean') ||
      [body.conversationId, body.issueNumber, body.sourceRunId].filter(
        (value) => value !== undefined,
      ).length !== 1 ||
      (body.issueNumber !== undefined &&
        (!Number.isSafeInteger(body.issueNumber) || body.issueNumber < 1))
    )
      invalid('Provide conversationId, operationId, and optional newRun.');
    const payload = JSON.stringify({
      conversationId: body.conversationId,
      newRun: body.newRun === true,
      issueNumber: body.issueNumber,
      sourceRunId: body.sourceRunId,
    });
    await this.harness.commit(
      (tx) => assertNotDeleting(tx, body.conversationId, body.sourceRunId),
      context,
    );
    const prior = body.sourceRunId
      ? await this.get(body.sourceRunId)
      : undefined;
    if (prior) {
      body.newRun = true;
      if (prior.mode === 'simulation' && prior.planningConversationId)
        body.conversationId = prior.planningConversationId;
      else body.issueNumber = prior.issue.number;
    }
    // A conversation or earlier run decides its project; only a bare issue
    // number needs it named.
    const projectId = prior
      ? (prior.projectId ?? DEFAULT_PROJECT_ID)
      : body.conversationId
        ? ((
            (await this.harness.snapshot(Catalog, context))?.items[
              body.conversationId
            ] as { projectId?: string } | undefined
          )?.projectId ?? DEFAULT_PROJECT_ID)
        : (body.projectId ?? DEFAULT_PROJECT_ID);
    if (body.projectId !== undefined && body.projectId !== projectId)
      invalid('The conversation or run belongs to another project.');
    const configuration = (await this.harness.snapshot(
      Configuration,
      context,
    ))!;
    const saved = projectOf(configuration, projectId);
    const checkConfiguration = (revision: number) => {
      if (
        expectedConfigurationRevision !== undefined &&
        revision !== expectedConfigurationRevision
      )
        conflict(
          'Settings changed since label discovery. Poll the current repository again.',
        );
    };
    checkConfiguration(saved.revision);
    const capturedSettings = clone(saved.settings) as unknown as Settings;
    if (capturedSettings.repository.path)
      capturedSettings.repository.path = await realpath(
        capturedSettings.repository.path,
      );
    const currentState = await this.harness.snapshot(Workflow, context);
    const receipt = currentState?.receipts[body.operationId];
    if (receipt) {
      if (receipt.payload !== payload)
        conflict('Operation ID already belongs to another command.');
      const recorded = await this.get(receipt.runId);
      if (recorded.projectId !== projectId)
        conflict('Operation ID already belongs to another project.');
      return recorded;
    }
    if (
      prior &&
      (prior.repository.github !== capturedSettings.repository.github ||
        prior.repository.path !== capturedSettings.repository.path)
    )
      conflict(
        'Restore the run repository settings before starting a new run.',
      );
    const linked = body.conversationId
      ? (
          await this.harness.snapshot(
            Planning,
            Number(body.conversationId) as ConversationId,
            context,
          )
        )?.value
      : undefined;
    const issueNumber = body.issueNumber ?? linked?.operation?.issue?.number;
    const existing = Object.values(currentState?.runs ?? {})
      .filter(
        (r) =>
          r.issue.number === issueNumber &&
          r.repository.path === capturedSettings.repository.path &&
          r.repository.github === capturedSettings.repository.github,
      )
      .sort((a, b) => b.queueOrder - a.queueOrder)[0] as
      | WorkflowRun
      | undefined;
    if (existing && (!body.newRun || !terminal(existing))) {
      if (body.newRun)
        conflict(
          'Finish or cancel the existing run before explicitly starting another.',
        );
      await this.transaction(async (state, tx) => {
        checkConfiguration(
          projectOf(await tx.doc(Configuration), projectId).revision,
        );
        await assertNotDeleting(tx, undefined, existing.id);
        state.receipts[body.operationId] = { payload, runId: existing.id };
      });
      return this.get(existing.id);
    }
    if (this.adapter.mode === 'real') {
      const missing = (await this.adapter.available?.(projectId)) ?? [];
      if (missing.length)
        throw new ApiError(
          'NOT_READY',
          `Development unavailable. Complete: ${missing.join(', ')}`,
          503,
        );
    }
    signal?.throwIfAborted();
    const remoteIssue =
      issueNumber &&
      this.adapter.issue &&
      (body.issueNumber || this.adapter.mode === 'real')
        ? await this.adapter.issue(
            capturedSettings.repository.github,
            issueNumber,
            signal,
          )
        : undefined;
    if (body.issueNumber && !remoteIssue)
      invalid('Issue admission requires a real GitHub issue adapter.');
    const resolvedBase =
      this.adapter.mode === 'real'
        ? await this.adapter.baseRevision?.(capturedSettings, signal)
        : undefined;
    const id = await this.transaction(async (state, tx) => {
      checkConfiguration(
        projectOf(await tx.doc(Configuration), projectId).revision,
      );
      signal?.throwIfAborted();
      if (this.closing)
        throw new ApiError(
          'NOT_READY',
          'Development admission is closing.',
          503,
        );
      const receipt = state.receipts[body.operationId];
      if (receipt) {
        if (receipt.payload !== payload)
          conflict('Operation ID already belongs to another command.');
        if (
          (state.runs[receipt.runId]?.projectId ?? DEFAULT_PROJECT_ID) !==
          projectId
        )
          conflict('Operation ID already belongs to another project.');
        return receipt.runId;
      }
      await assertNotDeleting(tx, body.conversationId, body.sourceRunId);
      const planning = body.conversationId
        ? (
            await tx.doc(
              Planning,
              Number(body.conversationId) as ConversationId,
            )
          ).value
        : remoteIssue
          ? {
              operation: {
                state: 'created',
                repository: {
                  id: createHash('sha256')
                    .update(
                      JSON.stringify({
                        path: capturedSettings.repository.path,
                        github: capturedSettings.repository.github,
                      }),
                    )
                    .digest('hex'),
                  ...capturedSettings.repository,
                },
                issue: { number: remoteIssue.number, url: remoteIssue.url },
                ticket: {
                  revision: 0,
                  title: remoteIssue.title,
                  goal: remoteIssue.body,
                  scope: 'Implement the captured issue.',
                  acceptanceCriteria:
                    'Satisfy the requirements in the captured issue body.',
                  validation: capturedSettings.requiredChecks.join('\n'),
                },
              },
            }
          : undefined;
      if (!planning?.operation?.issue || planning.operation.state !== 'created')
        invalid('Start from a confirmed linked planning issue.');
      const operation = planning.operation;
      const deletions = await tx.doc(Deletions);
      const suppressionKey = issueDeletionKey(
        operation.repository,
        operation.issue!.number,
      );
      if (source === 'label' && deletions.suppressedIssues?.[suppressionKey])
        conflict(
          'Automatic admission is disabled for this deleted implementation. Start a new implementation explicitly.',
        );
      const existing = Object.values(state.runs)
        .filter(
          (r) =>
            r.repository.id === operation.repository.id &&
            r.issue.number === operation.issue!.number,
        )
        .sort(
          (a, b) => b.createdAt - a.createdAt || b.queueOrder - a.queueOrder,
        )[0];
      if (existing && (!body.newRun || !terminal(existing))) {
        if (body.newRun)
          conflict(
            'Finish or cancel the existing run before explicitly starting another.',
          );
        await assertNotDeleting(tx, undefined, existing.id);
        state.receipts[body.operationId] = { payload, runId: existing.id };
        return existing.id;
      }
      const config = projectOf(await tx.doc(Configuration), projectId);
      const settings = clone(config.settings) as unknown as Settings;
      settings.repository.path = await realpath(settings.repository.path);
      if (
        settings.repository.github !== operation.repository.github ||
        settings.repository.path !== operation.repository.path
      )
        conflict(
          'Current repository settings differ from this issue’s captured repository.',
        );
      if (this.adapter!.mode === 'real') {
        if (config.revision !== saved.revision)
          conflict(
            'Settings changed while resolving admission. Retry the same operation.',
          );
      }
      // Only an explicit, successful new admission clears a manual deletion.
      if (source === 'explicit' && deletions.suppressedIssues)
        delete deletions.suppressedIssues[suppressionKey];
      const id = randomUUID();
      const developerConversationId = await createRunConversation(
        tx,
        id,
        projectId,
        'development',
        settings.repository,
        settings.roles.development,
      );
      const run: WorkflowRun = {
        id,
        projectId,
        revision: 0,
        mode: this.adapter!.mode,
        ...(this.adapter!.mode === 'real'
          ? { contractVersion: 2 as const, implementations: [] }
          : {}),
        planningConversationId: body.conversationId ?? '',
        ...(remoteIssue
          ? {
              issueSnapshot: {
                title: remoteIssue.title,
                body: remoteIssue.body,
                updatedAt: remoteIssue.updatedAt,
              },
            }
          : {}),
        repository: {
          ...clone(operation.repository),
          baseBranch: settings.repository.baseBranch,
        },
        issue: clone(operation.issue!),
        specification: clone(operation.ticket),
        specificationRevision: 0,
        configuration: settings,
        configurationRevision: config.revision,
        status: 'queued',
        stage: 'setup',
        createdAt: this.clock.now(),
        queueOrder: state.nextOrder++,
        base:
          resolvedBase ?? `simulated-base:${operation.repository.baseBranch}`,
        currentBase:
          resolvedBase ?? `simulated-base:${operation.repository.baseBranch}`,
        source:
          resolvedBase ?? `simulated-base:${operation.repository.baseBranch}`,
        quiescent: true,
        repairCount: 0,
        repairLimit: 3,
        repairPending: false,
        setupRequired: true,
        developerConversationId,
        attempts: [],
        evidence: [],
        inputs: [],
        interventions: [],
        decisions: [],
      };
      if (run.contractVersion === 2) {
        try {
          if (remoteIssue && !body.conversationId)
            run.specification = parseIssueTicket(
              remoteIssue.title,
              remoteIssue.body,
            );
          else {
            run.specification.criteria = validateTicketContract(
              run.specification,
            );
            if (remoteIssue) {
              const remote = parseIssueTicket(
                remoteIssue.title,
                remoteIssue.body,
              );
              if (
                remote.title !== run.specification.title ||
                normalizeLineEndings(formatTicketBody(remote)) !==
                  normalizeLineEndings(formatTicketBody(run.specification))
              )
                throw new Error(
                  'The GitHub issue differs from the approved ticket. Explicit adoption is required.',
                );
            }
          }
        } catch (error) {
          run.status = 'needs_input';
          this.question(
            run,
            'specification_contract',
            `Update the GitHub issue with explicit acceptance criteria and regression instructions, then adopt its specification: ${(error as Error).message}`,
          );
        }
      }
      const catalog = await tx.doc(Catalog);
      catalog.items[developerConversationId].title =
        `${run.mode === 'simulation' ? 'Simulation · ' : ''}Issue #${run.issue.number} · ${run.specification.title}`;
      this.changed(state, run);
      state.runs[id] = run;
      state.receipts[body.operationId] = { payload, runId: id };
      await this.schedule(state, tx);
      return id;
    });
    this.harness.resume();
    return this.get(id);
  }
  async input(conversationId: string, value: unknown) {
    const body = value as {
      requestId: string;
      content: string;
      mode?: 'followUp' | 'steer';
    };
    if (
      !body ||
      !identifier(body.requestId) ||
      typeof body.content !== 'string' ||
      !body.content.trim() ||
      Buffer.byteLength(body.content) > 32768 ||
      !['followUp', 'steer'].includes(body.mode ?? 'followUp')
    )
      invalid('Provide a request ID and non-empty input of at most 32 KiB.');
    await this.transaction(async (state, tx) => {
      const run = Object.values(state.runs).find(
        (r) => r.developerConversationId === conversationId,
      );
      if (!run)
        throw new ApiError(
          'FORBIDDEN',
          'Reviewer conversations do not accept ordinary input.',
          403,
        );
      await assertNotDeleting(tx, conversationId, run.id);
      const previous = run.inputs.find((i) => i.requestId === body.requestId);
      if (previous) {
        if (
          previous.content !== body.content ||
          previous.mode !== (body.mode ?? 'followUp')
        )
          conflict('Request ID belongs to different input.');
        return;
      }
      if (
        locked(run) ||
        terminal(run) ||
        ['cancelling', 'termination_blocker'].includes(run.status)
      )
        conflict(
          'Implementation input is closed. Start an explicit new run after publication or cancellation.',
        );
      if (!this.adapter || !this.compatible(run))
        throw new ApiError(
          'NOT_READY',
          'Compatible workflow adapter unavailable.',
          503,
        );
      if (run.inputs.filter((i) => i.status === 'queued').length >= 100)
        throw new ApiError('BUSY', 'Developer input queue is full.', 409);
      const submission = await tx.createSubmission({
        conversationId: Number(conversationId) as ConversationId,
        requestId: body.requestId,
        type: 'input',
        status: 'queued',
      });
      (
        await tx.doc(Requests, Number(conversationId) as ConversationId)
      ).requests[body.requestId] = {
        content: body.content,
        mode: body.mode ?? 'followUp',
      };
      run.inputs.push({
        at: this.clock.now(),
        requestId: body.requestId,
        submissionId: String(submission.id),
        content: body.content,
        mode: body.mode ?? 'followUp',
        status: 'queued',
      });
      this.changed(state, run);
    });
  }
  private validEvidence(run: WorkflowRun, kind: 'checks' | 'reviewer') {
    if (run.contractVersion === 2 && !currentImplementation(run)) return false;
    return run.evidence.some(
      (e) =>
        e.kind === kind &&
        e.passed &&
        e.source === run.source &&
        e.configurationRevision === run.configurationRevision &&
        e.specificationRevision === run.specificationRevision &&
        (run.contractVersion !== 2 ||
          (kind === 'checks'
            ? !run.specification.regression?.required ||
              (e.regression?.passed === true &&
                e.regression.source === run.source &&
                e.regression.base === run.base &&
                e.regression.configurationRevision ===
                  run.configurationRevision &&
                e.regression.specificationRevision ===
                  run.specificationRevision)
            : !!e.assessments?.length &&
              e.assessments.length === run.specification.criteria?.length &&
              e.assessments.every((a) => a.status === 'met'))),
    );
  }
  private developmentEntry(run: WorkflowRun): RunStage {
    return run.setupRequired ? 'setup' : 'developer';
  }
  private invalidate(run: WorkflowRun) {
    if (run.mode === 'real')
      run.evidenceHistory = [...(run.evidenceHistory ?? []), ...run.evidence];
    run.evidence = [];
  }
  async execute(runId: string, attemptId: string, runtime: Runtime) {
    await this.activation;
    let run = await this.get(runId);
    const attempt = run.attempts.find((a) => a.id === attemptId)!;
    if (
      deleting(
        await this.harness.snapshot(Deletions, context),
        undefined,
        runId,
      ) ||
      !this.adapter ||
      !this.compatible(run) ||
      run.status !== 'running' ||
      attempt.outcome ||
      this.closing
    ) {
      await runtime.commit(() => done, context);
      return;
    }
    const controller = new AbortController();
    this.active.set(String(runtime.taskId), controller);
    const abort = () => controller.abort();
    runtime.signal.addEventListener('abort', abort, { once: true });
    let cancelDeadline = () => {};
    let result: StageResult;
    try {
      const operation =
        run.stage === 'publishing' && run.publication?.state === 'confirmed'
          ? Promise.resolve<StageResult>({
              outcome: 'passed',
              message: 'Simulated publication reconciled.',
              publicationResult: run.publication.result,
            })
          : this.adapter.execute(clone(run), clone(attempt), controller.signal);
      // Already-issued publication effects can finish after an interruption; record them without advancing the run.
      void operation
        .then(async (late) => {
          if (controller.signal.aborted && late.publicationResult)
            await this.recordPublication(runId, late.publicationResult);
        })
        .catch(() => {});
      const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error('Workflow interrupted')),
          { once: true },
        );
        if (controller.signal.aborted)
          reject(new Error('Workflow interrupted'));
      });
      const expired = new Promise<never>((_, reject) => {
        cancelDeadline = this.clock.timer(
          () => reject(new Error(`Deadline expired during ${attempt.stage}`)),
          attempt.deadline - this.clock.now(),
        );
      });
      result = await Promise.race([operation, interrupted, expired]);
      if (
        !result ||
        !['passed', 'failed', 'needs_input', 'uncertain'].includes(
          result.outcome,
        ) ||
        typeof result.message !== 'string'
      )
        result = {
          outcome: 'needs_input',
          message: 'Malformed stage result; inspection required.',
        };
      if (
        attempt.stage === 'reviewer' &&
        (!['pass', 'changes_requested', 'needs_input'].includes(
          result.verdict ?? '',
        ) ||
          (result.verdict === 'pass' && result.outcome !== 'passed'))
      )
        result = {
          outcome: 'needs_input',
          message: 'Invalid structured reviewer result; approval rejected.',
        };
      if (run.contractVersion === 2) {
        try {
          if (attempt.stage === 'developer' && result.outcome === 'passed') {
            if (
              !result.implementation ||
              result.implementation.attemptId !== attempt.id ||
              result.implementation.source !== result.source ||
              result.implementation.configurationRevision !==
                run.configurationRevision ||
              result.implementation.specificationRevision !==
                run.specificationRevision
            )
              throw new Error('Missing or stale implementation report.');
            validateImplementation(
              result.implementation,
              run.specification,
              result.implementation.changedFiles,
            );
          }
          if (
            attempt.stage === 'reviewer' &&
            (result.assessments || result.outcome !== 'needs_input')
          )
            validateAssessments(
              result.assessments ?? [],
              run.specification,
              result.verdict ?? '',
            );
          if (
            attempt.stage === 'checks' &&
            result.outcome === 'passed' &&
            run.specification.regression?.required &&
            (!result.regression?.passed ||
              result.regression.base !== run.base ||
              result.regression.source !== run.source ||
              result.regression.configurationRevision !==
                run.configurationRevision ||
              result.regression.specificationRevision !==
                run.specificationRevision)
          )
            throw new Error('Missing or stale regression proof.');
        } catch (error) {
          result = {
            outcome: 'needs_input',
            message: (error as Error).message,
            ...(attempt.stage === 'reviewer'
              ? { verdict: 'needs_input' as const }
              : {}),
          };
        }
      }
    } catch (error) {
      cancelDeadline();
      if (runtime.signal.aborted || this.closing) return;
      const latest = await this.get(runId);
      if (
        latest.status === 'running' &&
        latest.attempts.at(-1)?.taskId === String(runtime.taskId)
      ) {
        await this.requestStop(
          runId,
          'needs_input',
          error instanceof Error
            ? error.message
            : 'Provider or infrastructure failure',
        );
      }
      await runtime.commit(() => done, context);
      return;
    } finally {
      cancelDeadline();
      runtime.signal.removeEventListener('abort', abort);
      this.active.delete(String(runtime.taskId));
    }
    let observation: { source: string; base: string; quiescent: boolean };
    try {
      observation = await this.bounded(
        this.adapter.inspect({ ...run, source: result.source ?? run.source }),
        run.configuration.timeouts.tool * 1000,
        { source: run.source, base: run.currentBase, quiescent: false },
      );
    } catch {
      observation = {
        source: run.source,
        base: run.currentBase,
        quiescent: false,
      };
    }
    await runtime.commit(async (tx) => {
      const state = (await tx.doc(Workflow)) as unknown as State;
      const current = state.runs[runId],
        active = current.attempts.find((a) => a.id === attemptId)!;
      if (
        current.status !== 'running' ||
        active.taskId !== String(runtime.taskId) ||
        active.outcome ||
        current.attempts.at(-1)?.id !== attemptId
      )
        return done;
      const pending = await this.pendingInputs(tx, current);
      active.outcome = result.outcome;
      active.message = result.message;
      active.finishedAt = this.clock.now();
      current.quiescent = observation.quiescent;
      if (!observation.quiescent) {
        current.status = 'termination_blocker';
        current.stopTarget = 'needs_input';
        this.question(
          current,
          'termination',
          'Stage finished but termination is unconfirmed. Reconcile before releasing execution.',
        );
      } else {
        if (attempt.stage === 'developer') {
          const source = result.source ?? observation.source;
          if (source !== current.source) this.invalidate(current);
          current.source = source;
        }
        if (
          attempt.stage === 'developer' &&
          result.implementation &&
          result.outcome === 'passed'
        ) {
          current.implementations ??= [];
          if (
            !current.implementations.some((r) =>
              result.implementation!.id
                ? r.id === result.implementation!.id
                : r.attemptId === attemptId,
            )
          )
            current.implementations.push(clone(result.implementation));
        }
        await this.entry(tx, active.conversationId, result.message);
        if (attempt.stage === 'developer') {
          const answer = await this.entry(
            tx,
            active.conversationId,
            current.mode === 'simulation'
              ? 'Simulated developer boundary reached.'
              : 'Developer boundary reached.',
          );
          for (const input of current.inputs.filter(
            (i) => i.status === 'consumed',
          )) {
            tx.settleSubmission(Number(input.submissionId) as SubmissionId, {
              status: 'done',
              answer: answer.id,
            });
          }
        }
        const changedSource =
          attempt.stage !== 'developer' &&
          observation.source !== current.source;
        if (changedSource) {
          current.source = observation.source;
          this.invalidate(current);
        }
        const baseChanged = observation.base !== current.base;
        current.currentBase = observation.base;
        if (['baseline', 'checks', 'reviewer'].includes(attempt.stage)) {
          current.evidence.push({
            attemptId,
            kind: attempt.stage as 'baseline' | 'checks' | 'reviewer',
            source: current.source,
            configurationRevision: current.configurationRevision,
            specificationRevision: current.specificationRevision,
            passed:
              !changedSource &&
              result.outcome === 'passed' &&
              (attempt.stage !== 'reviewer' || result.verdict === 'pass'),
            output: result.message,
            ...(result.verdict ? { verdict: result.verdict } : {}),
            ...(result.results ? { results: result.results } : {}),
            ...(result.findings ? { findings: result.findings } : {}),
            ...(result.assessments ? { assessments: result.assessments } : {}),
            ...(result.regression ? { regression: result.regression } : {}),
            ...(attempt.stage !== 'reviewer'
              ? {
                  commands: [...current.configuration.requiredChecks],
                  exitCode: result.outcome === 'passed' ? 0 : 1,
                }
              : {}),
            duration: this.clock.now() - active.startedAt,
          });
        }
        if (attempt.stage === 'publishing' && result.publicationResult) {
          current.publication!.result = result.publicationResult;
          current.publication!.state = 'confirmed';
        }
        // Account for validation failure even when guidance arrives at the same boundary.
        if (
          (attempt.stage === 'checks' && result.outcome === 'failed') ||
          (attempt.stage === 'reviewer' &&
            result.verdict === 'changes_requested')
        ) {
          current.repairPending = true;
          current.pendingRepairCauses = [
            ...(current.pendingRepairCauses ?? []),
            attemptId,
          ];
        }
        if (
          result.outcome === 'needs_input' ||
          (attempt.stage === 'reviewer' && result.verdict === 'needs_input') ||
          (['setup', 'baseline'].includes(attempt.stage) &&
            result.outcome === 'failed')
        ) {
          current.status = 'needs_input';
          this.question(current, attempt.stage, result.message);
          // Retain the stage for infrastructure/baseline retry; developer questions resume development.
        } else if (result.outcome === 'uncertain') {
          current.status = 'needs_input';
          if (current.publication) current.publication.state = 'uncertain';
          this.question(current, 'uncertain', result.message);
        } else if (attempt.stage === 'publishing') {
          if (
            result.outcome === 'passed' &&
            current.publication?.state === 'confirmed' &&
            this.validEvidence(current, 'checks') &&
            this.validEvidence(current, 'reviewer') &&
            !baseChanged
          )
            current.status = 'pr_ready';
          else {
            current.status = 'needs_input';
            this.question(
              current,
              'publication',
              'Publication did not confirm a PR. Reconcile before retrying.',
            );
          }
        } else if (
          current.publicationLocked &&
          (changedSource || baseChanged || current.repairPending)
        ) {
          this.invalidate(current);
          current.status = 'needs_input';
          this.question(
            current,
            'publication',
            'Publication content, base, or validation changed. Repeat service validation where safe, or cancel and start an explicit new run for developer edits.',
          );
        } else if (
          (pending && !['setup', 'baseline'].includes(attempt.stage)) ||
          changedSource ||
          baseChanged ||
          (current.repairPending &&
            ['checks', 'reviewer', 'publication'].includes(attempt.stage))
        ) {
          this.invalidate(current);
          current.base = observation.base;
          if (current.workspace) current.workspace.base = observation.base;
          current.stage = current.setupRequired ? 'setup' : 'developer';
        } else if (result.outcome === 'failed') {
          current.status = 'needs_input';
          this.question(current, attempt.stage, result.message);
        } else {
          const next: Record<RunStage, RunStage> = {
            setup: 'developer',
            baseline: 'developer',
            developer: 'checks',
            checks: 'reviewer',
            reviewer: 'publication',
            publication: 'publishing',
            publishing: 'publishing',
          };
          if (attempt.stage === 'setup') current.setupRequired = false;
          if (
            attempt.stage === 'publication' &&
            (!current.quiescent ||
              !this.validEvidence(current, 'checks') ||
              !this.validEvidence(current, 'reviewer'))
          ) {
            current.stage = 'developer';
            this.invalidate(current);
          } else current.stage = next[attempt.stage];
        }
        if (current.status !== 'running') this.release(state, current.id);
      }
      this.changed(state, current);
      await this.schedule(state, tx);
      return done;
    }, context);
  }
  private bounded<T>(
    promise: Promise<T>,
    timeout: number,
    fallback: T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = this.clock.timer(() => resolve(fallback), timeout);
      promise.then(
        (value) => {
          cancel();
          resolve(value);
        },
        (error) => {
          cancel();
          reject(error);
        },
      );
    });
  }
  private async recordPublication(id: string, result: string) {
    await this.transaction(async (state) => {
      const run = state.runs[id];
      if (run.publication) {
        run.publication.state = 'confirmed';
        run.publication.result = result;
        this.changed(state, run);
      }
    });
  }
  private async finishStop(
    id: string,
    confirmed: boolean,
    publicationAbsent = false,
  ) {
    await this.transaction(async (state, tx) => {
      const run = state.runs[id];
      if (
        !['pausing', 'cancelling', 'termination_blocker'].includes(run.status)
      )
        return;
      run.quiescent = confirmed;
      if (
        run.mode === 'real' &&
        !['sending', 'uncertain', 'confirmed'].includes(
          run.publication?.pushState ?? '',
        ) &&
        !['sending', 'uncertain', 'confirmed'].includes(
          run.publication?.prState ?? '',
        )
      )
        publicationAbsent = true;
      if (
        run.stage === 'publishing' &&
        run.publication?.state !== 'confirmed' &&
        !publicationAbsent
      ) {
        if (run.publication) run.publication.state = 'uncertain';
        if (run.stopTarget !== 'cancelled')
          this.question(
            run,
            'uncertain',
            'Publishing was interrupted. Reconcile the publication operation before resuming.',
          );
      }
      run.status = confirmed
        ? (run.stopTarget ?? 'paused')
        : 'termination_blocker';
      const attempt = run.attempts.at(-1);
      if (attempt && !attempt.outcome) {
        attempt.outcome = 'interrupted';
        attempt.finishedAt = this.clock.now();
        attempt.message = run.status;
      }
      if (!confirmed)
        this.question(
          run,
          'termination',
          'Cancellation could not confirm termination. Execution slot is retained; reconcile after inspection.',
        );
      else {
        this.release(state, id);
        for (const intervention of run.interventions.filter(
          (i) =>
            ['termination', 'adapter'].includes(i.reason) &&
            i.state === 'pending',
        )) {
          intervention.state = 'resolved';
          intervention.resolvedAt = this.clock.now();
          intervention.revision++;
          intervention.answer = 'Termination confirmed by adapter inspection.';
        }
        if (run.status === 'cancelled') {
          for (const input of run.inputs.filter((i) => i.status === 'queued')) {
            input.status = 'withdrawn';
            tx.settleSubmission(Number(input.submissionId) as SubmissionId, {
              status: 'unanswered',
              reason: 'aborted',
            });
          }
        }
      }
      if (confirmed) this.skipStoppedBaselines(state, run.id);
      this.changed(state, run);
      await this.schedule(state, tx);
    });
  }
  private async stopWork(id: string) {
    const run = await this.get(id);
    const attempt = run.attempts.at(-1);
    if (!attempt || run.quiescent) {
      await this.finishStop(id, true);
      return;
    }
    this.active.get(attempt.taskId)?.abort();
    let confirmed = false;
    try {
      confirmed = Boolean(
        this.adapter &&
          this.compatible(run) &&
          (await this.bounded(
            this.adapter.cancel(run, attempt),
            run.configuration.timeouts.cancellation * 1000,
            false,
          )),
      );
    } catch {
      /* retain blocker */
    }
    await this.finishStop(id, confirmed);
  }
  private async requestStop(
    id: string,
    target: 'paused' | 'needs_input' | 'cancelled',
    reason?: string,
  ) {
    const requested = await this.transaction(async (state) => {
      const run = state.runs[id];
      if (
        terminal(run) ||
        (run.stopTarget === 'cancelled' && target !== 'cancelled') ||
        (target !== 'cancelled' &&
          ['pausing', 'cancelling', 'termination_blocker', 'paused'].includes(
            run.status,
          ))
      )
        return false;
      run.stopTarget = target;
      run.status = target === 'cancelled' ? 'cancelling' : 'pausing';
      if (reason) this.question(run, 'execution', reason);
      this.changed(state, run);
      return true;
    });
    if (requested) await this.stopWork(id);
  }
  async deliverSteering(id: string, attemptId: string) {
    await this.transaction(async (state, tx) => {
      const run = state.runs[id];
      if (
        run.mode !== 'real' ||
        run.status !== 'running' ||
        run.stage !== 'developer' ||
        run.publicationLocked ||
        run.attempts.at(-1)?.id !== attemptId
      )
        return;
      for (const input of run.inputs.filter(
        (i) => i.status === 'queued' && i.mode === 'steer',
      )) {
        const entry = await this.entry(
          tx,
          run.developerConversationId,
          input.content,
          true,
        );
        tx.placeSubmission(
          Number(input.submissionId) as SubmissionId,
          entry.id,
        );
        input.status = 'consumed';
        this.changed(state, run);
      }
    });
  }
  async refreshInputs() {
    await this.transaction(async () => {});
  }
  async stopForDeletion(id: string) {
    await this.requestStop(id, 'cancelled');
    const run = await this.get(id);
    if (!terminal(run) || (await this.snapshot()).slots.includes(id))
      throw new ApiError(
        'CONFLICT',
        'Agent termination could not be confirmed. Retry deletion after resolving the termination blocker.',
        409,
      );
  }
  async interruptConversation(conversationId: string) {
    const run = (await this.snapshot()).runs.find(
      (r) => r.developerConversationId === conversationId,
    );
    if (!run)
      throw new ApiError('FORBIDDEN', 'Reviewer input is restricted.', 403);
    await this.requestStop(run.id, 'paused');
  }
  async command(id: string, value: unknown) {
    await this.harness.commit(
      (tx) => assertNotDeleting(tx, undefined, id),
      context,
    );
    const body = value as RunCommand;
    if (
      !body ||
      !identifier(body.operationId) ||
      !Number.isInteger(body.expectedRevision) ||
      ![
        'pause',
        'resume',
        'cancel',
        'answer',
        'continue',
        'adopt_configuration',
        'adopt_specification',
        'reconcile',
        'revalidate',
      ].includes(body.action)
    )
      invalid('Invalid workflow command.');
    if (
      body.action === 'answer' &&
      (!identifier(body.interventionId) ||
        !Number.isInteger(body.interventionRevision) ||
        typeof body.answer !== 'string' ||
        !body.answer.trim() ||
        body.answer.length > 16000)
    )
      invalid('Provide the intervention ID, revision, and a non-empty answer.');
    if (
      body.action === 'adopt_configuration' &&
      this.adapter?.mode === 'real'
    ) {
      const missing =
        (await this.adapter.available?.((await this.get(id)).projectId)) ?? [];
      if (missing.length)
        invalid(
          `Complete configuration before adoption: ${missing.join(', ')}`,
        );
    }
    let revalidation:
      | { source: string; base: string; quiescent: boolean }
      | undefined;
    if (body.action === 'revalidate') {
      const run = await this.get(id);
      if (
        run.mode !== 'real' ||
        !run.publicationLocked ||
        !['paused', 'needs_input'].includes(run.status)
      )
        conflict('Only stopped real publication can repeat validation.');
      if (
        run.publication?.pushed ||
        ['sending', 'uncertain', 'confirmed'].includes(
          run.publication?.pushState ?? '',
        ) ||
        ['sending', 'uncertain', 'confirmed'].includes(
          run.publication?.prState ?? '',
        )
      )
        conflict(
          'Reconcile existing remote publication; content changes require a new run.',
        );
      revalidation = await this.adapter!.inspect(run);
      if (!revalidation.quiescent || revalidation.base !== run.base)
        conflict(
          'Publication must be stopped with the same base before revalidation.',
        );
    }
    let stop = false,
      reconcile = false;
    const payload = JSON.stringify([
      id,
      body.action,
      body.expectedRevision,
      body.interventionId ?? null,
      body.interventionRevision ?? null,
      body.answer ?? null,
    ]);
    let specification:
      | (Ticket & { issueSnapshot?: WorkflowRun['issueSnapshot'] })
      | undefined;
    if (body.action === 'adopt_specification' && this.adapter) {
      const current = await this.get(id);
      specification = await this.bounded(
        this.adapter.specification(current),
        current.configuration.timeouts.tool * 1000,
        undefined,
      );
      if (
        !specification ||
        !Number.isInteger(specification.revision) ||
        ['title', 'goal', 'scope', 'acceptanceCriteria', 'validation'].some(
          (key) =>
            typeof specification![key as keyof Ticket] !== 'string' ||
            !String(specification![key as keyof Ticket]).trim(),
        )
      )
        invalid(
          'The specification adapter returned an invalid or unavailable ticket.',
        );
    }
    await this.transaction(async (state, tx) => {
      await assertNotDeleting(tx, undefined, id);
      const run = state.runs[id];
      if (!run) throw new ApiError('NOT_FOUND', 'Run not found.', 404);
      const receipt = state.receipts[body.operationId];
      if (receipt) {
        if (receipt.payload !== payload)
          conflict('Operation ID belongs to a different command.');
        return;
      }
      if (run.revision !== body.expectedRevision)
        conflict('Run changed. Refresh before applying this command.');
      if (!this.adapter || !this.compatible(run))
        throw new ApiError(
          'NOT_READY',
          'Start with a compatible workflow mode before operating this run.',
          503,
        );
      if (terminal(run))
        conflict('This run has finished. Start an explicit new run.');
      if (
        ['adopt_configuration', 'adopt_specification'].includes(body.action)
      ) {
        if (locked(run))
          conflict('Publication has begun. An explicit new run is required.');
        if (!['paused', 'needs_input', 'queued'].includes(run.status))
          conflict('Pause the run before adopting changes.');
        if (body.action === 'adopt_configuration') {
          const saved = projectOf(
            await tx.doc(Configuration),
            run.projectId ?? DEFAULT_PROJECT_ID,
          );
          const settings = clone(saved.settings) as unknown as Settings;
          settings.repository.path = await realpath(settings.repository.path);
          if (
            settings.repository.path !== run.repository.path ||
            settings.repository.github !== run.repository.github
          )
            conflict('Cannot adopt a different repository. Start a new run.');
          if (
            run.mode === 'real' &&
            settings.repository.baseBranch !== run.repository.baseBranch
          )
            conflict(
              'Changing the target base branch requires an explicit new run.',
            );
          const setupChanged =
            JSON.stringify(settings.setupCommands) !==
            JSON.stringify(run.configuration.setupCommands);
          run.configuration = settings;
          run.configurationRevision = saved.revision;
          const catalog = await tx.doc(Catalog);
          catalog.items[run.developerConversationId].model = clone(
            settings.roles.development,
          );
          await (
            await import('@earendil-works/pi-durable')
          ).configure(
            tx,
            Number(run.developerConversationId) as ConversationId,
            {
              model:
                settings.roles.development.provider &&
                settings.roles.development.model
                  ? {
                      provider: settings.roles.development.provider,
                      modelId: settings.roles.development.model,
                    }
                  : null,
            },
          );
          if (setupChanged) {
            run.setupRequired = true;
            run.stage = 'setup';
          } else run.stage = this.developmentEntry(run);
        } else {
          if (!specification) conflict('No specification available to adopt.');
          const { issueSnapshot, ...ticket } = specification;
          if (run.contractVersion === 2) {
            try {
              ticket.criteria = validateTicketContract(ticket);
            } catch (error) {
              invalid((error as Error).message);
            }
          }
          run.specification = clone(ticket);
          if (issueSnapshot) run.issueSnapshot = clone(issueSnapshot);
          run.specificationRevision++;
          run.stage = this.developmentEntry(run);
          for (const intervention of run.interventions.filter(
            (i) =>
              i.state === 'pending' && i.reason === 'specification_contract',
          )) {
            intervention.state = 'resolved';
            intervention.resolvedAt = this.clock.now();
            intervention.revision++;
            intervention.answer =
              'Explicitly adopted complete issue specification.';
          }
        }
        this.invalidate(run);
      } else if (body.action === 'revalidate') {
        if (!revalidation) conflict('Publication inspection unavailable.');
        run.source = revalidation.source;
        this.invalidate(run);
        run.stage = 'checks';
        run.status = 'queued';
        run.queueOrder = state.nextOrder++;
        if (run.publication) {
          delete run.publication.commit;
          delete run.publication.tree;
          delete run.publication.cleanupIgnored;
          run.publication.state = 'prepared';
        }
        for (const intervention of run.interventions.filter(
          (i) =>
            i.state === 'pending' &&
            ['execution', 'publication'].includes(i.reason),
        )) {
          intervention.state = 'resolved';
          intervention.resolvedAt = this.clock.now();
          intervention.revision++;
          intervention.answer = 'Explicit service-only revalidation requested.';
        }
        if (run.interventions.some((i) => i.state === 'pending'))
          conflict('Resolve pending questions before revalidation.');
        delete run.stopTarget;
      } else if (body.action === 'pause' || body.action === 'cancel') {
        if (
          ['pausing', 'cancelling', 'termination_blocker'].includes(run.status)
        )
          conflict('Resolve the existing stop or termination blocker first.');
        run.stopTarget = body.action === 'cancel' ? 'cancelled' : 'paused';
        run.status = body.action === 'cancel' ? 'cancelling' : 'pausing';
        stop = true;
      } else if (body.action === 'reconcile') {
        const pausedPublication =
          run.status === 'paused' &&
          run.stage === 'publishing' &&
          Boolean(run.publication);
        if (
          !['termination_blocker', 'needs_input'].includes(run.status) &&
          !pausedPublication
        )
          conflict('This run does not need reconciliation.');
        reconcile = true;
      } else {
        if (!['paused', 'needs_input'].includes(run.status))
          conflict('Only paused runs or runs awaiting input can resume.');
        if (body.action === 'answer') {
          const intervention = run.interventions.find(
            (i) => i.id === body.interventionId,
          );
          if (
            !intervention ||
            intervention.state !== 'pending' ||
            intervention.revision !== body.interventionRevision
          )
            conflict('Question changed or already answered.');
          if (!acceptsTypedAnswer(intervention))
            conflict(
              'Use the explicit continuation or reconciliation control for this blocker.',
            );
          intervention.answer = body.answer;
          intervention.state = 'resolved';
          intervention.resolvedAt = this.clock.now();
          intervention.revision++;
        }
        if (body.action === 'continue') {
          const exhausted = run.interventions.find(
            (i) => i.state === 'pending' && i.reason === 'repair_exhausted',
          );
          if (!exhausted) conflict('No repair continuation is pending.');
          run.repairLimit = run.repairCount + 1;
          exhausted.state = 'resolved';
          exhausted.resolvedAt = this.clock.now();
          exhausted.revision++;
          exhausted.answer = 'One additional repair explicitly authorized.';
        }
        if (run.interventions.some((i) => i.state === 'pending'))
          conflict('Resolve pending interventions before resuming.');
        run.status = 'queued';
        run.queueOrder = state.nextOrder++;
        delete run.stopTarget;
      }
      run.decisions.push({
        operationId: body.operationId,
        action: body.action,
        at: this.clock.now(),
        detail: body.answer ?? body.action,
      });
      state.receipts[body.operationId] = { payload, runId: id };
      this.changed(state, run);
      await this.schedule(state, tx);
    });
    if (stop) await this.stopWork(id);
    if (reconcile) {
      const run = await this.get(id);
      let outcome = { quiescent: false } as {
        quiescent: boolean;
        publicationResult?: string;
        publicationAbsent?: boolean;
      };
      try {
        outcome = await this.bounded(
          this.adapter!.reconcile(run),
          run.configuration.timeouts.cancellation * 1000,
          outcome,
        );
      } catch {
        /* preserve uncertainty */
      }
      if (outcome.publicationResult)
        await this.recordPublication(id, outcome.publicationResult);
      if (
        outcome.quiescent &&
        outcome.publicationAbsent &&
        !outcome.publicationResult &&
        run.publication?.state !== 'confirmed'
      ) {
        await this.transaction(async (state) => {
          const current = state.runs[id];
          if (
            !['paused', 'needs_input', 'termination_blocker'].includes(
              current.status,
            ) ||
            current.publication?.state === 'confirmed'
          )
            return;
          if (current.publication) current.publication.state = 'prepared';
          for (const i of current.interventions.filter(
            (i) =>
              i.state === 'pending' &&
              ['uncertain', 'publication'].includes(i.reason),
          )) {
            i.state = 'resolved';
            i.resolvedAt = this.clock.now();
            i.revision++;
            i.answer =
              'No uncertain creation remains. Explicit resume will reconcile the remaining publication steps.';
          }
          this.changed(state, current);
        });
      }
      if (run.status === 'termination_blocker')
        await this.finishStop(
          id,
          outcome.quiescent,
          outcome.publicationAbsent === true && !outcome.publicationResult,
        );
      else if (
        outcome.quiescent &&
        (outcome.publicationResult || run.publication?.state === 'confirmed')
      ) {
        await this.transaction(async (state, tx) => {
          const current = state.runs[id];
          if (
            !['paused', 'needs_input'].includes(current.status) ||
            !this.validEvidence(current, 'checks') ||
            !this.validEvidence(current, 'reviewer') ||
            current.base !== current.currentBase
          )
            return;
          if (current.status === 'needs_input') current.status = 'pr_ready';
          for (const i of current.interventions.filter(
            (i) => i.state === 'pending',
          )) {
            i.state = 'resolved';
            i.resolvedAt = this.clock.now();
            i.revision++;
            i.answer = 'Publication reconciled.';
          }
          this.changed(state, current);
          await this.schedule(state, tx);
        });
      }
    }
    this.harness.resume();
    return this.get(id);
  }
  async cleanupState(id: string, cleanup: NonNullable<WorkflowRun['cleanup']>) {
    await this.transaction(async (state) => {
      const run = state.runs[id];
      if (!run || run.status !== 'pr_ready')
        conflict('Only completed PR runs can be cleaned up.');
      run.cleanup = cleanup;
      this.changed(state, run);
    });
  }
  async recover() {
    this.recovering = true;
    await this.transaction(async (state, tx) => {
      const catalog = await tx.doc(Catalog);
      for (const run of Object.values(state.runs)) {
        for (const id of new Set([
          run.developerConversationId,
          ...run.attempts.map((a) => a.conversationId),
        ])) {
          const item = catalog.items[id];
          if (item)
            item.title = `${run.mode === 'simulation' ? 'Simulation · ' : ''}Issue #${run.issue.number} · ${run.specification.title}${item.role === 'review' ? ' · Review' : ''}`;
        }
        if (
          terminal(run) ||
          deleting(await tx.doc(Deletions), undefined, run.id)
        )
          continue;
        const existing = run.attempts.at(-1);
        if (existing && !existing.outcome) {
          const task = await tx.task(Number(existing.taskId) as never);
          if (task?.state.status === 'terminal') {
            run.status = 'termination_blocker';
            run.stopTarget ??= 'needs_input';
            this.question(
              run,
              'execution',
              'The prior Pi task ended without a stage outcome. Inspect and answer before retrying.',
            );
          }
        }
        const attempt = run.attempts.at(-1);
        if (attempt && !attempt.outcome) {
          attempt.recoveryCount++;
          attempt.recoveries ??= [];
          attempt.recoveries.push({ at: this.clock.now() });
          if (run.mode === 'real') {
            run.status = 'termination_blocker';
            run.stopTarget ??= 'needs_input';
            this.question(
              run,
              'execution',
              'Service restarted during real work. Inspect preserved effects before explicitly continuing.',
            );
          }
        }
        if (!this.adapter || !this.compatible(run)) {
          if (state.slots.includes(run.id)) {
            run.status = 'termination_blocker';
            run.stopTarget ??= 'needs_input';
            this.question(
              run,
              'adapter',
              `Restart with ${run.mode} execution enabled to inspect this run.`,
            );
          }
        } else if (['pausing', 'cancelling'].includes(run.status)) {
          // Reconcile below before any execution is allowed.
          run.status = 'termination_blocker';
        }
        this.changed(state, run);
      }
      await this.schedule(state, tx);
    });
    for (const run of (await this.snapshot()).runs) {
      if (
        deleting(
          await this.harness.snapshot(Deletions, context),
          undefined,
          run.id,
        )
      )
        continue;
      if (
        !this.adapter ||
        !this.compatible(run) ||
        (!['running', 'termination_blocker'].includes(run.status) &&
          !(
            run.stage === 'baseline' &&
            ['paused', 'needs_input', 'queued'].includes(run.status)
          ))
      )
        continue;
      let observation: {
        quiescent: boolean;
        publicationResult?: string;
        publicationAbsent?: boolean;
      } = {
        quiescent: false,
      };
      try {
        observation = await this.bounded(
          this.adapter.reconcile(run),
          run.configuration.timeouts.cancellation * 1000,
          observation,
        );
      } catch {
        /* uncertain work retains the slot */
      }
      if (observation.publicationResult)
        await this.recordPublication(run.id, observation.publicationResult);
      if (
        run.stage === 'baseline' &&
        observation.quiescent &&
        ['paused', 'needs_input', 'queued'].includes(run.status)
      ) {
        await this.transaction(async (state) => {
          state.runs[run.id].quiescent = true;
          this.skipStoppedBaselines(state, run.id);
        });
      }
      if (run.status === 'termination_blocker') {
        if (observation.quiescent)
          await this.finishStop(
            run.id,
            true,
            observation.publicationAbsent === true &&
              !observation.publicationResult,
          );
      } else if (!observation.quiescent) {
        await this.transaction(async (state) => {
          const current = state.runs[run.id];
          current.status = 'termination_blocker';
          this.hold(state, current.id);
          current.stopTarget ??= 'needs_input';
          this.question(
            current,
            'termination',
            'Restart inspection cannot confirm old work stopped. Execution slot retained.',
          );
          this.changed(state, current);
        });
      }
    }
  }

  private skipStoppedBaselines(state: State, id: string) {
    for (const run of Object.values(state.runs)) {
      if (
        run.id !== id ||
        run.stage !== 'baseline' ||
        !run.quiescent ||
        terminal(run) ||
        ['running', 'pausing', 'cancelling', 'termination_blocker'].includes(
          run.status,
        )
      )
        continue;
      const attempt = run.attempts.at(-1);
      if (attempt?.stage === 'baseline' && attempt.outcome !== 'passed') {
        attempt.outcome = 'skipped';
        attempt.finishedAt ??= this.clock.now();
        attempt.message =
          'Pre-development baseline checks removed; retained for history.';
      }
      run.stage = 'developer';
      run.setupRequired = false;
      for (const question of run.interventions) {
        if (question.state === 'pending' && question.reason === 'baseline') {
          question.state = 'resolved';
          question.revision++;
          question.resolvedAt = this.clock.now();
          question.answer =
            'Obsolete baseline gate superseded. Explicit resume is still required.';
        }
      }
      this.changed(state, run);
    }
  }

  async activate() {
    this.recovering = false;
    this.releaseActivation();
    await this.transaction((state, tx) => this.schedule(state, tx));
    this.harness.resume();
  }
  async patchRun(
    id: string,
    attemptId: string,
    change: (run: WorkflowRun, tx: Tx) => void | Promise<void>,
    allowStopped = false,
  ) {
    await this.transaction(async (state, tx) => {
      const run = state.runs[id];
      if (
        !run ||
        run.attempts.at(-1)?.id !== attemptId ||
        (!allowStopped &&
          (run.status !== 'running' || run.attempts.at(-1)?.outcome))
      )
        throw new Error('Run attempt no longer accepts effects.');
      await change(run, tx);
      this.changed(state, run);
    });
  }
  async taskFailure(id: string, runtime: Runtime) {
    const run = await this.get(id);
    if (
      run.status === 'running' &&
      run.attempts.at(-1)?.taskId === String(runtime.taskId)
    )
      await this.requestStop(
        id,
        'needs_input',
        'Workflow task failed before committing a stage outcome. Inspect and answer before retrying.',
      );
    await runtime.commit(() => done, context);
  }
  async taskAborted(id: string, attemptId: string, runtime: Runtime) {
    if (!this.closing) {
      const run = await this.get(id);
      if (run.attempts.at(-1)?.id === attemptId && run.status === 'running')
        await this.requestStop(
          id,
          'needs_input',
          'Pi task was interrupted; inspect before resuming.',
        );
    }
    await runtime.commit(() => done, context);
  }
  /** `resume` is the version a reconnecting client already holds. The stored
   * revision does not cover what the adapter reports on each read, so the
   * version also covers whether development is enabled and what it lacks. */
  async stream(res: ServerResponse, resume?: string, projectId?: string) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    // A resumed stream may have nothing to send for a while, and the client
    // cannot tell the connection is open until it sees the headers.
    res.flushHeaders();
    const streamId = randomUUID();
    let sequence = 0,
      closed = false,
      busy = false,
      last = resume ?? '';
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      this.streams.delete(close);
      res.end();
    };
    const write = (text: string) => {
      if (res.writableLength + Buffer.byteLength(text) > 1048576) {
        close();
        return;
      }
      res.write(text);
    };
    const publish = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const snapshot = await this.snapshot(projectId);
        const version = `${snapshot.revision}.${contentVersion(
          JSON.stringify([
            snapshot.enabled,
            snapshot.mode,
            snapshot.missingPrerequisites,
          ]),
        )}`;
        if (!closed && version !== last) {
          last = version;
          write(
            `id: ${version}\ndata: ${JSON.stringify({ apiVersion: API_VERSION, streamId, sequence: ++sequence, type: sequence === 1 ? 'snapshot' : 'update', snapshot })}\n\n`,
          );
        }
      } finally {
        busy = false;
      }
    };
    const poll = setInterval(() => void publish().catch(close), 100);
    const heartbeat = setInterval(
      () => write('event: heartbeat\ndata: {}\n\n'),
      15000,
    );
    res.on('close', close);
    this.streams.add(close);
    await publish();
  }
  async close() {
    this.closing = true;
    for (const close of this.streams) close();
    for (const run of (await this.snapshot()).runs.filter(
      (r) => r.status === 'running',
    ))
      await this.requestStop(run.id, 'paused');
  }
}
