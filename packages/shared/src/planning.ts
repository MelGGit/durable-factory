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
  /** What the developer must not change. Absent on tickets saved before the readiness contract. */
  outOfScope?: string;
  /** Every choice the developer would otherwise make, one `D-N: question -> decision` per line. */
  decisions?: string;
  /** Files to touch, one `modify|create path: intent` per line. */
  files?: string;
}
export interface TicketFinding {
  kind: 'needs_user_decision' | 'resolvable_from_repo' | 'nit';
  text: string;
}
/** Independent readiness review of one saved ticket revision. */
export interface TicketReview {
  revision: number;
  /** Attempts for this conversation, including failed ones. */
  round: number;
  /** True when no finding blocks implementation. */
  passed: boolean;
  /** The round limit released the gate with findings still open. */
  waived?: boolean;
  findings: TicketFinding[];
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
  review?: TicketReview;
  /** Failed review attempts in the current revise loop. */
  reviewRounds?: number;
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
