import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startService } from '../apps/server/src/service.js';
import { configure, until } from '../apps/server/src/chat-fixtures.js';
import { planningFixture } from '../tests/fixtures/planning.js';
import { ChatClient } from '../packages/shared/src/index.js';
import type { GitHubAdapter, RemoteIssue } from '../apps/server/src/github.js';
const [dataDir, repo, mode] = process.argv.slice(2);
const effects = join(dataDir, 'github-effects.json');
const github: GitHubAdapter = {
  async validate(repository) {
    return {
      repository,
      accessible: true,
      issuesEnabled: true,
      writeAccess: 'unverified',
      message: 'Offline',
    };
  },
  async list() {
    let issues: RemoteIssue[] = [];
    try {
      issues = JSON.parse(await readFile(effects, 'utf8'));
    } catch {}
    return { issues, hasNext: false };
  },
  async create(_repository, _title, body) {
    await appendFile(join(dataDir, 'create-calls.txt'), 'POST\n');
    const issue = {
      number: 42,
      url: 'https://github.com/example/project/issues/42',
      body,
    };
    await writeFile(effects, JSON.stringify([issue]));
    process.send?.({ phase: 'effect' });
    await new Promise(() => {});
    return issue;
  },
};
const service = await startService({
  dataDir,
  port: 0,
  chat: planningFixture(),
  github,
});
const client = new ChatClient(service.url);
try {
  let conversation = (await client.conversations()).conversations[0];
  if (!conversation) {
    await configure(client);
    const saved = await client.settings();
    saved.settings.repository = {
      path: repo,
      github: 'example/project',
      baseBranch: 'main',
    };
    await client.saveSettings({
      expectedRevision: saved.revision,
      settings: saved.settings,
    });
    conversation = await client.createConversation(
      'Crash-safe issue',
      'recovery-conversation',
    );
    await client.submit(conversation.id, 'plan', 'plan');
    await until(
      () => client.submission(conversation.id, 'plan'),
      (s) => s.status === 'completed',
    );
  }
  if (mode === 'crash') {
    await client.submit(conversation.id, 'yes', 'approve-issue');
    await new Promise(() => {});
  } else {
    await until(
      () => client.submission(conversation.id, 'approve-issue'),
      (s) => s.status === 'completed',
    );
    const planning = await service.planning.read(conversation.id);
    const submission = await client.submission(
      conversation.id,
      'approve-issue',
    );
    process.send?.({ phase: 'done', planning, submission });
  }
} finally {
  await service.close();
}
