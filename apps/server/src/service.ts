import { Deletions, deleting, issueDeletionKey } from './deletion-state.js';
import { Planning } from './planning.js';
import type { ConversationId } from '@earendil-works/pi-durable';
import type { DeletionOperation } from '../../../packages/shared/src/deletion.js';
import { RunActivityService } from './activity.js';
import {
  runAgUi,
  conversationEncoder,
  activityEncoder,
  agUiSnapshot,
} from './ag-ui.js';
import {
  activityView,
  historyView,
  viewSnapshotEvents,
} from '../../../packages/shared/src/ag-ui-view.js';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { redactResponse, type Redaction } from './redaction.js';
import { lastEventId } from './sse.js';
import { readFile, realpath, open } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  API_VERSION,
  DEFAULT_PROJECT_ID,
  projectLabel,
  ApiError,
  type CredentialId,
  type SettingsResponse,
} from '../../../packages/shared/src/index.js';
import {
  acquireOwnership,
  defaultDataDir,
  inside,
  log,
  sourceRoot,
} from './runtime.js';
import {
  PrivateCredentials,
  CredentialStorageError,
  type CredentialVault,
} from './credentials.js';
import { OAuthSessions, type OAuthLogin } from './oauth.js';
import { safeAuthFailure } from './auth-errors.js';
import { openConfiguration, context } from './storage.js';
import { providerStatuses, createFactoryModels } from './providers.js';
import { createRegistry } from '@earendil-works/pi-durable';
import {
  ChatService,
  Catalog,
  recordingTools,
  outputPage,
  type ChatDependencies,
} from './chat.js';
import { PlanningService } from './planning.js';
import { createGitHub, GitHubFailure, type GitHubAdapter } from './github.js';
import {
  WorkflowService,
  workflowExtension,
  simulationAdapter,
  type WorkflowAdapter,
  type WorkflowClock,
} from './workflow.js';
import { RealWorkflow } from './real-workflow.js';
import { ProcessSupervisor } from './processes.js';
import {
  cleanupSnapshot,
  purgeRunStorage,
  cleanupWorkspace,
  cleanupArtifacts,
} from './cleanup.js';
import { Workspaces } from './workspace.js';
import {
  parseUpdate,
  validateSettings,
  validateTitleGenerator,
} from './validation.js';

export interface ServiceOptions {
  /** Programmatic dependency injection; never configurable through HTTP or environment. */
  credentialVault?: CredentialVault;
  oauthLogin?: OAuthLogin;
  dataDir?: string;
  port?: number;
  development?: boolean;
  webDir?: string;
  chat?: ChatDependencies;
  github?: GitHubAdapter;
  workflow?: { adapter: WorkflowAdapter; clock?: WorkflowClock };
  workflowMode?: 'simulation' | 'real' | 'disabled';
  /** Disposable local transport for offline real-workflow verification only. */
  workflowRemote?: string;
  /** Address to listen on. Anything beyond loopback requires `authToken`. */
  host?: string;
  /** Extra Host header values to accept, such as a reverse proxy's public name. */
  allowedHosts?: string[];
  /** Extra origins to accept, written as `https://factory.example.com`. */
  allowedOrigins?: string[];
  /** Shared secret required as a bearer token on every `/api/v1` request. */
  authToken?: string;
}
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
const wildcardHosts = new Set(['0.0.0.0', '::']);
/** How a host is written in a URL or Host header, where IPv6 needs brackets. */
const hostLabel = (host: string) => (host.includes(':') ? `[${host}]` : host);
const digest = (value: string) => createHash('sha256').update(value).digest();
const forwardingHeaders = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
];
/** A same-machine caller. A proxy on this machine also connects from
 * loopback, so a forwarded or renamed request does not count as local. */
function isLocal(req: IncomingMessage) {
  const hostname = req.headers.host
    ?.replace(/:\d+$/, '')
    .replace(/^\[(.*)\]$/, '$1');
  return (
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
      req.socket.remoteAddress ?? '',
    ) &&
    hostname !== undefined &&
    loopbackHosts.has(hostname) &&
    forwardingHeaders.every((name) => req.headers[name] === undefined)
  );
}
/** Settings hold commands the server runs, and credentials choose who it acts as. */
function changesAccess(method: string | undefined, path: string) {
  return (
    (method === 'PUT' && path === '/api/v1/settings') ||
    (method === 'POST' && path === '/api/v1/github/validate') ||
    (method !== 'GET' && path.startsWith('/api/v1/projects')) ||
    (method === 'PUT' && path === '/api/v1/runners') ||
    (method === 'PUT' && path === '/api/v1/title-generator') ||
    ((method === 'PUT' || method === 'DELETE') &&
      path.startsWith('/api/v1/credentials/'))
  );
}
export async function startService(options: ServiceOptions = {}) {
  const csrfToken = randomBytes(32).toString('hex');
  let ready = false,
    stopping = false,
    startupError: ApiError | undefined;
  let ownership: Awaited<ReturnType<typeof acquireOwnership>> | undefined;
  let configuration: Awaited<ReturnType<typeof openConfiguration>> | undefined;
  let credentials: PrivateCredentials;
  let oauth: OAuthSessions | undefined;
  let chat: ChatService | undefined;
  let activity: RunActivityService | undefined;
  let planning: PlanningService;
  let github: GitHubAdapter;
  let workflow: WorkflowService;
  let processes: ProcessSupervisor;
  let workspaces: Workspaces;
  let maintenance = false;
  let runtimeOpen = false;
  let reopeningNeeded = false;
  let reopeningUnsafe = false;
  let reopeningAttempts = 0;
  let reopeningTimer: ReturnType<typeof setTimeout> | undefined;
  const maxReopeningAttempts = 3;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let cleanupPolling: Promise<void> | undefined;
  let deletionPolling: Promise<void> | undefined;
  let deletionTimer: ReturnType<typeof setInterval> | undefined;
  let nextCleanupPoll = 0;
  const mode =
    options.workflowMode ?? process.env.DURABLE_FACTORY_WORKFLOW_MODE ?? 'real';
  if (!['disabled', 'simulation', 'real'].includes(mode))
    throw new Error('Invalid workflow mode');
  const host = options.host ?? '127.0.0.1';
  const authToken = options.authToken;
  if (authToken !== undefined && authToken.length < 32)
    throw new Error('The API token must be at least 32 characters.');
  if (!loopbackHosts.has(host) && authToken === undefined)
    throw new Error('Listening beyond loopback requires an API token.');
  const tokenDigest = authToken === undefined ? undefined : digest(authToken);
  let activeMutations = new Set<Promise<unknown>>();
  let labelTimer: ReturnType<typeof setInterval> | undefined;
  let labelPolling: Promise<void> | undefined;
  let nextLabelPoll = 0;
  let labelAbort = new AbortController();
  let port = options.port ?? 4317;
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  };
  async function snapshot(projectId: string): Promise<SettingsResponse> {
    const saved = await configuration!.read(projectId);
    const metadata = await credentials.inspect();
    return {
      apiVersion: API_VERSION,
      ...saved,
      credentials: metadata.configured,
      credentialErrors: metadata.errors,
      credentialStorage: metadata.storage,
      providers: await providerStatuses(credentials, metadata),
    };
  }
  /** Built once the settings can be read, and again after they are saved, so
   * a request that will be refused does not cost a read and path lookups. */
  let cachedRedactions: Redaction[] | undefined;
  /** Directories a remote client has no use for. Longer paths win, so the
   * repository is named before the home directory that contains it. */
  async function redactions() {
    if (cachedRedactions) return cachedRedactions;
    const found: Redaction[] = [];
    const add = async (path: string | undefined, label: string) => {
      if (!path) return;
      found.push([path, label]);
      const real = await realpath(path).catch(() => path);
      if (real !== path) found.push([real, label]);
    };
    const projects = await configuration?.projects().catch(() => undefined);
    for (const project of projects ?? [])
      await add(project.repository.path, '<repository>');
    await add(ownership?.dataDir, '<data>');
    await add(homedir(), '~');
    if (projects) cachedRedactions = found;
    return found;
  }
  async function body(
    req: IncomingMessage,
    maxBytes = 65536,
  ): Promise<unknown> {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json')
      throw new ApiError(
        'INVALID_INPUT',
        'Use application/json for request bodies.',
        415,
      );
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > maxBytes)
        throw new ApiError(
          'INVALID_INPUT',
          'Request exceeds the allowed size.',
          413,
        );
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ApiError(
        'INVALID_INPUT',
        'Request body is not valid JSON.',
        400,
      );
    }
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const hosts = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      ...(options.development ? ['127.0.0.1:5173', 'localhost:5173'] : []),
      ...(wildcardHosts.has(host) ? [] : [`${hostLabel(host)}:${port}`]),
      ...(options.allowedHosts ?? []),
    ]);
    if (!req.headers.host || !hosts.has(req.headers.host))
      throw new ApiError('FORBIDDEN', 'Unrecognized local host.', 403);
    const allowedOrigins = new Set([
      ...[...hosts]
        .filter((entry) => !options.allowedHosts?.includes(entry))
        .map((entry) => `http://${entry}`),
      ...(options.allowedOrigins ?? []),
    ]);
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
      throw new ApiError(
        'FORBIDDEN',
        'Cross-site requests are not allowed.',
        403,
      );
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new ApiError(
        'FORBIDDEN',
        'Cross-site requests are not allowed.',
        403,
      );
    const url = new URL(req.url ?? '/', 'http://localhost');
    // /projects/:id/<resource> addresses a resource of one project. Handlers
    // see the plain path, and the project the request is for.
    const scopedPath =
      /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)(\/(?:settings|conversations|runs|runs\/events|github\/validate|issues(?:\/\d+\/planning)?))$/.exec(
        url.pathname,
      );
    const scopedProject = scopedPath?.[1];
    const projectId = scopedProject ?? DEFAULT_PROJECT_ID;
    const path = scopedPath ? `/api/v1${scopedPath[2]}` : url.pathname;
    if (tokenDigest && !isLocal(req)) redactResponse(res, await redactions());
    if (path === '/health' && req.method === 'GET')
      return send(res, 200, { status: 'healthy' });
    if (path === '/ready' && req.method === 'GET')
      return send(res, ready && !stopping ? 200 : 503, {
        status: stopping ? 'stopping' : ready ? 'ready' : 'blocked',
        ...(startupError
          ? {
              error: { code: startupError.code, message: startupError.message },
            }
          : {}),
      });
    if (path.startsWith('/api/') && !path.startsWith('/api/v1/'))
      throw new ApiError(
        'UNSUPPORTED_VERSION',
        'This service supports /api/v1.',
        400,
      );
    if (path.startsWith('/api/v1/')) {
      // Login state contains transient authorization URLs and is local-only even for GET.
      if (
        (path.startsWith('/api/v1/auth/') ||
          path === '/api/v1/credentials/retry-storage') &&
        !isLocal(req)
      )
        throw new ApiError(
          'FORBIDDEN',
          'Connect accounts on the server itself.',
          403,
        );
      if (tokenDigest) {
        const authorization = req.headers.authorization;
        const presented =
          (typeof authorization === 'string'
            ? /^Bearer (.+)$/i.exec(authorization)?.[1]
            : undefined) ??
          (typeof req.headers['x-factory-token'] === 'string'
            ? req.headers['x-factory-token']
            : undefined);
        if (
          presented === undefined ||
          !timingSafeEqual(digest(presented), tokenDigest)
        ) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="durable-factory"');
          throw new ApiError(
            'AUTHENTICATION',
            'A valid API token is required.',
            401,
          );
        }
        if (changesAccess(req.method, path) && !isLocal(req))
          throw new ApiError(
            'FORBIDDEN',
            'Change settings and credentials on the server itself.',
            403,
          );
      }
      if (!ready || stopping || maintenance)
        throw (
          startupError ??
          new ApiError(
            'NOT_READY',
            'The service is starting or stopping. Retry shortly.',
            503,
          )
        );
      if (scopedProject) await configuration!.read(scopedProject);
      // A bearer token is not an ambient credential, so it needs no CSRF guard.
      if (req.method !== 'GET' && !tokenDigest) {
        const header = req.headers['x-factory-csrf'];
        if (
          typeof header !== 'string' ||
          Buffer.byteLength(header) !== Buffer.byteLength(csrfToken) ||
          !timingSafeEqual(Buffer.from(header), Buffer.from(csrfToken))
        )
          throw new ApiError(
            'FORBIDDEN',
            'Reconnect to the local service before changing settings.',
            403,
          );
      }
      if (path === '/api/v1/deletions' && req.method === 'GET')
        return send(res, 200, {
          operations: Object.values(
            (await configuration!.harness.snapshot(Deletions, context))
              ?.items ?? {},
          ),
        });
      const deletionRoute = /^\/api\/v1\/deletions\/([A-Za-z0-9_-]+)$/.exec(
        path,
      );
      if (deletionRoute && req.method === 'GET') {
        const operation = (
          await configuration!.harness.snapshot(Deletions, context)
        )?.items[deletionRoute[1]];
        if (!operation)
          throw new ApiError('NOT_FOUND', 'Deletion not found.', 404);
        return send(res, 200, operation);
      }
      const deleteTarget =
        /^\/api\/v1\/(conversations|runs)\/([A-Za-z0-9_-]+)$/.exec(path);
      if (deleteTarget && req.method === 'DELETE') {
        await body(req);
        return send(
          res,
          202,
          await requestDeletion(deleteTarget[1] === 'runs', deleteTarget[2]),
        );
      }
      if (path === '/api/v1/runners' && req.method === 'GET')
        return send(res, 200, { runners: await configuration!.runners() });
      if (path === '/api/v1/title-generator' && req.method === 'GET')
        return send(res, 200, await configuration!.titleGenerator());
      if (path === '/api/v1/title-generator' && req.method === 'PUT') {
        const value = await validateTitleGenerator(
          await body(req),
          credentials,
        );
        await configuration!.saveTitleGenerator(value);
        return send(res, 200, await configuration!.titleGenerator());
      }
      if (path === '/api/v1/runners' && req.method === 'PUT') {
        const { runners } = (await body(req)) as { runners?: unknown };
        await configuration!.setRunners(runners);
        await workflow.reschedule();
        return send(res, 200, { runners: await configuration!.runners() });
      }
      if (path === '/api/v1/projects' && req.method === 'GET')
        return send(res, 200, {
          apiVersion: API_VERSION,
          projects: await Promise.all(
            (await configuration!.projects()).map(async (project) => ({
              ...project,
              missingPrerequisites: await workflow.prerequisites(project.id),
            })),
          ),
        });
      if (path === '/api/v1/projects' && req.method === 'POST') {
        const { name } = (await body(req)) as { name?: unknown };
        const source = (await configuration!.projects())[0]?.id;
        const created = await configuration!.create(name as string, source);
        cachedRedactions = undefined;
        return send(res, 201, created);
      }
      const projectRoute = /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)$/.exec(path);
      if (projectRoute && req.method === 'PATCH') {
        const { name } = (await body(req)) as { name?: unknown };
        return send(
          res,
          200,
          await configuration!.rename(projectRoute[1], name as string),
        );
      }
      if (projectRoute && req.method === 'DELETE') {
        await body(req);
        const target = projectRoute[1];
        await configuration!.read(target);
        // Deleting runs and conversations goes through their own cleanup, so
        // a project is removed only once it holds none.
        if (
          (await chat!.list(target)).length ||
          (await workflow.snapshot(target)).runs.length
        )
          throw new ApiError(
            'CONFLICT',
            'Delete this project’s conversations and runs first.',
            409,
          );
        await configuration!.remove(target);
        cachedRedactions = undefined;
        return send(res, 200, { deleted: true });
      }
      if (path === '/api/v1/session' && req.method === 'GET')
        return send(res, 200, { apiVersion: API_VERSION, csrfToken });
      const targetMutation =
        /^\/api\/v1\/(conversations|runs)\/([A-Za-z0-9_-]+)/.exec(path);
      if (
        req.method !== 'GET' &&
        targetMutation &&
        deleting(
          await configuration!.harness.snapshot(Deletions, context),
          targetMutation[1] === 'conversations' ? targetMutation[2] : undefined,
          targetMutation[1] === 'runs' ? targetMutation[2] : undefined,
        )
      )
        throw new ApiError('CONFLICT', 'This chat is being deleted.', 409);
      if (path === '/api/v1/ag-ui/run' && req.method === 'POST')
        return runAgUi(chat!, await body(req, 2 * 1024 * 1024), res);
      const agUiConversation =
        /^\/api\/v1\/conversations\/(\d+)\/ag-ui\/(events|snapshot|history)$/.exec(
          path,
        );
      if (agUiConversation && req.method === 'GET') {
        const [, id, action] = agUiConversation;
        if (action === 'events') {
          const view = conversationEncoder(id);
          return chat!.stream(id, res, view.encode, view.failed);
        }
        if (action === 'snapshot')
          return send(res, 200, {
            events: agUiSnapshot(await chat!.activitySnapshot(id)),
          });
        const page = await chat!.history(
          id,
          url.searchParams.get('cursor') ?? undefined,
          Number(url.searchParams.get('limit') ?? 50),
        );
        return send(res, 200, {
          events: viewSnapshotEvents(
            historyView(id, page.entries, page.cursor),
          ),
        });
      }
      const agUiActivity =
        /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/activity\/ag-ui(?:\/(events))?$/.exec(
          path,
        );
      if (agUiActivity && req.method === 'GET') {
        const [, id, events] = agUiActivity;
        if (events) return activity!.stream(id, res, activityEncoder(id));
        const snapshot = await activity!.page(
          id,
          url.searchParams.get('cursor') ?? undefined,
          Number(url.searchParams.get('limit') ?? 50),
        );
        return send(res, 200, {
          events: viewSnapshotEvents(activityView(snapshot)),
        });
      }
      if (path === '/api/v1/runs/events' && req.method === 'GET')
        return workflow.stream(
          res,
          lastEventId(req),
          scopedProject && projectId,
        );
      if (path === '/api/v1/runs') {
        if (req.method === 'GET')
          return send(
            res,
            200,
            await workflow.snapshot(scopedProject && projectId),
          );
        if (req.method === 'POST') {
          const input = await body(req);
          return send(
            res,
            202,
            await workflow.admit(
              scopedProject && input && typeof input === 'object'
                ? { ...input, projectId }
                : input,
            ),
          );
        }
      }
      const commandArtifact =
        /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/artifacts\/([A-Za-z0-9_-]+)$/.exec(
          path,
        );
      if (commandArtifact && req.method === 'GET') {
        const record = (await processes.records(commandArtifact[1])).find(
          (r) => r.id === commandArtifact[2],
        );
        if (!record)
          throw new ApiError('NOT_FOUND', 'Command output not found.', 404);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new ApiError('INVALID_INPUT', 'Invalid output offset.', 400);
        const file = await open(record.artifact, 'r');
        try {
          const size = (await file.stat()).size,
            buffer = Buffer.alloc(65540);
          const { bytesRead } = await file.read(
            buffer,
            0,
            buffer.length,
            offset,
          );
          return send(
            res,
            200,
            outputPage(buffer.subarray(0, bytesRead), offset, size),
          );
        } finally {
          await file.close();
        }
      }
      const inspectionRoute =
        /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/inspection$/.exec(path);
      if (inspectionRoute && req.method === 'GET') {
        const run = await workflow.get(inspectionRoute[1]);
        const conversations = [
          ...new Set([
            run.developerConversationId,
            ...run.attempts.map((a) => a.conversationId),
          ]),
        ];
        return send(res, 200, {
          conversations: await Promise.all(
            conversations.map((id) => chat!.inspectConversation(id)),
          ),
          commands: (await processes.records(run.id))
            .filter((r) => r.state !== 'finished')
            .map((r) => ({
              id: r.id,
              command: r.command,
              state: r.state,
              startedAt: r.startedAt,
            })),
        });
      }
      const runRoute =
        /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)(?:\/(commands))?$/.exec(path);
      if (runRoute) {
        if (req.method === 'GET' && !runRoute[2])
          return send(res, 200, await workflow.get(runRoute[1]));
        if (req.method === 'POST' && runRoute[2])
          return send(
            res,
            200,
            await workflow.command(runRoute[1], await body(req)),
          );
      }
      if (path === '/api/v1/issues' && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 100)
          throw new ApiError('INVALID_INPUT', 'Invalid issue page.', 400);
        const repository = (await configuration!.read(projectId)).settings
          .repository.github;
        if (!repository) return send(res, 200, { issues: [], hasNext: false });
        if (!github.openIssues)
          throw new ApiError('NOT_READY', 'Issue listing is unavailable.', 503);
        const result = await github.openIssues(repository, page);
        return send(res, 200, {
          issues: result.issues
            .filter((issue) => !issue.pullRequest && issue.state === 'open')
            .map(({ number, url, title, updatedAt, state }) => ({
              number,
              url,
              title,
              updatedAt,
              state,
            })),
          hasNext: result.hasNext,
        });
      }
      const planIssue = /^\/api\/v1\/issues\/(\d+)\/planning$/.exec(path);
      if (planIssue && req.method === 'POST') {
        const input = await body(req);
        const number = Number(planIssue[1]);
        if (
          !Number.isSafeInteger(number) ||
          number < 1 ||
          !input ||
          typeof input !== 'object' ||
          !('requestId' in input) ||
          typeof input.requestId !== 'string'
        )
          throw new ApiError(
            'INVALID_INPUT',
            'Provide an issue number and request ID.',
            400,
          );
        const repository = (await configuration!.read(projectId)).settings
          .repository.github;
        if (!github.getIssue)
          throw new ApiError(
            'NOT_READY',
            'Issue inspection is unavailable.',
            503,
          );
        const issue = await github.getIssue(repository, number);
        if (issue.pullRequest || issue.state !== 'open')
          throw new ApiError('CONFLICT', 'Choose an open GitHub issue.', 409);
        if (issue.body.length > 64000)
          throw new ApiError(
            'INVALID_INPUT',
            'This issue is too large for a planning conversation. Shorten its body on GitHub first.',
            400,
          );
        return send(
          res,
          201,
          await chat!.create(
            {
              title: `Edit #${issue.number} · ${issue.title}`.slice(0, 120),
              requestId: input.requestId,
            },
            'planning',
            projectId,
            issue,
          ),
        );
      }
      if (path === '/api/v1/github/validate' && req.method === 'POST') {
        await body(req);
        return send(
          res,
          200,
          await github.validate(
            (await configuration!.read(projectId)).settings.repository.github,
          ),
        );
      }
      const issueRetry = /^\/api\/v1\/conversations\/(\d+)\/issue\/retry$/.exec(
        path,
      );
      if (issueRetry && req.method === 'POST') {
        await body(req);
        await chat!.summary(issueRetry[1]);
        return send(res, 200, await planning.retry(issueRetry[1]));
      }
      if (path === '/api/v1/conversations') {
        if (req.method === 'GET')
          return send(res, 200, {
            conversations: await chat!.list(scopedProject),
          });
        if (req.method === 'POST')
          return send(
            res,
            201,
            await chat!.create(await body(req), 'planning', projectId),
          );
      }
      const chatRoute =
        /^\/api\/v1\/conversations\/([A-Za-z0-9_-]+)\/(submissions|interrupt|artifacts)(?:\/([A-Za-z0-9_-]+)(?:\/(withdraw))?)?$/.exec(
          path,
        );
      if (chatRoute) {
        const [, id, action, item, operation] = chatRoute;
        const query = new URL(req.url!, 'http://localhost').searchParams;
        if (action === 'submissions' && !item && req.method === 'GET')
          return send(
            res,
            200,
            await chat!.lookup(id, query.get('requestId') ?? ''),
          );
        if (action === 'submissions' && !item && req.method === 'POST')
          return send(res, 202, await chat!.submit(id, await body(req)));
        if (
          action === 'submissions' &&
          item &&
          operation === 'withdraw' &&
          req.method === 'POST'
        ) {
          await body(req);
          return send(res, 200, await chat!.withdraw(id, item));
        }
        if (action === 'interrupt' && req.method === 'POST') {
          await body(req);
          return send(res, 202, await chat!.interrupt(id));
        }
        if (action === 'artifacts' && item && req.method === 'GET')
          return send(
            res,
            200,
            await chat!.artifact(id, item, Number(query.get('offset') ?? 0)),
          );
      }
      if (path === '/api/v1/settings' && req.method === 'GET')
        return send(res, 200, await snapshot(projectId));
      if (path === '/api/v1/providers' && req.method === 'GET')
        return send(res, 200, {
          providers: await providerStatuses(credentials),
        });
      if (path === '/api/v1/settings' && req.method === 'PUT') {
        const update = parseUpdate(await body(req));
        const settings = await validateSettings(
          update.settings,
          ownership!.dataDir,
          credentials,
        );
        for (const other of await configuration!.projects()) {
          if (
            other.id !== projectId &&
            settings.repository.github &&
            other.repository.github.toLowerCase() ===
              settings.repository.github.toLowerCase() &&
            other.repository.path === settings.repository.path
          )
            throw new ApiError(
              'CONFLICT',
              `The project “${projectLabel(other)}” already uses this repository.`,
              409,
            );
        }
        await configuration!.save(update.expectedRevision, settings, projectId);
        cachedRedactions = undefined;
        return send(res, 200, await snapshot(projectId));
      }
      if (
        path === '/api/v1/credentials/retry-storage' &&
        req.method === 'POST'
      ) {
        await body(req);
        return send(res, 200, { storage: (await credentials.retry()).storage });
      }
      const authMatch =
        /^\/api\/v1\/auth\/(openai|anthropic)\/login(?:\/([A-Za-z0-9-]+)(\/answer)?)?$/.exec(
          path,
        );
      if (authMatch) {
        const provider = authMatch[1] as 'openai' | 'anthropic';
        const id = authMatch[2];
        if (!id && req.method === 'GET')
          return send(res, 200, { session: oauth!.status(provider) });
        if (!id && req.method === 'POST') {
          await body(req);
          try {
            return send(res, 202, { session: await oauth!.start(provider) });
          } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(
              'PROVIDER_UNAVAILABLE',
              safeAuthFailure(error).message,
              503,
            );
          }
        }
        if (id && authMatch[3] && req.method === 'POST')
          return send(res, 200, {
            session: oauth!.answer(provider, id, await body(req, 20000)),
          });
        if (id && !authMatch[3] && req.method === 'DELETE') {
          await body(req);
          return send(res, 200, { session: await oauth!.cancel(provider, id) });
        }
      }
      const match =
        /^\/api\/v1\/credentials\/(requesty|github|openai|anthropic)$/.exec(
          path,
        );
      if (match && (req.method === 'PUT' || req.method === 'DELETE')) {
        const id = match[1] as CredentialId;
        const value = await body(req);
        if (req.method === 'DELETE') {
          await oauth!.disconnect(id);
          return send(res, 200, { configured: false });
        }
        if (id !== 'requesty' && id !== 'github')
          throw new ApiError(
            'INVALID_INPUT',
            'Use Connect in Settings for subscription accounts.',
            400,
          );
        if (
          !value ||
          typeof value !== 'object' ||
          Object.keys(value).length !== 1 ||
          !('value' in value) ||
          typeof value.value !== 'string' ||
          !value.value.trim() ||
          value.value.length > 8192 ||
          /[\s\0]/.test(value.value)
        )
          throw new ApiError(
            'INVALID_INPUT',
            'Enter a non-empty token without whitespace.',
            400,
          );
        await credentials.replace(id, {
          type: 'api_key',
          key: value.value as string,
        });
        return send(res, 200, { configured: true });
      }
      throw new ApiError('NOT_FOUND', 'API route not found.', 404);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      throw new ApiError('NOT_FOUND', 'Route not found.', 404);
    const webDir = options.webDir ?? resolve(sourceRoot, 'apps/web/dist');
    const requested = resolve(webDir, `.${decodeURIComponent(path)}`);
    if (!inside(requested, webDir))
      throw new ApiError('NOT_FOUND', 'File not found.', 404);
    const mime: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    let filename = requested;
    let content: Buffer;
    try {
      if (!inside(await realpath(filename), await realpath(webDir)))
        throw new Error();
      content = await readFile(filename);
    } catch {
      if (extname(path))
        throw new ApiError('NOT_FOUND', 'File not found.', 404);
      filename = resolve(webDir, 'index.html');
      try {
        content = await readFile(filename);
      } catch {
        throw new ApiError(
          'NOT_FOUND',
          'Build the frontend or use the Vite development server.',
          404,
        );
      }
    }
    res.writeHead(200, {
      'Content-Type': mime[extname(filename)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  }
  const server = createServer((req, res) => {
    const work = handle(req, res).catch((error) => {
      const safe =
        error instanceof ApiError
          ? error
          : error instanceof GitHubFailure
            ? new ApiError(
                error.code,
                error.message,
                error.code === 'AUTHENTICATION'
                  ? 401
                  : error.code === 'FORBIDDEN'
                    ? 403
                    : 503,
              )
            : error instanceof CredentialStorageError
              ? new ApiError('PROVIDER_UNAVAILABLE', error.message, 503)
              : new ApiError(
                  'INTERNAL',
                  'The service could not complete this operation. Check runtime storage permissions and try again.',
                  500,
                );
      log('request_failed', { code: safe.code });
      if (!res.headersSent)
        send(res, safe.status, {
          error: { code: safe.code, message: safe.message },
        });
      else res.end();
    });
    activeMutations.add(work);
    void work.finally(() => activeMutations.delete(work));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  // Streams hold a socket each, so a socket cap also bounds open streams.
  if (tokenDigest) server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
  async function initializeRuntime() {
    let openedConfiguration: typeof configuration;
    let openedWorkflow: WorkflowService | undefined;
    let openedChat: ChatService | undefined;
    try {
      const factoryModels = createFactoryModels(credentials);
      const models = options.chat?.models ?? factoryModels;
      planning = new PlanningService(
        () => configuration!.harness,
        github,
        (id, query) => chat!.searchHistory(id, query),
      );
      const registry = createRegistry();
      const workflowTasks = workflowExtension(() => workflow);
      registry.install(workflowTasks.extension);
      registry.install(
        recordingTools(ownership!.dataDir, [
          ...planning.tools(),
          ...(options.chat?.tools ?? []),
        ]),
      );
      openedConfiguration = await openConfiguration(ownership!.dataDir, {
        models,
        registry,
        settings: { retry: { maxRetries: 0 } },
      });
      configuration = openedConfiguration;
      const requestyIds = new Set<string>();
      const registerRequesty = (id: string) => {
        if (options.chat || requestyIds.has(id)) return;
        requestyIds.add(id);
        factoryModels.setProvider(
          createFactoryModels(credentials, [...requestyIds]).getProvider(
            'requesty',
          )!,
        );
      };
      processes = new ProcessSupervisor(
        configuration.harness,
        ownership!.dataDir,
      );
      workspaces = new Workspaces(
        ownership!.dataDir,
        processes,
        credentials,
        options.workflowRemote,
      );
      const real = new RealWorkflow({
        harness: () => configuration!.harness,
        workflow: () => workflow,
        dataDir: ownership!.dataDir,
        github,
        processes,
        workspaces,
        settings: async (id) => (await configuration!.read(id)).settings,
        credentialStatus: async () => (await credentials.inspect()).configured,
        registerRequesty,
        history: (id, query) => chat!.searchHistory(id, query),
      });
      registry.install({
        ...real.extension,
        tools: recordingTools(ownership!.dataDir, real.tools).tools,
      });
      const selectedAdapter =
        options.workflow?.adapter ??
        (mode === 'simulation'
          ? simulationAdapter(options.workflow?.clock)
          : mode === 'real'
            ? real.adapter()
            : undefined);
      const workflowAdapter =
        selectedAdapter?.mode === 'simulation' &&
        !selectedAdapter.issue &&
        github.getIssue
          ? {
              ...selectedAdapter,
              issue: async (
                repository: string,
                number: number,
                signal?: AbortSignal,
              ) => {
                const issue = await github.getIssue!(
                  repository,
                  number,
                  signal,
                );
                if (issue.pullRequest || issue.state !== 'open')
                  throw new ApiError(
                    'CONFLICT',
                    'Choose an open GitHub issue.',
                    409,
                  );
                return issue;
              },
            }
          : selectedAdapter;
      workflow = new WorkflowService(
        configuration.harness,
        workflowTasks.task,
        workflowAdapter,
        options.workflow?.clock,
      );
      openedWorkflow = workflow;
      planning.startRun = (input, signal) => workflow.admit(input, signal);
      chat = new ChatService(
        configuration.harness,
        ownership!.dataDir,
        (id) => configuration!.read(id),
        {
          ...options.chat,
          models,
          registerRequesty,
          titleSelection: async () =>
            (await configuration!.titleGenerator()).selection,
          planning,
          workflowView: async (id) => {
            const run = await workflow.get(id);
            return {
              runId: run.id,
              status: run.status,
              stage: run.stage,
              acceptsInput:
                !run.publicationLocked &&
                !['publishing'].includes(run.stage) &&
                ![
                  'pr_ready',
                  'cancelled',
                  'cancelling',
                  'termination_blocker',
                ].includes(run.status),
            };
          },
          workflowWithdraw: () => workflow.refreshInputs(),
          workflowInput: (id, input) => workflow.input(id, input),
          workflowInterrupt: (id) => workflow.interruptConversation(id),
        },
      );
      openedChat = chat;
      activity = new RunActivityService(workflow, chat, processes);
      await validateRepositoryFromStorage();
      await configuration.harness.inspect(
        (await import('./storage.js')).context,
      );
      const savedConversations = await configuration.harness.snapshot(
        Catalog,
        context,
      );
      for (const conversation of Object.values(savedConversations?.items ?? {}))
        if (conversation.model.provider === 'requesty')
          registerRequesty(conversation.model.model);
      await stopPendingDeletions();
      await workflow.recover();
      await chat.recover();
      await workflow.activate();
      runtimeOpen = true;
      startupError = undefined;
      ready = !maintenance && !stopping;
    } catch (error) {
      ready = false;
      runtimeOpen = false;
      try {
        await openedWorkflow?.close();
        await openedChat?.close();
        await openedConfiguration?.close();
        if (configuration === openedConfiguration) configuration = undefined;
      } catch {
        // Never open another harness over an instance whose close is uncertain.
        reopeningUnsafe = true;
      }
      throw error;
    }
  }
  async function reopenRuntime() {
    if (stopping || reopeningUnsafe) return;
    reopeningAttempts++;
    try {
      await initializeRuntime();
      reopeningNeeded = false;
      reopeningAttempts = 0;
      clearTimeout(reopeningTimer);
    } catch {
      reopeningNeeded = true;
      const retrying =
        !reopeningUnsafe && reopeningAttempts < maxReopeningAttempts;
      startupError = new ApiError(
        'NOT_READY',
        retrying
          ? 'Local storage could not reopen after cleanup. Restore data-directory access; automatic recovery is retrying.'
          : 'Local storage could not reopen after cleanup. Restore data-directory access and restart the service; automatic recovery attempts have stopped.',
        503,
      );
      log('runtime_reopen_failed');
      if (retrying)
        reopeningTimer = setTimeout(
          () => void pollCompletedRuns(),
          1000 * 2 ** (reopeningAttempts - 1),
        );
    }
  }
  try {
    ownership = await acquireOwnership(options.dataDir ?? defaultDataDir());
    credentials = new PrivateCredentials(
      ownership!.dataDir,
      options.credentialVault,
    );
    await credentials.init();
    oauth = new OAuthSessions(
      credentials,
      ownership!.dataDir,
      options.oauthLogin,
    );
    github = options.github ?? createGitHub(credentials);
    await initializeRuntime();
    const pollProjectLabels = async (projectId: string) => {
      const capability = await workflow.snapshot(projectId);
      if (!capability.enabled) return;
      const saved = await configuration!.read(projectId);
      const repository = {
        ...saved.settings.repository,
        path: await realpath(saved.settings.repository.path),
      };
      for (let page = 1; page <= 100; page++) {
        const batch = await github.readyIssues!(
          saved.settings.repository.github,
          page,
          labelAbort.signal,
        );
        for (const issue of batch.issues) {
          if (stopping) return;
          const deletions = await configuration!.harness.snapshot(
            Deletions,
            context,
          );
          if (
            deletions?.suppressedIssues?.[
              issueDeletionKey(repository, issue.number)
            ]
          )
            continue;
          await workflow.admit(
            {
              issueNumber: issue.number,
              projectId,
              operationId: `label-${projectId}-${saved.revision}-${issue.number}-${issue.updatedAt.replace(/[^A-Za-z0-9_-]/g, '')}`,
            },
            labelAbort.signal,
            saved.revision,
            'label',
          );
        }
        if (!batch.hasNext) return;
      }
      throw new Error('Label inspection limit exceeded.');
    };
    const pollLabels = () => {
      if (
        labelPolling ||
        !ready ||
        !runtimeOpen ||
        maintenance ||
        stopping ||
        Date.now() < nextLabelPoll ||
        mode !== 'real' ||
        options.workflow ||
        !github.readyIssues
      )
        return;
      labelPolling = (async () => {
        // One project failing (a revoked repository, say) must not starve the
        // others, so errors are collected and the first is raised at the end.
        let failure: unknown;
        for (const { id } of await configuration!.projects()) {
          try {
            await pollProjectLabels(id);
          } catch (error) {
            if (stopping) return;
            failure ??= error;
          }
        }
        if (failure) throw failure;
      })()
        .catch((error) => {
          nextLabelPoll =
            Date.now() +
            (error instanceof GitHubFailure
              ? Math.max(30000, error.retryAfterMs)
              : 30000);
          log('label_poll_failed');
        })
        .finally(() => {
          labelPolling = undefined;
        });
    };
    pollLabels();
    labelTimer = setInterval(pollLabels, 30000);
    deletionTimer = setInterval(() => void pollDeletions(), 1000);
    void pollDeletions();
    void pollCompletedRuns();
    cleanupTimer = setInterval(() => void pollCompletedRuns(), 30000);
    log('service_ready', { port });
  } catch (error) {
    startupError =
      error instanceof ApiError
        ? error
        : new ApiError(
            'NOT_READY',
            'Storage startup failed. Check data directory permissions and the application version.',
            503,
          );
    log('startup_blocked', { code: startupError.code });
    if (configuration) {
      await configuration.close();
      configuration = undefined;
    }
    if (ownership) {
      await ownership.release();
      ownership = undefined;
    }
  }
  async function requestDeletion(
    isRun: boolean,
    id: string,
  ): Promise<DeletionOperation> {
    return configuration!.harness.commit(async (tx) => {
      const operations = await tx.doc(Deletions);
      const existing = Object.values(operations.items).find((operation) =>
        isRun ? operation.runId === id : operation.conversationIds.includes(id),
      );
      if (existing) {
        if (existing.state === 'blocked') {
          existing.state = 'pending';
          existing.message = 'Deletion requested.';
        }
        return JSON.parse(JSON.stringify(existing)) as DeletionOperation;
      }
      const catalog = await tx.doc(Catalog);
      const summary = isRun ? undefined : catalog.items[id];
      if (!isRun && !summary)
        throw new ApiError('NOT_FOUND', 'Conversation not found.', 404);
      const runId = isRun ? id : summary?.runId;
      const state = await tx.doc((await import('./workflow.js')).Workflow);
      const run = runId ? state.runs[runId] : undefined;
      if (runId && !run) throw new ApiError('NOT_FOUND', 'Run not found.', 404);
      const conversationIds = run
        ? [
            ...new Set([
              run.developerConversationId,
              ...run.attempts.map((attempt) => attempt.conversationId),
              ...Object.values(catalog.items)
                .filter((item) => item.runId === runId)
                .map((item) => item.id),
            ]),
          ].filter(Boolean)
        : [id];
      const operation: DeletionOperation = {
        id: runId ? `run-${runId}` : `conversation-${id}`,
        conversationIds,
        ...(runId ? { runId } : {}),
        state: 'pending',
        message: 'Deletion requested.',
      };
      if (run) {
        operations.suppressedIssues ??= {};
        operations.suppressedIssues[
          issueDeletionKey(run.repository, run.issue.number)
        ] = true;
      }
      operations.items[operation.id] = operation;
      return operation;
    }, context);
  }
  async function deletionState(
    id: string,
    state: DeletionOperation['state'],
    message: string,
  ) {
    await configuration!.harness.commit(async (tx) => {
      const operation = (await tx.doc(Deletions)).items[id];
      operation.state = state;
      operation.message = message;
    }, context);
  }
  async function stopPendingDeletions() {
    const operations = Object.values(
      (await configuration!.harness.snapshot(Deletions, context))?.items ?? {},
    );
    for (const operation of operations) {
      if (['completed', 'blocked', 'waiting'].includes(operation.state))
        continue;
      try {
        await deletionState(operation.id, 'stopping', 'Stopping…');
        if (operation.runId) {
          await workflow.stopForDeletion(operation.runId);
          if (!(await processes.quiescent(operation.runId)))
            throw new Error('Termination could not be confirmed.');
        } else {
          for (const id of operation.conversationIds)
            await chat!.stopForDeletion(id);
        }
        await deletionState(
          operation.id,
          'waiting',
          'Waiting for other work to finish…',
        );
      } catch {
        await deletionState(
          operation.id,
          'blocked',
          'Agent or command termination could not be confirmed. Resolve the termination blocker and retry deletion.',
        );
      }
    }
  }
  /** Reopen every service if preparation fails after shutdown has begun. */
  async function withClosedRuntime<T>(
    prepare: () => Promise<T>,
    work: (snapshot: T) => Promise<void>,
  ) {
    let snapshot: T;
    try {
      await workflow.close();
      await activity?.close();
      await chat!.close();
      snapshot = await prepare();
    } catch (error) {
      // A live harness does not imply that its service objects still accept work.
      // Finish closing it before opening replacements; never allow two writers.
      runtimeOpen = false;
      await workflow.close();
      await activity?.close();
      await chat!.close();
      await configuration!.close();
      configuration = undefined;
      await reopenRuntime();
      throw error;
    }
    runtimeOpen = false;
    await configuration!.close();
    configuration = undefined;
    try {
      await work(snapshot);
    } finally {
      await reopenRuntime();
    }
  }
  function pollDeletions(): Promise<void> {
    if (deletionPolling) return deletionPolling;
    if (stopping || !ready || maintenance || cleanupPolling)
      return Promise.resolve();
    deletionPolling = (async () => {
      await stopPendingDeletions();
      const operations = Object.values(
        (await configuration!.harness.snapshot(Deletions, context))?.items ??
          {},
      );
      for (const operation of operations) {
        if (stopping || operation.state !== 'waiting') continue;
        const idle = async () => {
          const inspection = await configuration!.harness.inspect(context);
          const state = await workflow.snapshot();
          return (
            !inspection.tasks.length &&
            !inspection.submissions.length &&
            !state.slots.length &&
            !state.runs.some((run) =>
              [
                'running',
                'queued',
                'pausing',
                'cancelling',
                'termination_blocker',
              ].includes(run.status),
            )
          );
        };
        if (!(await idle())) continue;
        maintenance = true;
        ready = false;
        try {
          await labelPolling;
          await Promise.allSettled([...activeMutations]);
          if (stopping || !(await idle())) continue;
          if (operation.runId && !(await processes.quiescent(operation.runId)))
            throw new Error('Run processes are not confirmed stopped.');
          await deletionState(operation.id, 'deleting', 'Deleting…');
          const run = operation.runId
            ? await workflow.get(operation.runId)
            : undefined;
          // Remove only links to this implementation, preserving its planning transcript.
          if (run?.planningConversationId) {
            await configuration!.harness.commit(async (tx) => {
              const planning = (
                await tx.doc(
                  Planning,
                  Number(run.planningConversationId) as ConversationId,
                )
              ).value;
              if (planning?.runId === run.id) delete planning.runId;
            }, context);
          }
          await withClosedRuntime(
            () =>
              cleanupSnapshot(configuration!.harness, run, {
                preservePlanning: true,
                ...(!run
                  ? { conversationId: operation.conversationIds[0] }
                  : {}),
              }),
            async (snapshot) => {
              snapshot.conversations = purgeRunStorage(
                ownership!.dataDir,
                snapshot,
                true,
              );
              for (const id of snapshot.conversations)
                delete snapshot.documents['factory.conversations'].items[id];
              if (run)
                await cleanupWorkspace(
                  ownership!.dataDir,
                  run,
                  workspaces,
                  true,
                );
              await cleanupArtifacts(ownership!.dataDir, snapshot);
              snapshot.documents['factory.deletions'].items[operation.id] = {
                ...operation,
                conversationIds: snapshot.conversations,
                state: 'completed',
                message: 'Deleted.',
              };
              purgeRunStorage(ownership!.dataDir, snapshot);
            },
          );
        } catch (error) {
          if (!runtimeOpen && !reopeningNeeded) {
            reopeningNeeded = true;
            reopeningUnsafe = true;
            startupError = new ApiError(
              'NOT_READY',
              'Storage could not close safely for deletion. Restart the service after checking data-directory access.',
              503,
            );
          }
          if (runtimeOpen) {
            const reason =
              error instanceof Error &&
              /^(?:Worktree ownership is uncertain\.|Proof workspace ownership is uncertain\.|Worktree registration remains but its directory is missing\.|Run processes are not confirmed stopped\.|Run base reference changed\.|Local branch is in use\.|Artifact ownership is uncertain\.|Command artifact ownership is uncertain\.)$/.test(
                error.message,
              )
                ? error.message
                : 'Deletion could not finish. Check local repository access and storage compatibility, then retry.';
            await deletionState(operation.id, 'blocked', reason);
          }
          log('deletion_blocked');
        } finally {
          maintenance = false;
          if (!stopping) ready = runtimeOpen;
        }
        if (!runtimeOpen) return;
      }
    })()
      .catch(() => {
        log('deletion_failed');
      })
      .finally(() => {
        deletionPolling = undefined;
      });
    return deletionPolling;
  }
  function pollCompletedRuns(): Promise<void> {
    if (deletionPolling) return Promise.resolve();
    if (cleanupPolling) return cleanupPolling;
    if (
      stopping ||
      (!ready && !reopeningNeeded) ||
      (reopeningNeeded &&
        (reopeningUnsafe || reopeningAttempts >= maxReopeningAttempts)) ||
      (!reopeningNeeded && Date.now() < nextCleanupPoll) ||
      (!reopeningNeeded &&
        (mode !== 'real' || !github.getPull || !github.getIssue))
    )
      return Promise.resolve();
    cleanupPolling = (async () => {
      if (reopeningNeeded) {
        maintenance = true;
        try {
          await reopenRuntime();
        } finally {
          maintenance = false;
          ready = runtimeOpen && !stopping;
        }
        if (!runtimeOpen || stopping) return;
      }
      if (mode !== 'real' || !github.getPull || !github.getIssue) return;
      for (const run of (await workflow.snapshot()).runs) {
        if (
          stopping ||
          deleting(
            await configuration!.harness.snapshot(Deletions, context),
            run.planningConversationId,
            run.id,
          ) ||
          run.mode !== 'real' ||
          run.status !== 'pr_ready' ||
          !run.publication?.prNumber
        )
          continue;
        const pull = await github.getPull!(
          run.repository.github,
          run.publication.prNumber,
          labelAbort.signal,
        );
        if (
          pull.number !== run.publication.prNumber ||
          pull.state !== 'closed' ||
          pull.merged !== true ||
          pull.head !== run.publication.commit ||
          pull.headRepository !== run.repository.github ||
          pull.headBranch !== run.workspace?.branch ||
          pull.baseRepository !== run.repository.github ||
          pull.baseBranch !== run.repository.baseBranch
        )
          continue;
        const issue = await github.getIssue!(
          run.repository.github,
          run.issue.number,
          labelAbort.signal,
        );
        if (
          issue.state !== 'closed' ||
          issue.number !== run.issue.number ||
          issue.pullRequest
        )
          continue;
        if (stopping) return;
        await workflow.cleanupState(run.id, {
          state: 'pending',
          message: 'PR merged and issue closed. Waiting for idle maintenance.',
        });
        // Admission is gated before draining accepted mutations; no unrelated work
        // is interrupted just to reclaim completed runs.
        maintenance = true;
        ready = false;
        try {
          await labelPolling;
          await Promise.allSettled([...activeMutations]);
          const inspection = await configuration!.harness.inspect(context);
          const state = await workflow.snapshot();
          if (
            stopping ||
            inspection.tasks.length ||
            inspection.submissions.length ||
            state.slots.length ||
            state.runs.some((r) =>
              [
                'running',
                'queued',
                'pausing',
                'cancelling',
                'termination_blocker',
              ].includes(r.status),
            )
          )
            continue;
          if (
            deleting(
              await configuration!.harness.snapshot(Deletions, context),
              run.planningConversationId,
              run.id,
            )
          )
            continue;
          if (!(await processes.quiescent(run.id)))
            throw new Error('Run processes are not confirmed stopped.');
          await withClosedRuntime(
            async () =>
              cleanupSnapshot(
                configuration!.harness,
                await workflow.get(run.id),
              ),
            async (snapshot) => {
              snapshot.conversations = purgeRunStorage(
                ownership!.dataDir,
                snapshot,
                true,
              );
              for (const id of snapshot.conversations)
                delete snapshot.documents['factory.conversations'].items[id];
              await cleanupWorkspace(ownership!.dataDir, run, workspaces);
              await cleanupArtifacts(ownership!.dataDir, snapshot);
              purgeRunStorage(ownership!.dataDir, snapshot);
            },
          );
        } catch (error) {
          if (!runtimeOpen && !reopeningNeeded) {
            reopeningNeeded = true;
            reopeningUnsafe = true;
            startupError = new ApiError(
              'NOT_READY',
              'Storage could not close safely for cleanup. Restart the service after checking data-directory access.',
              503,
            );
          }
          // Fixed messages only; Git/provider errors may contain private payloads.
          const message =
            error instanceof Error &&
            [
              'Worktree ownership is uncertain.',
              'Worktree contains unexpected changes.',
              'Ignored files changed after publication.',
              'Ignored files have no saved cleanup baseline. Preserve or remove them before cleanup.',
              'Local branch changed after publication.',
              'Local branch is in use.',
              'Run base reference changed.',
              'Run processes are not confirmed stopped.',
              'Worktree registration remains but its directory is missing.',
              'Artifact ownership is uncertain.',
              'Command artifact ownership is uncertain.',
            ].includes(error.message)
              ? error.message
              : 'Cleanup could not finish. Check local repository access and storage compatibility; it will retry.';
          if (
            runtimeOpen &&
            (await workflow.snapshot()).runs.some((r) => r.id === run.id)
          )
            await workflow.cleanupState(run.id, { state: 'blocked', message });
          log('cleanup_blocked');
        } finally {
          maintenance = false;
          if (!stopping) ready = runtimeOpen;
        }
        if (!runtimeOpen) return;
      }
    })()
      .catch((error) => {
        nextCleanupPoll =
          Date.now() +
          (error instanceof GitHubFailure
            ? Math.max(30000, error.retryAfterMs)
            : 30000);
        log('cleanup_poll_failed');
      })
      .finally(() => {
        cleanupPolling = undefined;
      });
    return cleanupPolling;
  }
  async function validateRepositoryFromStorage() {
    const { validateRepositoryLocation } = await import('./runtime.js');
    for (const project of await configuration!.projects())
      await validateRepositoryLocation(
        project.repository.path,
        ownership!.dataDir,
      );
  }
  return {
    server,
    get chat() {
      return chat;
    },
    get planning() {
      return planning!;
    },
    get workflow() {
      return workflow!;
    },
    pollCompletedRuns,
    pollDeletions,
    port,
    url: `http://${wildcardHosts.has(host) ? '127.0.0.1' : hostLabel(host)}:${port}`,
    async close() {
      if (stopping) return;
      stopping = true;
      ready = false;
      log('service_stopping');
      clearInterval(labelTimer);
      clearInterval(cleanupTimer);
      clearInterval(deletionTimer);
      clearTimeout(reopeningTimer);
      labelAbort.abort();
      await oauth?.close();
      await cleanupPolling;
      await deletionPolling;
      if (runtimeOpen) await workflow?.close();
      await labelPolling;
      await activity?.close();
      await chat?.close();
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeIdleConnections();
      await Promise.allSettled([...activeMutations]);
      // Browsers can leave speculative TCP connections without a complete HTTP
      // request. Once actions and observers have drained, these must not keep
      // shutdown waiting for the browser to return from offline mode.
      server.closeAllConnections();
      await closed;
      // A failed close deliberately retains ownership: never permit a second writer.
      if (configuration) await configuration.close();
      await credentials?.drain();
      if (ownership) await ownership.release();
    },
  };
}
