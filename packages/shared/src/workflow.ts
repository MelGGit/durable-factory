import type {
  BoundImplementation,
  CriterionAssessment,
  RegressionEvidence,
} from './handoffs.js';
import {
  API_VERSION,
  ApiError,
  FactoryClient,
  responseError,
  type Settings,
} from './core.js';
import type { RepositoryRegistration, Ticket, IssueLink } from './planning.js';
export type RunStage =
  | 'setup'
  | 'baseline'
  | 'developer'
  | 'checks'
  | 'reviewer'
  | 'publication'
  | 'publishing';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'needs_input'
  | 'cancelling'
  | 'cancelled'
  | 'termination_blocker'
  | 'pr_ready';
export interface StageAttempt {
  id: string;
  taskId: string;
  stage: RunStage;
  conversationId: string;
  repair: number;
  startedAt: number;
  deadline: number;
  recoveryCount: number;
  repairCauses?: string[];
  recoveries?: { at: number }[];
  outcome?:
    | 'passed'
    | 'failed'
    | 'interrupted'
    | 'needs_input'
    | 'uncertain'
    | 'skipped';
  finishedAt?: number;
  message?: string;
}
export interface RunEvidence {
  assessments?: CriterionAssessment[];
  regression?: RegressionEvidence;
  attemptId: string;
  kind: 'baseline' | 'checks' | 'reviewer';
  source: string;
  configurationRevision: number;
  specificationRevision: number;
  passed: boolean;
  output: string;
  verdict?: 'pass' | 'changes_requested' | 'needs_input';
  findings?: {
    message: string;
    blocking: boolean;
    path?: string;
    line?: number;
  }[];
  commands?: string[];
  results?: {
    command: string;
    exitCode: number;
    duration: number;
    artifact: string;
  }[];
  exitCode?: number;
  duration: number;
}
export interface Intervention {
  createdAt?: number;
  resolvedAt?: number;
  id: string;
  revision: number;
  state: 'pending' | 'resolved';
  reason: string;
  question: string;
  attemptId?: string;
  taskId?: string;
  conversationId: string;
  answer?: string;
}
export interface RunInput {
  at?: number;
  requestId: string;
  submissionId: string;
  content: string;
  mode: 'followUp' | 'steer';
  status: 'queued' | 'consumed' | 'withdrawn';
}
export interface RunInspection {
  commands: { id: string; command: string; state: string; startedAt: number }[];
  conversations: {
    id: string;
    role: string;
    tools: { id: string; name: string; status: string }[];
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      messages: number;
      estimatedCost?: number;
      partial: boolean;
    };
  }[];
}
export interface WorkflowRun {
  activity?: {
    id: string;
    at: number;
    signature: string;
    title: string;
    detail: string;
    attemptId?: string;
  }[];
  contractVersion?: 2;
  implementations?: BoundImplementation[];
  pendingRepairCauses?: string[];
  proofIndexes?: string[];
  proofWorkspaces?: {
    id: string;
    root: string;
    commit: string;
    base: string;
    source: string;
    state: 'prepared' | 'ready' | 'removed';
    results?: NonNullable<RunEvidence['results']>;
    inventory?: { digest: string; files: number };
  }[];
  cleanup?: { state: 'pending' | 'blocked'; message: string };
  id: string;
  revision: number;
  mode: 'simulation' | 'real';
  planningConversationId: string;
  issueSnapshot?: { title: string; body: string; updatedAt: string };
  workspace?: {
    path: string;
    branch: string;
    base: string;
    includedIgnored: string[];
  };
  publicationLocked?: boolean;
  repository: RepositoryRegistration;
  issue: IssueLink;
  specification: Ticket;
  specificationRevision: number;
  configuration: Settings;
  configurationRevision: number;
  status: RunStatus;
  stage: RunStage;
  createdAt: number;
  queueOrder: number;
  base: string;
  currentBase: string;
  source: string;
  quiescent: boolean;
  repairCount: number;
  repairLimit: number;
  repairPending: boolean;
  setupRequired: boolean;
  developerConversationId: string;
  attempts: StageAttempt[];
  evidence: RunEvidence[];
  evidenceHistory?: RunEvidence[];
  inputs: RunInput[];
  interventions: Intervention[];
  decisions: {
    operationId: string;
    action: string;
    at: number;
    detail: string;
  }[];
  publication?: {
    id: string;
    payload?: { title: string; body: string; head: string; base: string };
    state: 'prepared' | 'uncertain' | 'confirmed';
    result?: string;
    commit?: string;
    tree?: string;
    cleanupIgnored?: { digest: string; files: number };
    pushed?: boolean;
    pushState?: 'prepared' | 'sending' | 'confirmed' | 'uncertain';
    prState?: 'prepared' | 'sending' | 'confirmed' | 'uncertain';
    prNumber?: number;
    prHead?: string;
  };
  stopTarget?: 'paused' | 'needs_input' | 'cancelled';
}
export interface WorkflowSnapshot {
  enabled: boolean;
  mode: 'simulation' | 'real' | 'disabled';
  missingPrerequisites?: string[];
  revision: number;
  slot?: string;
  runs: WorkflowRun[];
}
export type RunAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'answer'
  | 'continue'
  | 'adopt_configuration'
  | 'adopt_specification'
  | 'reconcile'
  | 'revalidate';
export interface RunCommand {
  operationId: string;
  expectedRevision: number;
  action: RunAction;
  interventionId?: string;
  interventionRevision?: number;
  answer?: string;
}
export interface WorkflowFrame {
  apiVersion: typeof API_VERSION;
  streamId: string;
  sequence: number;
  type: 'snapshot' | 'update';
  snapshot: WorkflowSnapshot;
}
export class WorkflowReducer {
  streamId = '';
  sequence = 0;
  snapshot?: WorkflowSnapshot;
  apply(frame: WorkflowFrame) {
    if (frame.apiVersion !== API_VERSION)
      throw new ApiError(
        'UNSUPPORTED_VERSION',
        'Reload the application to use this workflow API.',
        409,
      );
    if (
      frame.type !== 'snapshot' &&
      (frame.streamId !== this.streamId || frame.sequence !== this.sequence + 1)
    ) {
      if (frame.streamId === this.streamId && frame.sequence <= this.sequence)
        return false;
      throw new Error('Workflow stream requires a fresh snapshot.');
    }
    if (frame.streamId === this.streamId && frame.sequence <= this.sequence)
      return false;
    this.streamId = frame.streamId;
    this.sequence = frame.sequence;
    this.snapshot = frame.snapshot;
    return true;
  }
}
export class WorkflowClient extends FactoryClient {
  inspection(id: string) {
    return this.request<RunInspection>(
      `/runs/${encodeURIComponent(id)}/inspection`,
    );
  }
  workflow(signal?: AbortSignal) {
    return this.request<WorkflowSnapshot>('/runs', { signal });
  }
  run(id: string) {
    return this.request<WorkflowRun>(`/runs/${encodeURIComponent(id)}`);
  }
  startRun(conversationId: string, operationId: string, newRun = false) {
    return this.mutation<WorkflowRun>('/runs', 'POST', {
      conversationId,
      operationId,
      newRun,
    });
  }
  startIssue(issueNumber: number, operationId: string) {
    return this.mutation<WorkflowRun>('/runs', 'POST', {
      issueNumber,
      operationId,
    });
  }
  newRun(id: string, operationId: string) {
    return this.mutation<WorkflowRun>('/runs', 'POST', {
      sourceRunId: id,
      operationId,
      newRun: true,
    });
  }
  command(id: string, command: RunCommand) {
    return this.mutation<WorkflowRun>(
      `/runs/${encodeURIComponent(id)}/commands`,
      'POST',
      command,
    );
  }
  /** Streams over fetch rather than EventSource, so it runs in Node and can
   * send an Authorization header. A reconnect says which state it already
   * holds, and the service then skips resending it. */
  watchRuns(
    onSnapshot: (snapshot: WorkflowSnapshot) => void,
    onConnection: (connected: boolean) => void,
    onError: (error: Error) => void = () => {},
  ) {
    const reducer = new WorkflowReducer();
    const lifetime = new AbortController();
    let active: AbortController | undefined,
      watchdog: ReturnType<typeof setTimeout> | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      wake: (() => void) | undefined,
      held: string | undefined;
    void (async () => {
      let retries = 0;
      while (!lifetime.signal.aborted) {
        active = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const touch = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => active?.abort(), 45000);
        };
        try {
          touch();
          const response = await this.fetcher.call(
            globalThis,
            `${this.baseUrl}/api/v1/runs/events`,
            {
              signal: active.signal,
              headers:
                held === undefined ? undefined : { 'Last-Event-ID': held },
            },
          );
          if (!response.ok)
            throw await responseError(response, 'Workflow stream unavailable.');
          if (!response.body) throw new Error('Streaming is unavailable.');
          reader = response.body.getReader();
          retries = 0;
          onConnection(true);
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('Workflow stream closed.');
            touch();
            buffer = (
              buffer + decoder.decode(chunk.value, { stream: true })
            ).replace(/\r\n/g, '\n');
            if (buffer.length > 2 * 1024 * 1024)
              throw new Error('Workflow frame is too large.');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (event.startsWith('event: heartbeat')) continue;
              const lines = event.split('\n');
              const data = lines
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (!data) continue;
              if (reducer.apply(JSON.parse(data) as WorkflowFrame)) {
                held =
                  lines
                    .find((line) => line.startsWith('id:'))
                    ?.slice(3)
                    .trim() ?? held;
                onSnapshot(reducer.snapshot!);
              }
            }
          }
        } catch (error) {
          if (lifetime.signal.aborted) break;
          onConnection(false);
          if (error instanceof ApiError) {
            onError(error);
            if (
              [
                'AUTHENTICATION',
                'NOT_FOUND',
                'FORBIDDEN',
                'UNSUPPORTED_VERSION',
              ].includes(error.code)
            )
              break;
          }
        } finally {
          clearTimeout(watchdog);
          active.abort();
          await reader?.cancel().catch(() => {});
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          retry = setTimeout(
            resolve,
            Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)),
          );
        });
      }
    })();
    return () => {
      lifetime.abort();
      active?.abort();
      clearTimeout(watchdog);
      clearTimeout(retry);
      wake?.();
    };
  }
}
