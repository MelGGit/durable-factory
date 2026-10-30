import type { AcceptanceCriterion, RegressionRequirement } from './handoffs.js';
export interface RepositoryRegistration {
  id: string;
  path: string;
  github: string;
  baseBranch: string;
}
export interface Ticket {
  revision: number;
  title: string;
  goal: string;
  scope: string;
  acceptanceCriteria: string;
  criteria?: AcceptanceCriterion[];
  regression?: RegressionRequirement;
  validation: string;
}
export interface IssueLink {
  number: number;
  url: string;
}
export interface ProjectIssue extends IssueLink {
  title: string;
  body: string;
  updatedAt: string;
  state: 'open' | 'closed';
}
export type ProjectIssueSummary = Omit<ProjectIssue, 'body'>;
export interface ProjectIssuesResponse {
  issues: ProjectIssueSummary[];
  hasNext: boolean;
}
export interface IssueOperation {
  kind?: 'create' | 'update';
  sourceIssue?: ProjectIssue;
  id: string;
  requestId: string;
  repository: RepositoryRegistration;
  ticket: Ticket;
  state:
    | 'prepared'
    | 'sending'
    | 'uncertain'
    | 'rejected'
    | 'created'
    | 'blocked';
  message?: string;
  issue?: IssueLink;
}
export interface PlanningState {
  sourceIssue?: ProjectIssue;
  startAuthorization?: { requestId: string };
  runId?: string;
  repository: RepositoryRegistration;
  ticket?: Ticket;
  proposal?: { id: string; revision: number };
  authorization?: { requestId: string; proposalId: string; revision: number };
  operation?: IssueOperation;
}
export interface GitHubValidation {
  repository: string;
  accessible: boolean;
  issuesEnabled: boolean;
  writeAccess: 'unverified';
  message: string;
}
