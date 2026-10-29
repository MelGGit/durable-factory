# Planning and GitHub issue contract — stage 4

Planning extends the existing Pi harness and `factory.sqlite`; there is no second queue, database, or agent loop. Repository registrations are session documents. Each planning conversation has a latest-state planning document containing its repository snapshot, ticket, proposal, authorization, and optional issue operation. Model settings and transcript history retain their existing identities.

## Repository context and tools

A registration identifies the canonical local path and configured GitHub owner/repository with a stable ID. Each conversation captures its base branch. Settings changes affect future conversations. Earlier conversations are backfilled from captured repository metadata; records predating base-branch capture default to `main`, rather than adopting current settings.

The planner receives `list_repository`, `read_repository`, `search_repository`, `repository_changes`, `search_history`, `save_ticket`, `propose_issue`, and `create_issue`. Tool execution is sequential within a round. No file-editing, unrestricted shell, development admission, label, or PR tool is exposed.

Repository tools inspect current files, including uncommitted files. They reject traversal, symlinks, Git internals, ignored files (including tracked files now ignored), and binary reads. Git inspection disables optional writes, filesystem monitors, hooks, external diffs/text conversion, and configured clean/process filters. Git explicitly pins its worktree to the registered root, overriding `core.worktree`; diff paths are literal. Tools do not provide an operating-system sandbox against another process concurrently replacing files.

Each Git read has a ten-second deadline and a 1 MiB output ceiling. Listing inspects at most 1,000 files, reads return at most 64 KiB, literal search scans at most 4 MiB and returns at most 100 matches, and diff previews are at most 64 KiB. Larger results identify truncation. Untracked files are available through list/read/search rather than the tracked diff. History search inspects only the calling conversation, at most 100 pages, 4 MiB of text, a bounded long-entry preview, and 50 matches; it searches persisted pre-compaction history through existing pagination.

## Proposal and authorization

A ticket contains a title, goal, scope, acceptance criteria, and validation approach. Saving changed content increments its revision and removes the proposal and authorization. Save-tool execution IDs make crash replay idempotent.

`propose_issue` persists a proposal tied to the saved revision and returns the complete ticket with a creation question. The browser displays the saved ticket and question directly beside chat. The planner presents the plan and waits for a new reply.

The service recognizes standalone affirmative replies: `yes`, `yes please`, `yes, create it`, `yes, create the issue`, `create it`, `create the issue`, `please create it`, `please create the issue`, and `go ahead`, case-insensitively with trailing periods or exclamation marks. Approval binds to the pending proposal and ticket revision in the same transaction as the durable chat receipt. Other replies invalidate the proposal, so the planner must clarify and propose again. Text inside repository files, tool results, and quoted or qualified replies cannot grant approval.

The creation tool additionally verifies that the authorizing user submission has actually been consumed. A queued or withdrawn reply does not authorize an effect. The planner cannot supply an approval flag, choose a different repository, or substitute another issue body. One conversation supports one immutable issue operation and resulting link; later ticket changes require another conversation.

## HTTP additions

Existing localhost, origin, JSON-body, and CSRF protections apply.

| Method and route                             | Behavior                                                                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/github/validate`               | `{}`; checks saved repository access and issue readability with the current privately stored token; returns `GitHubValidation`, with write access explicitly unverified |
| `POST /api/v1/conversations/:id/issue/retry` | `{}`; returns `PlanningState` after reconciling the existing approved operation; can resend only an operation that was never sent or definitively rejected              |

Ordered chat snapshots include optional `planning` state. The planning-document watch joins the existing SSE delivery line, so ticket and issue changes propagate without another stream protocol. No endpoint creates an operation without chat approval. Validation feedback is shown beside its settings control. Credentials and raw remote error bodies are never returned.

## External effects and recovery

Before any GitHub POST, one transaction stores a random operation ID, authorizing request ID, repository snapshot, and complete ticket snapshot. The issue body ends with `<!-- durable-factory:issue:OPERATION_ID -->`. Ticket fields cannot contain this reserved marker. Creation first lists repository issues in all states and searches every returned page for that marker, excluding pull requests and deduplicating issue numbers.

Operations progress through `prepared`, `sending`, `created`, `rejected`, `uncertain`, or `blocked`. The service persists `sending` before issuing a POST. The adapter uses the current private token, a fifteen-second request deadline, no redirects, and an 8 MiB response limit. Planning tools pass their cancellation signal through lookup and creation. Interruption is checked after lookup, after saving sending intent, and immediately before transport dispatch. If no POST was dispatched, the operation remains safe for an explicit retry; interruption does not automatically resume creation after restart. If a POST was already dispatched, its confirmed result is still recorded using service-owned persistence, while a lost or aborted response remains uncertain and requires reconciliation. GitHub.com REST access is service-owned; GitHub CLI credentials and ambient tokens are not consulted.

A definitive rejection permits an explicit retry after credentials or permissions are repaired. A transport error, server failure, malformed successful response, or crash after `sending` is uncertain. Reconciliation finds the marked issue and atomically stores its number/link. A missing match after an uncertain write never authorizes another POST. More than one matching issue identity blocks the operation for inspection. After resolving duplicate markers on GitHub, retry reconciliation to link the remaining match; this never grants permission for another POST. Each attempt scans at most 100 pages; an incomplete scan never authorizes creation.

On startup, tool registrations and missing planning metadata are restored before pending operations are reconciled and Pi work resumes. Failed GitHub access leaves the operation inspectable and retryable without blocking the entire application. Repeated submissions, tool replays, and concurrent retry requests serialize on the conversation and return its existing operation or link.

Issue creation does not add `agent:ready`, start a workflow, create branches/worktrees, or open a PR. Explicit implementation instructions call the same durable admission service as application starts and stage 7 label polling; issue creation itself remains separate.

## Approved issue contract — handoffs release

New planning saves require explicit acceptance criteria, one `AC-N: observable outcome` per line, and a regression decision. The service derives `Ticket.criteria` only from these explicit lines; it never invents requirements. `Ticket.regression` is either `{required:false, reason}` or `{required:true, command, testPaths, expectedFailure}`. Required paths are unique repository-relative regular test/fixture files; the failure signature is literal text, not a regular expression. The planner must inspect the repository and settle these details before proposing the issue.

The complete issue title and body are shown before approval, including regression instructions. The shared formatter/parser uses Goal, Scope, Acceptance criteria, Validation, and Regression proof headings. Regression commands, path arrays, signatures and reasons use JSON values on labelled lines so multiline text round-trips without ambiguity. Approval still binds to the entire saved revision; editing any field invalidates it. Existing approved operations retain their original payload, including legacy tickets without regression metadata.

Example regression section:

```text
## Regression proof

Required: yes
Command: "node checkout.test.cjs"
Test paths: ["checkout.test.cjs","fixtures/guest.json"]
Expected failure: "guest checkout failed"
```

When proof is unnecessary use `Required: no` and `Reason: "explanation"`. Direct/manual/label starts require these explicit sections and numbered criteria. Missing, duplicated or malformed instructions create a durable `specification_contract` question before setup. Edit the GitHub issue, select **Adopt saved specification**, then resume. Ordinary answers, retries and label polling cannot waive this requirement. A linked issue changed since planning approval also requires explicit adoption. Adoption reads explicit issue fields; it does not ask an agent to derive a new checklist.

Acceptance checklists support at most 100 criteria, using the same shared limit as implementation reports and reviewer assessments. Oversized checklists are rejected before a planning proposal can change; oversized directly started issues pause for clarification before setup. Issue parsing accepts LF, CRLF and mixed line endings, including operation-marker removal. Canonical comparison tolerates transport line-ending changes without rewriting the saved approved ticket or escaped literal regression signatures/reasons.
