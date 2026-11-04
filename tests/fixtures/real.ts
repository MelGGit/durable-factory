import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startService } from '../helpers/credentials.js';
import {
  formatTicketBody,
  WorkflowClient,
  ChatClient,
  type RegressionRequirement,
  type CriterionAssessment,
} from '../../packages/shared/src/index.js';
import { fixture, configure, until } from './chat.js';
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '../../apps/server/src/chat-fixtures.js';
import { FakeGitHub, ticket } from './planning.js';
import type {
  GitHubPull,
  GitHubAdapter,
} from '../../apps/server/src/github.js';

/** A tool result as the scripted model received it. */
export type SeenResult = {
  role: 'developer' | 'reviewer';
  toolName: string;
  isError: boolean;
  text: string;
};
export async function realFixture(
  options: {
    directory?: string;
    mode?: 'real' | 'simulation' | 'disabled';
    developerCommand?: string;
    checkCommand?: string;
    reviewDelay?: number;
    reviewQuestion?: boolean;
    labelReady?: boolean;
    afterCreate?: () => Promise<void>;
    beforeReview?: () => Promise<void>;
    afterImplementation?: () => Promise<void>;
    checkFailure?: boolean;
    lostPr?: boolean;
    malformedReview?: boolean;
    omitImplementation?: boolean;
    reportFiles?: string[];
    assessments?: CriterionAssessment[];
    regression?: RegressionRequirement;
    proofTest?: string;
    extraFile?: string | string[];
    /** The developer asks this before working, until an answer exists. */
    ask?: {
      question: string;
      outOfScope?: { change: string; paths: string[] };
    };
    /** Entries for the report's outOfScope. */
    declareOutOfScope?: string[];
    reviewScope?: {
      withinTicket: boolean;
      outOfScope: { change: string; required: boolean; evidence: string }[];
    };
    issueBody?: string;
    /** Extra files in the baseline commit. */
    baselineFiles?: Record<string, string>;
    /** Appended to the ticket scope, which names files the developer may touch. */
    scopeNote?: string;
    /** Developer turns that stop without a report; each reminder counts as one. */
    forgetReport?: number;
    /** Provider requests that fail with a transient error before the script runs. */
    transientFailures?: number;
    retry?: { maxRetries: number; baseDelayMs?: number };
    /** Tool calls the developer makes before the default script, in order. */
    developerCalls?: {
      name: string;
      args: Record<string, unknown> | ((results: SeenResult[]) => object);
    }[];
    /** Same for the reviewer. */
    reviewerCalls?: {
      name: string;
      args: Record<string, unknown> | ((results: SeenResult[]) => object);
    }[];
  } = {},
) {
  const directory =
      options.directory ?? (await mkdtemp(join(tmpdir(), 'factory-real-'))),
    repo = join(directory, 'repo'),
    remote = join(directory, 'remote.git'),
    dataDir = join(directory, 'data');
  if (!options.directory) await mkdir(repo);
  const git = (root: string, args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.com',
      },
    }).trim();
  if (!options.directory) {
    git(repo, ['init', '-q', '-b', 'main']);
    await writeFile(join(repo, 'value.txt'), 'baseline\n');
    await writeFile(join(repo, '.gitignore'), 'generated/\n');
    for (const [path, content] of Object.entries(options.baselineFiles ?? {}))
      await writeFile(join(repo, path), content);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'Baseline']);
    git(directory, ['init', '--bare', '-q', remote]);
    git(repo, ['push', '-q', remote, 'main']);
    await writeFile(join(repo, 'user-draft.txt'), 'untouched');
  }
  const deps = fixture();
  let reviewAsked = false;
  let failures = 0;
  const finals: string[] = [];
  const seen = new Map<string, SeenResult>();
  const prompts: { role: 'developer' | 'reviewer'; text: string }[] = [];
  deps.faux.setResponses(
    Array.from({ length: 200 }, () => async (input) => {
      const user = [...input.messages].reverse().find((m) => m.role === 'user');
      const agentPrompt = [...input.messages]
        .reverse()
        .find(
          (m) =>
            m.role === 'user' &&
            typeof m.content === 'string' &&
            /\"role\":\"(developer|reviewer)\"/.test(m.content),
        );
      const current = agentPrompt ?? user;
      const last = input.messages.lastIndexOf(current!);
      const text = typeof current?.content === 'string' ? current.content : '';
      const results = input.messages
        .slice(last + 1)
        .filter((m) => m.role === 'toolResult');
      const call = (name: string, args = {}) =>
        fauxAssistantMessage(fauxToolCall(name, args), {
          stopReason: 'toolUse',
        });
      const role = text.includes('"role":"developer"')
        ? 'developer'
        : text.includes('"role":"reviewer"')
          ? 'reviewer'
          : undefined;
      if (role && !prompts.some((p) => p.text === text))
        prompts.push({ role, text });
      const mine: SeenResult[] = [];
      for (const r of results) {
        const entry: SeenResult = {
          role: role!,
          toolName: r.toolName,
          isError: r.isError,
          text: r.content.map((c) => ('text' in c ? c.text : '')).join(''),
        };
        seen.set(`${role}-${r.toolCallId}`, entry);
        mine.push(entry);
      }
      if (role === 'developer' && failures < (options.transientFailures ?? 0)) {
        failures++;
        return fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: '503 service temporarily unavailable',
        });
      }
      const scripted = role && options[`${role}Calls`];
      if (scripted && mine.length < scripted.length) {
        const next = scripted[mine.length];
        return call(
          next.name,
          typeof next.args === 'function' ? next.args(mine) : next.args,
        );
      }
      if (text === 'plan') {
        if (!results.some((r) => r.toolName === 'save_ticket'))
          return call('save_ticket', ticket);
        if (!results.some((r) => r.toolName === 'propose_issue'))
          return call('propose_issue');
        return fauxAssistantMessage('Create this issue?');
      }
      if (text === 'yes') {
        if (!results.length) return call('create_issue');
        return fauxAssistantMessage('Issue created.');
      }
      if (text.includes('"role":"developer"')) {
        if (
          options.ask &&
          text.includes('"answers":[]') &&
          !results.some((r) => r.toolName === 'workflow_question')
        )
          return call('workflow_question', options.ask);
        if (
          options.developerCommand &&
          !results.some((r) => r.toolName === 'worktree_command')
        )
          return call('worktree_command', {
            command: options.developerCommand,
          });
        const writes = results.filter(
          (r) => r.toolName === 'worktree_write',
        ).length;
        if (!writes)
          return call('worktree_write', {
            path: 'value.txt',
            content: 'implemented\n',
          });
        if (writes === 1)
          return call('worktree_write', {
            path: 'generated/result.txt',
            content: 'generated\n',
          });
        if (!results.some((r) => r.toolName === 'include_generated_file'))
          return call('include_generated_file', {
            path: 'generated/result.txt',
          });
        const nextExtra = [options.extraFile ?? []]
          .flat()
          .find(
            (path) =>
              !results.some(
                (r) =>
                  r.toolName === 'worktree_write' &&
                  JSON.stringify(r).includes(path),
              ),
          );
        if (nextExtra)
          return call('worktree_write', {
            path: nextExtra,
            content: 'extra\n',
          });
        if (
          options.proofTest &&
          !results.some(
            (r) =>
              r.toolName === 'worktree_write' &&
              JSON.stringify(r).includes('regression.test.cjs'),
          )
        )
          return call('worktree_write', {
            path: 'regression.test.cjs',
            content: options.proofTest,
          });
        const reminders = input.messages
          .slice(last + 1)
          .filter((m) => m.role === 'user').length;
        if (
          !options.omitImplementation &&
          reminders >= (options.forgetReport ?? 0) &&
          !results.some((r) => r.toolName === 'submit_implementation')
        ) {
          const run = JSON.parse(text.slice(text.indexOf('\n\n{') + 2));
          const changed = [
            ...git(run.workspace.path, [
              'diff',
              '--no-renames',
              '--name-only',
              run.base,
              '--',
            ]).split('\n'),
            ...git(run.workspace.path, [
              'ls-files',
              '--others',
              '--exclude-standard',
            ]).split('\n'),
          ].filter(Boolean);
          return call('submit_implementation', {
            summary: 'Update value and generated result.',
            changedFiles:
              options.reportFiles ??
              [...new Set([...changed, 'generated/result.txt'])].sort(),
            criteria: ['AC-1'],
            validation: ['Required checks run by the service.'],
            concerns: [],
            reviewerNotes: 'Inspect the value and generated result.',
            outOfScope: options.declareOutOfScope ?? [],
          });
        }
        await options.afterImplementation?.();
        finals.push('developer');
        return fauxAssistantMessage('Implementation complete.');
      }
      if (text.includes('"role":"reviewer"')) {
        if (!results.length) {
          await options.beforeReview?.();
          if (options.reviewDelay)
            await new Promise((resolve) =>
              setTimeout(resolve, options.reviewDelay),
            );
          if (options.reviewQuestion && !reviewAsked) {
            reviewAsked = true;
            return call('workflow_question', {
              question: 'Which interpretation is correct?',
            });
          }
        }
        if (!results.some((r) => r.toolName === 'worktree_read'))
          return call('worktree_read', { path: 'generated/result.txt' });
        if (
          !options.malformedReview &&
          !results.some((r) => r.toolName === 'submit_review')
        )
          return call('submit_review', {
            verdict: options.reviewScope?.outOfScope.some((i) => !i.required)
              ? 'changes_requested'
              : 'pass',
            findings: options.reviewScope?.outOfScope.some((i) => !i.required)
              ? [{ message: 'Revert the extra change.', blocking: true }]
              : [],
            scope: options.reviewScope ?? {
              withinTicket: true,
              outOfScope: [],
            },
            assessments: options.assessments ?? [
              {
                id: 'AC-1',
                status: 'met',
                explanation:
                  'The candidate includes the requested value and generated result.',
                references: [
                  { path: 'value.txt', line: 1 },
                  { path: 'generated/result.txt', line: 1 },
                ],
              },
            ],
          });
        finals.push('reviewer');
        return fauxAssistantMessage('Review complete.');
      }
      return fauxAssistantMessage('Fixture reply');
    }),
  );
  const github = new FakeGitHub() as FakeGitHub &
    Required<
      Pick<
        GitHubAdapter,
        | 'getIssue'
        | 'getPull'
        | 'baseSha'
        | 'readyIssues'
        | 'pulls'
        | 'createPull'
      >
    >;
  let pulls: GitHubPull[] = [];
  let creates = 0;
  try {
    const state = JSON.parse(
      await readFile(join(directory, 'fake-github.json'), 'utf8'),
    );
    pulls = state.pulls;
    creates = state.creates;
  } catch {}
  github.getIssue = async () => ({
    number: 7,
    url: 'https://github.com/example/project/issues/7',
    title: 'Implement value',
    body:
      options.issueBody ??
      formatTicketBody({
        ...ticket,
        ...(options.regression ? { regression: options.regression } : {}),
        title: 'Implement value',
        scope:
          `The scripted agent may also write effect.txt, tool-boundary.txt and regression.test.cjs. ${options.scopeNote ?? ''}`.trim(),
        goal: 'Update value.txt and generated/result.txt.',
        acceptanceCriteria: 'AC-1: Update value.txt and generated/result.txt.',
        revision: 0,
      }),
    updatedAt: '2026-10-22T00:00:00Z',
    state: 'open',
  });
  github.baseSha = async () => git(remote, ['rev-parse', 'main']);
  github.readyIssues = async () => ({
    issues: options.labelReady
      ? [await github.getIssue('example/project', 7)]
      : [],
    hasNext: false,
  });
  github.pulls = async () => ({ pulls, hasNext: false });
  github.getPull = async (_repository, number) => {
    const pull = pulls.find((p) => p.number === number);
    if (!pull) throw new Error('PR not found');
    return { ...pull, merged: pull.merged ?? false };
  };
  github.createPull = async (_repository, input) => {
    creates++;
    const pull = {
      number: 9,
      url: 'https://github.com/example/project/pull/9',
      head: git(remote, ['rev-parse', input.head]),
      headRepository: _repository,
      headBranch: input.head,
      baseRepository: _repository,
      baseBranch: input.base,
      body: input.body,
      state: 'open',
      draft: false,
    };
    pulls.push(pull);
    await writeFile(
      join(directory, 'fake-github.json'),
      JSON.stringify({ pulls, creates }),
    );
    await options.afterCreate?.();
    if (options.lostPr) throw new Error('Lost PR response');
    return pull;
  };
  let service = await startService({
    dataDir,
    port: 0,
    chat: deps,
    github,
    workflowRemote: remote,
    workflowMode: options.mode,
    ...(options.retry ? { retry: options.retry } : {}),
  });
  const client = new WorkflowClient(service.url);
  if (!options.directory) {
    await configure(new ChatClient(service.url));
    const saved = await client.settings();
    saved.settings.repository = {
      path: repo,
      github: 'example/project',
      baseBranch: 'main',
    };
    saved.settings.commitIdentity = {
      name: 'Factory',
      email: 'factory@example.com',
    };
    saved.settings.requiredChecks = [
      options.checkCommand ??
        (options.checkFailure
          ? 'exit 2'
          : "node -e \"require('node:fs').readFileSync('value.txt')\""),
    ];
    await client.saveSettings({
      expectedRevision: saved.revision,
      settings: saved.settings,
    });
    await client.saveCredential('requesty', 'offline');
    await client.saveCredential('github', 'offline');
  }
  return {
    directory,
    repo,
    remote,
    dataDir,
    client,
    github,
    /** Every tool result the scripted agents received. */
    get seen() {
      return [...seen.values()];
    },
    /** Every distinct developer and reviewer prompt, in order. */
    prompts,
    /** Roles whose scripted agent was asked for a closing answer. */
    finals,
    get service() {
      return service;
    },
    get creates() {
      return creates;
    },
    git,
    async restart() {
      const port = service.port;
      await service.close();
      service = await startService({
        dataDir,
        port,
        chat: deps,
        github,
        workflowRemote: remote,
        workflowMode: options.mode,
        ...(options.retry ? { retry: options.retry } : {}),
      });
    },
    async close() {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
