import {
  fixture,
  fauxAssistantMessage,
  fauxToolCall,
} from '../../apps/server/src/chat-fixtures.js';
import type {
  GitHubAdapter,
  RemoteIssue,
} from '../../apps/server/src/github.js';
import { GitHubFailure } from '../../apps/server/src/github.js';
export const ticket = {
  title: 'Add search',
  goal: 'Find saved work',
  scope: 'Search the current project',
  acceptanceCriteria: 'AC-1: Results link to matching files',
  regression: {
    required: false as const,
    reason: 'New capability; the required suite validates the change.',
  },
  validation: 'Run the offline search tests',
};
export function planningFixture() {
  const deps = fixture();
  deps.faux.setResponses(
    Array.from({ length: 100 }, () => async (input) => {
      const user = [...input.messages].reverse().find((m) => m.role === 'user');
      const text =
        typeof user?.content === 'string'
          ? user.content
          : JSON.stringify(user?.content);
      // Inspect only the current turn, so another plan can update the ticket.
      const lastUser = input.messages.lastIndexOf(user!);
      const results = input.messages
        .slice(lastUser + 1)
        .filter((m) => m.role === 'toolResult');
      const call = (name: string, args = {}) =>
        fauxAssistantMessage(fauxToolCall(name, args), {
          stopReason: 'toolUse',
        });
      if (text === 'start implementation' || text === 'force start') {
        if (!results.length) return call('start_development');
        return fauxAssistantMessage('Start operation handled.');
      }
      if (text === 'plan') {
        if (!results.some((r) => r.toolName === 'save_ticket'))
          return call('save_ticket', ticket);
        if (!results.some((r) => r.toolName === 'propose_issue'))
          return call('propose_issue');
        return fauxAssistantMessage(
          'Here is the saved plan. Should I create this GitHub issue?',
        );
      }
      if (text === 'yes' || text === 'create it' || text === 'force create') {
        if (!results.length) return call('create_issue');
        return fauxAssistantMessage('Issue operation recorded.');
      }
      return fauxAssistantMessage(`Reply: ${text}`);
    }),
  );
  return deps;
}
export class FakeGitHub implements GitHubAdapter {
  issues: RemoteIssue[] = [];
  calls = 0;
  pages: number[] = [];
  mode: 'success' | 'lost' | 'rejected' | 'unknown' = 'success';
  async validate(repository: string) {
    return {
      repository,
      accessible: true,
      issuesEnabled: true,
      writeAccess: 'unverified' as const,
      message: 'Readable; write access unverified.',
    };
  }
  async list(_repository: string, page: number) {
    this.pages.push(page);
    return {
      issues: this.issues.slice((page - 1) * 2, page * 2),
      hasNext: page * 2 < this.issues.length,
    };
  }
  async create(_repository: string, _title: string, body: string) {
    this.calls++;
    if (this.mode === 'rejected')
      throw new GitHubFailure('Token expired.', true);
    if (this.mode === 'unknown') throw new Error('Timeout');
    const issue = {
      number: this.issues.length + 1,
      url: `https://github.com/example/project/issues/${this.issues.length + 1}`,
      body,
    };
    this.issues.push(issue);
    if (this.mode === 'lost') throw new Error('Response lost after creation');
    return { number: issue.number, url: issue.url };
  }
}
