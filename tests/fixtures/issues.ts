import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatClient, WorkflowClient } from '../../packages/shared/src/index.js';
import { FakeGitHub, planningFixture, ticket } from './planning.js';
import { configure } from './chat.js';
import { startService } from '../helpers/credentials.js';
import { ticketBody } from '../../apps/server/src/planning.js';
import { simulationAdapter } from '../../apps/server/src/workflow.js';

export class ProjectGitHub extends FakeGitHub {
  repositories = new Map<string, FakeGitHub>();
  repository(name: string) {
    let remote = this.repositories.get(name);
    if (!remote) {
      remote = new FakeGitHub();
      this.repositories.set(name, remote);
    }
    return remote;
  }
  override async create(repository: string, title: string, body: string) {
    const issue = await this.repository(repository).create(
      repository,
      title,
      body,
    );
    return {
      ...issue,
      url: `https://github.com/${repository}/issues/${issue.number}`,
    };
  }
  override async getIssue(
    repository: string,
    number: number,
    signal?: AbortSignal,
  ) {
    const issue = await this.repository(repository).getIssue(
      repository,
      number,
      signal,
    );
    return {
      ...issue,
      url: `https://github.com/${repository}/issues/${issue.number}`,
    };
  }
  override async openIssues(repository: string, page: number) {
    const result = await this.repository(repository).openIssues(
      repository,
      page,
    );
    return {
      ...result,
      issues: result.issues.map((issue) => ({
        ...issue,
        url: `https://github.com/${repository}/issues/${issue.number}`,
      })),
    };
  }
  override async updateIssue(
    repository: string,
    number: number,
    title: string,
    body: string,
  ) {
    await this.repository(repository).updateIssue(
      repository,
      number,
      title,
      body,
    );
    return this.getIssue(repository, number);
  }
}

export async function issuesFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'factory-project-issues-'));
  const dataDir = join(directory, 'data');
  const github = new ProjectGitHub();
  const options = {
    dataDir,
    port: 0,
    chat: planningFixture(),
    github,
    workflow: { adapter: simulationAdapter() },
  };
  let service = await startService(options);
  const client = new ChatClient(service.url);
  await configure(client);
  await client.renameProject('default', 'Alpha');
  const beta = await client.createProject('Beta');
  for (const [id, name] of [
    ['default', 'alpha'],
    [beta.id, 'beta'],
  ]) {
    const path = join(directory, name);
    await mkdir(path);
    execFileSync('git', ['init', '-q', path]);
    const scoped = new ChatClient(service.url, undefined, id);
    const saved = await scoped.settings();
    saved.settings.repository = {
      path,
      github: `example/${name}`,
      baseBranch: 'main',
    };
    saved.settings.requiredChecks = ['fake test'];
    await scoped.saveSettings({
      expectedRevision: saved.revision,
      settings: saved.settings,
    });
  }
  for (const [repository, title] of [
    ['example/alpha', 'Find saved work'],
    ['example/alpha', 'Keep issue context after reconnecting'],
    [
      'example/alpha',
      'A longer issue title that must wrap neatly on a small screen',
    ],
    ['example/beta', 'Update the project dashboard'],
  ]) {
    await github.create(
      repository,
      title,
      ticketBody({ ...ticket, title, revision: 0 }),
    );
  }
  return {
    github,
    directory,
    dataDir,
    beta,
    get service() {
      return service;
    },
    chat: (id = 'default') => new ChatClient(service.url, undefined, id),
    workflow: (id = 'default') =>
      new WorkflowClient(service.url, undefined, id),
    async restart() {
      await service.close();
      service = await startService({ ...options, port: service.port });
    },
    async close() {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
