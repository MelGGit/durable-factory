import type { GitHubValidation } from './planning.js';
export const API_VERSION = 'v1' as const;
export const ROLES = ['planning', 'development', 'review'] as const;
export type Role = (typeof ROLES)[number];
export const PROVIDERS = ['requesty', 'openai', 'anthropic'] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type CredentialId = ProviderId | 'github';
export type OAuthProvider = 'openai' | 'anthropic';
export interface CredentialStorageStatus {
  backend: string;
  status: 'ready' | 'error';
}
export interface OAuthPrompt {
  id: string;
  type: 'select' | 'manual_code' | 'text' | 'secret';
  message: string;
  options?: { id: string; label: string }[];
}
export interface OAuthSession {
  id: string;
  provider: OAuthProvider;
  state: 'pending' | 'completed' | 'cancelled' | 'expired' | 'failed';
  expiresAt: number;
  prompt?: OAuthPrompt;
  authUrl?: string;
  deviceCode?: { userCode: string; verificationUri: string };
  error?: { category: string; message: string };
}
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | 'BUSY'
  | 'AUTHENTICATION'
  | 'PROVIDER_UNAVAILABLE'
  | 'NOT_READY'
  | 'FORBIDDEN'
  | 'UNSUPPORTED_VERSION'
  | 'INTERNAL'
  | 'NOT_FOUND';
export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}
export interface RoleSettings {
  provider: ProviderId | null;
  model: string;
  reasoning: string | null;
}
export interface TitleGeneratorSettings {
  revision: number;
  selection: RoleSettings | null;
}
export interface Settings {
  schemaVersion: 1;
  repository: { path: string; github: string; baseBranch: string };
  commitIdentity: { name: string; email: string };
  setupCommands: string[];
  requiredChecks: string[];
  timeouts: {
    setup: number;
    tool: number;
    check: number;
    provider: number;
    cancellation: number;
  };
  roles: Record<Role, RoleSettings>;
}
export interface ProviderStatus {
  id: ProviderId;
  configured: boolean;
  status: 'not_configured' | 'configured' | 'error';
  models: { id: string; name: string; reasoning: string[] }[];
  message?: string;
}
/** Records written before projects existed belong to this project. */
export const DEFAULT_PROJECT_ID = 'default';
export interface ProjectSummary {
  id: string;
  name: string;
  repository: Settings['repository'];
  /** What the workflow still needs before this project can start a run. */
  missingPrerequisites?: string[];
}
/** What to call a project: the name given to it, else its folder's name. */
export function projectLabel(project: {
  name: string;
  repository: Pick<Settings['repository'], 'path'>;
}) {
  const given = project.name.trim();
  if (given && given !== 'Default project') return given;
  const folder = project.repository.path.split(/[\\/]/).filter(Boolean).pop();
  return folder || 'Untitled project';
}
export interface ProjectsResponse {
  apiVersion: typeof API_VERSION;
  projects: ProjectSummary[];
}
export interface SettingsResponse {
  apiVersion: typeof API_VERSION;
  projectId: string;
  name: string;
  revision: number;
  settings: Settings;
  credentials: Record<CredentialId, boolean>;
  credentialErrors: Partial<Record<CredentialId, string>>;
  credentialStorage: CredentialStorageStatus;
  providers: ProviderStatus[];
}
export interface SessionResponse {
  apiVersion: typeof API_VERSION;
  csrfToken: string;
}
export interface UpdateSettingsRequest {
  expectedRevision: number;
  settings: Settings;
}
export const defaultSettings = (): Settings => ({
  schemaVersion: 1,
  repository: { path: '', github: '', baseBranch: 'main' },
  commitIdentity: { name: '', email: '' },
  setupCommands: [],
  requiredChecks: [],
  timeouts: {
    setup: 600,
    tool: 120,
    check: 600,
    provider: 180,
    cancellation: 15,
  },
  roles: Object.fromEntries(
    ROLES.map((role) => [role, { provider: null, model: '', reasoning: null }]),
  ) as Settings['roles'],
});
export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
/** Builds the error for a failed response. A proxy in front of the service
 * may answer with plain text or HTML rather than the service's JSON. */
export async function responseError(response: Response, fallback: string) {
  const body = await response.json().catch(() => undefined);
  return new ApiError(
    body?.error?.code ??
      (response.status === 401 ? 'AUTHENTICATION' : 'INTERNAL'),
    body?.error?.message ?? fallback,
    response.status,
  );
}
/** Sends a bearer token with every request, for a service that requires one.
 * Pass the result as the client's `fetcher`. */
export const withToken =
  (token: string, fetcher: typeof fetch = fetch): typeof fetch =>
  (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetcher(input, { ...init, headers });
  };
/** Paths that belong to one project. Others address a record by its own ID. */
const projectPaths = new Set([
  '/settings',
  '/conversations',
  '/runs',
  '/runs/events',
  '/github/validate',
]);
export class FactoryClient {
  private csrfToken?: string;
  constructor(
    protected baseUrl = '',
    protected fetcher: typeof fetch = fetch,
    /** Without a project, the service answers for the default project. */
    public projectId?: string,
  ) {}
  protected scoped(path: string) {
    const bare = path.split('?')[0];
    return this.projectId && projectPaths.has(bare)
      ? `/projects/${encodeURIComponent(this.projectId)}${path}`
      : path;
  }
  protected async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher.call(
      globalThis,
      `${this.baseUrl}/api/v1${this.scoped(path)}`,
      init,
    );
    if (!response.ok)
      throw await responseError(
        response,
        'The service could not complete the request.',
      );
    return (await response.json().catch(() => {
      throw new ApiError(
        'INTERNAL',
        'The service returned an unreadable response.',
        response.status,
      );
    })) as T;
  }
  /** The session's CSRF token, fetched on first use. */
  protected async csrf() {
    if (!this.csrfToken) await this.connect();
    return this.csrfToken!;
  }
  async connect() {
    const session = await this.request<SessionResponse>('/session');
    if (session.apiVersion !== API_VERSION)
      throw new ApiError(
        'UNSUPPORTED_VERSION',
        'The app and service versions do not match. Reload the app.',
        409,
      );
    this.csrfToken = session.csrfToken;
  }
  settings() {
    return this.request<SettingsResponse>('/settings');
  }
  validateGitHub() {
    return this.mutation<GitHubValidation>('/github/validate', 'POST', {});
  }
  providers() {
    return this.request<{ providers: ProviderStatus[] }>('/providers');
  }
  startLogin(provider: OAuthProvider) {
    return this.mutation<{ session: OAuthSession }>(
      `/auth/${provider}/login`,
      'POST',
      {},
    );
  }
  loginStatus(provider: OAuthProvider) {
    return this.request<{ session: OAuthSession | null }>(
      `/auth/${provider}/login`,
    );
  }
  answerLogin(
    provider: OAuthProvider,
    id: string,
    promptId: string,
    answer: string,
  ) {
    return this.mutation<{ session: OAuthSession }>(
      `/auth/${provider}/login/${encodeURIComponent(id)}/answer`,
      'POST',
      { promptId, answer },
    );
  }
  cancelLogin(provider: OAuthProvider, id: string) {
    return this.mutation<{ session: OAuthSession }>(
      `/auth/${provider}/login/${encodeURIComponent(id)}`,
      'DELETE',
      {},
    );
  }
  retryCredentialStorage() {
    return this.mutation<{ storage: CredentialStorageStatus }>(
      '/credentials/retry-storage',
      'POST',
      {},
    );
  }
  runners() {
    return this.request<{ runners: number }>('/runners');
  }
  titleGenerator() {
    return this.request<TitleGeneratorSettings>('/title-generator');
  }
  saveTitleGenerator(value: TitleGeneratorSettings) {
    return this.mutation<TitleGeneratorSettings>(
      '/title-generator',
      'PUT',
      value,
    );
  }
  saveRunners(runners: number) {
    return this.mutation<{ runners: number }>('/runners', 'PUT', { runners });
  }
  projects() {
    return this.request<ProjectsResponse>('/projects');
  }
  createProject(name: string) {
    return this.mutation<ProjectSummary>('/projects', 'POST', { name });
  }
  renameProject(id: string, name: string) {
    return this.mutation<ProjectSummary>(
      `/projects/${encodeURIComponent(id)}`,
      'PATCH',
      { name },
    );
  }
  deleteProject(id: string) {
    return this.mutation<{ deleted: true }>(
      `/projects/${encodeURIComponent(id)}`,
      'DELETE',
      {},
    );
  }
  protected async mutation<T>(path: string, method: string, body: unknown) {
    if (!this.csrfToken) await this.connect();
    const send = () =>
      this.request<T>(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Factory-CSRF': this.csrfToken!,
        },
        body: JSON.stringify(body),
      });
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'FORBIDDEN')
        throw error;
      await this.connect();
      return send();
    }
  }

  saveSettings(value: UpdateSettingsRequest) {
    return this.mutation<SettingsResponse>('/settings', 'PUT', value);
  }
  saveCredential(provider: CredentialId, value: string) {
    return this.mutation<{ configured: boolean }>(
      `/credentials/${provider}`,
      'PUT',
      { value },
    );
  }
  deleteCredential(provider: CredentialId) {
    return this.mutation<{ configured: boolean }>(
      `/credentials/${provider}`,
      'DELETE',
      {},
    );
  }
}
