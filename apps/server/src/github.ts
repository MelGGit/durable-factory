import {
  ApiError,
  type GitHubValidation,
  type IssueLink,
} from '../../../packages/shared/src/index.js';
import type { PrivateCredentials } from './credentials.js';
export interface RemoteIssue extends IssueLink {
  body: string;
  pullRequest?: boolean;
}
export interface GitHubIssue extends RemoteIssue {
  title: string;
  updatedAt: string;
  state: 'open' | 'closed';
}
export interface GitHubPull {
  number: number;
  url: string;
  body: string;
  head: string;
  headRepository: string;
  headBranch: string;
  baseRepository: string;
  baseBranch: string;
  state: string;
  draft: boolean;
  merged?: boolean;
}
export interface GitHubAdapter {
  getPull?(
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPull>;
  getIssue?(
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubIssue>;
  readyIssues?(
    repository: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<{ issues: GitHubIssue[]; hasNext: boolean }>;
  baseSha?(
    repository: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string>;
  pulls?(
    repository: string,
    branch: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<{ pulls: GitHubPull[]; hasNext: boolean }>;
  createPull?(
    repository: string,
    input: { title: string; body: string; head: string; base: string },
    signal?: AbortSignal,
  ): Promise<GitHubPull>;

  validate(repository: string, signal?: AbortSignal): Promise<GitHubValidation>;
  list(
    repository: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<{ issues: RemoteIssue[]; hasNext: boolean }>;
  create(
    repository: string,
    title: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<IssueLink>;
}
/** Only a confirmed rejection or a failure before dispatch permits another POST. */
export class GitHubFailure extends Error {
  constructor(
    public message: string,
    public definitive = false,
    public code:
      | 'AUTHENTICATION'
      | 'FORBIDDEN'
      | 'PROVIDER_UNAVAILABLE' = 'PROVIDER_UNAVAILABLE',
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}
export function createGitHub(
  credentials: PrivateCredentials,
  fetcher: typeof fetch = fetch,
): GitHubAdapter {
  async function request(
    repository: string,
    suffix: string,
    method = 'GET',
    payload?: unknown,
    signal?: AbortSignal,
  ) {
    const checkCancellation = () => {
      if (signal?.aborted)
        throw new GitHubFailure(
          'GitHub request interrupted before dispatch. Retry when ready.',
          true,
        );
    };
    checkCancellation();
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      repository.split('/').some((part) => part === '.' || part === '..')
    )
      throw new GitHubFailure(
        'Configure a GitHub owner/repository first.',
        true,
      );
    let token;
    try {
      token = await credentials.read('github', { signal });
    } catch {
      checkCancellation();
      throw new GitHubFailure(
        'Replace the unreadable GitHub token in settings.',
        true,
      );
    }
    if (!token || token.type !== 'api_key')
      throw new GitHubFailure('Store a GitHub token in settings.', true);
    checkCancellation();
    let response: Response;
    try {
      response = await fetcher(
        `https://api.github.com/repos/${repository}${suffix}`,
        {
          method,
          redirect: 'error',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${token.key}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        },
      );
    } catch {
      throw new GitHubFailure(
        'GitHub did not return a confirmed response. Reconcile before retrying.',
      );
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'GitHub authentication failed. Replace the expired or invalid token.',
        403:
          response.headers.get('retry-after') ||
          response.headers.get('x-ratelimit-remaining') === '0'
            ? 'GitHub rate limited this request. Retry later.'
            : 'GitHub denied access. Check token repository selection and the required Issues, Contents, or Pull requests permission.',
        404: 'GitHub repository is unavailable or the token cannot access it.',
        410: 'GitHub issues are disabled for this repository.',
        422: 'GitHub rejected the request. Check the issue, branch, and repository settings.',
        429: 'GitHub rate limited this request. Retry later.',
      };
      throw new GitHubFailure(
        messages[response.status] ??
          'GitHub returned an unsuccessful response.',
        [401, 403, 404, 410, 422, 429].includes(response.status),
        response.status === 401
          ? 'AUTHENTICATION'
          : response.status === 403
            ? 'FORBIDDEN'
            : 'PROVIDER_UNAVAILABLE',
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('retry-after') ||
            response.headers.get('x-ratelimit-remaining') === '0'))
          ? Math.max(
              60000,
              Number(response.headers.get('retry-after') ?? 0) * 1000,
              Number(response.headers.get('x-ratelimit-reset') ?? 0) * 1000 -
                Date.now(),
            )
          : 0,
      );
    }
    // Bound response memory even when the remote endpoint misbehaves.
    const reader = response.body?.getReader();
    let text = '';
    const decoder = new TextDecoder();
    if (reader) {
      let bytes = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new GitHubFailure(
            'GitHub response exceeded the inspection limit.',
          );
        }
        text += decoder.decode(next.value, { stream: true });
      }
    }
    text += decoder.decode();
    try {
      return {
        data: JSON.parse(text),
        hasNext: /rel="next"/.test(response.headers.get('link') ?? ''),
      };
    } catch {
      throw new GitHubFailure('GitHub returned an unreadable response.');
    }
  }
  function issue(value: any): RemoteIssue {
    if (
      !Number.isSafeInteger(value.number) ||
      value.number < 1 ||
      typeof value.html_url !== 'string' ||
      !/^https:\/\/github\.com\//.test(value.html_url)
    )
      throw new GitHubFailure('GitHub returned an invalid issue identity.');
    return {
      number: value.number,
      url: value.html_url,
      body: typeof value.body === 'string' ? value.body : '',
      ...(value.pull_request ? { pullRequest: true } : {}),
    };
  }
  function detailedIssue(value: any): GitHubIssue {
    if (
      typeof value.title !== 'string' ||
      typeof value.updated_at !== 'string' ||
      !['open', 'closed'].includes(value.state)
    )
      throw new GitHubFailure('GitHub returned incomplete issue details.');
    return {
      ...issue(value),
      title: value.title,
      updatedAt: value.updated_at,
      state: value.state,
    };
  }
  function pull(value: any): GitHubPull {
    const identity = issue(value);
    if (
      typeof value.head?.sha !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(value.head.sha) ||
      typeof value.draft !== 'boolean' ||
      [
        value.head?.repo?.full_name,
        value.head?.ref,
        value.base?.repo?.full_name,
        value.base?.ref,
      ].some((field) => typeof field !== 'string' || !field)
    )
      throw new GitHubFailure('GitHub returned an invalid PR revision.');
    return {
      number: identity.number,
      url: identity.url,
      body: identity.body,
      head: value.head.sha,
      headRepository: value.head.repo.full_name,
      headBranch: value.head.ref,
      baseRepository: value.base.repo.full_name,
      baseBranch: value.base.ref,
      state: value.state,
      draft: value.draft,
      ...(typeof value.merged === 'boolean' ? { merged: value.merged } : {}),
    };
  }
  return {
    async getPull(repository, number, signal) {
      const { data } = await request(
        repository,
        `/pulls/${number}`,
        'GET',
        undefined,
        signal,
      );
      if (typeof data.merged !== 'boolean')
        throw new GitHubFailure('GitHub returned no merge confirmation.');
      return pull(data);
    },
    async getIssue(repository, number, signal) {
      return detailedIssue(
        (
          await request(
            repository,
            `/issues/${number}`,
            'GET',
            undefined,
            signal,
          )
        ).data,
      );
    },
    async readyIssues(repository, page, signal) {
      const result = await request(
        repository,
        `/issues?state=open&labels=agent%3Aready&per_page=100&page=${page}`,
        'GET',
        undefined,
        signal,
      );
      if (!Array.isArray(result.data))
        throw new GitHubFailure('GitHub returned an invalid issue list.');
      return {
        issues: result.data
          .filter((i: any) => !i.pull_request)
          .map(detailedIssue),
        hasNext: result.hasNext,
      };
    },
    async baseSha(repository, branch, signal) {
      const { data } = await request(
        repository,
        `/git/ref/heads/${encodeURIComponent(branch)}`,
        'GET',
        undefined,
        signal,
      );
      if (!/^[a-f0-9]{40,64}$/.test(data.object?.sha ?? ''))
        throw new GitHubFailure('GitHub returned an invalid base revision.');
      return data.object.sha;
    },
    async pulls(repository, branch, page, signal) {
      const result = await request(
        repository,
        `/pulls?state=all&head=${encodeURIComponent(repository.split('/')[0] + ':' + branch)}&per_page=100&page=${page}`,
        'GET',
        undefined,
        signal,
      );
      if (!Array.isArray(result.data))
        throw new GitHubFailure(
          'GitHub returned an invalid pull request list.',
        );
      return { pulls: result.data.map(pull), hasNext: result.hasNext };
    },
    async createPull(repository, input, signal) {
      return pull(
        (
          await request(
            repository,
            '/pulls',
            'POST',
            { ...input, draft: false },
            signal,
          )
        ).data,
      );
    },
    async validate(repository, signal) {
      try {
        const { data } = await request(
          repository,
          '',
          'GET',
          undefined,
          signal,
        );
        await request(
          repository,
          '/issues?state=all&per_page=1',
          'GET',
          undefined,
          signal,
        );
        return {
          repository,
          accessible: true,
          issuesEnabled: data.has_issues === true && !data.archived,
          writeAccess: 'unverified',
          message:
            data.has_issues && !data.archived
              ? 'Repository and issues are readable. Issue write permission is verified only when creating an approved issue.'
              : 'Repository is archived or issues are disabled.',
        };
      } catch (error) {
        throw new ApiError(
          error instanceof GitHubFailure ? error.code : 'PROVIDER_UNAVAILABLE',
          error instanceof GitHubFailure
            ? error.message
            : 'GitHub validation failed.',
          502,
        );
      }
    },
    async list(repository, page, signal) {
      const { data, hasNext } = await request(
        repository,
        `/issues?state=all&per_page=100&page=${page}`,
        'GET',
        undefined,
        signal,
      );
      if (!Array.isArray(data))
        throw new GitHubFailure('GitHub returned an invalid issue list.');
      return { issues: data.map(issue), hasNext };
    },
    async create(repository, title, body, signal) {
      return issue(
        (await request(repository, '/issues', 'POST', { title, body }, signal))
          .data,
      );
    },
  };
}
