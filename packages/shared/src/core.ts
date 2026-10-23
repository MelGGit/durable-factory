import type { GitHubValidation } from './planning.js';
export const API_VERSION = 'v1' as const;
export const ROLES = ['planning', 'development', 'review'] as const;
export type Role = (typeof ROLES)[number];
export const PROVIDERS = ['requesty', 'openai', 'anthropic'] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type CredentialId = ProviderId | 'github';
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
export interface SettingsResponse {
  apiVersion: typeof API_VERSION;
  revision: number;
  settings: Settings;
  credentials: Record<CredentialId, boolean>;
  credentialErrors: Partial<Record<CredentialId, string>>;
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
export class FactoryClient {
  private csrfToken?: string;
  constructor(
    protected baseUrl = '',
    protected fetcher: typeof fetch = fetch,
  ) {}
  protected async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher.call(
      globalThis,
      `${this.baseUrl}/api/v1${path}`,
      init,
    );
    const body = await response.json();
    if (!response.ok)
      throw new ApiError(
        body.error?.code ?? 'INTERNAL',
        body.error?.message ?? 'The service could not complete the request.',
        response.status,
      );
    return body as T;
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
