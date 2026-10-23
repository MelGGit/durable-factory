import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startService } from '../../apps/server/src/service.js';
import { WorkflowClient, ChatClient } from '../../packages/shared/src/index.js';
import {
  simulationAdapter,
  type WorkflowAdapter,
  type WorkflowClock,
} from '../../apps/server/src/workflow.js';
import { configure, until } from './chat.js';
import { FakeGitHub, planningFixture } from './planning.js';

export async function workflowFixture(
  adapter: WorkflowAdapter = simulationAdapter(),
  clock?: WorkflowClock,
) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-workflow-'));
  const repo = join(directory, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  const dataDir = join(directory, 'data');
  const github = new FakeGitHub();
  let service = await startService({
    port: 0,
    dataDir,
    chat: planningFixture(),
    github,
    workflow: { adapter, clock },
  });
  const chat = new ChatClient(service.url);
  await configure(chat);
  const saved = await chat.settings();
  saved.settings.repository = {
    path: repo,
    github: 'example/project',
    baseBranch: 'main',
  };
  saved.settings.requiredChecks = ['fake test'];
  await chat.saveSettings({
    expectedRevision: saved.revision,
    settings: saved.settings,
  });
  let client = new WorkflowClient(service.url);
  const issue = async (requestId = 'create-plan') => {
    const conversation = await chat.createConversation(
      'Workflow plan',
      requestId,
    );
    await chat.submit(conversation.id, 'plan', `plan-${requestId}`);
    await until(
      () => chat.submission(conversation.id, `plan-${requestId}`),
      (s) => s.status === 'completed',
    );
    await chat.submit(conversation.id, 'yes', `yes-${requestId}`);
    await until(
      () => chat.submission(conversation.id, `yes-${requestId}`),
      (s) => s.status === 'completed',
    );
    return conversation.id;
  };
  return {
    directory,
    dataDir,
    repo,
    chat,
    get service() {
      return service;
    },
    get client() {
      return client;
    },
    issue,
    async restart(enabled = true, samePort = false) {
      const port = samePort ? service.port : 0;
      await service.close();
      service = await startService({
        port,
        dataDir,
        chat: planningFixture(),
        github,
        ...(enabled
          ? { workflow: { adapter, clock } }
          : { workflowMode: 'disabled' as const }),
      });
      client = new WorkflowClient(service.url);
    },
    async close() {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
