# Durable Factory — Implementation Roadmap

Status: stages 1–8 complete under the agreed stage 8 scope, including real isolated development, checks, independent review, reconciled GitHub PR publication, and ready-label admission. Verification uses deterministic models, disposable Git repositories, and fake GitHub transport. Stage 8 adds manual local operation, inspection and merged-run cleanup; backup/restore and startup at login are explicitly deferred by agreement; account-backed access is not claimed by offline evidence.

This roadmap accompanies [ARCHITECTURE.md](ARCHITECTURE.md). It describes implementation order, dependencies, deliverables, and the evidence required to finish each stage. The architecture remains the detailed behavior reference. The subsequently agreed Bun frontend tooling and GitHub token setup are recorded here; this roadmap does not rewrite the architecture document.

## Combined stages 1–2 delivery

The first implementation combines the local settings application with focused Pi integration/recovery checks. The service uses Pi Durable documents in SQLite; the browser configures the repository, execution commands/timeouts, independent role models, and private connection credentials. Subscription sign-in and stored connection status are available through interactive diagnostics. No chat or development workflow is implemented yet.

The offline suite exercises real storage, abrupt termination during a streamed model turn and safe/unsafe tools, submission identity, queued follow-ups, ownership recovery, schema protection, credential privacy, and versioned local API behavior. Browser verification covers settings persistence, stale saves, secret-free responses, service restart, and responsive layout. See [README.md](README.md) for commands and [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for observed results and limitations.

Stages 1–2 are **complete**: the pinned Pi integration, offline recovery evidence, local service, settings application, and private credentials meet their completion gates. The [future workflow transition table](docs/WORKFLOW.md) is recorded before scheduler work begins.

## Agreed constraints

- React and TypeScript for the browser application, with plain CSS. No CSS framework, component library, or chat library.
- Bun for dependency management and running Vite frontend development/build commands. Keep the Pi Durable backend on Node 24 initially. In development, Vite proxies API requests; in production, the Node service serves the built frontend and API.
- Pi Durable and pi-ai for conversations, tools, provider access, persistence, and recovery. Pin a compatible package set after the feasibility checks.
- Support Requesty API access and Pi's supported OpenAI and Anthropic subscription authentication. Configure models separately for planning, development, and review. Retain all three in the first-version target.
- A GitHub token entered in application settings, privately stored on the service side. No dependency on the user's GitHub CLI login.
- One configured repository and one active development run. Preserve run/repository identities and isolated worktrees so expansion does not require redesigning the workflow.
- Developer → required checks → independent reviewer → ready-for-review PR. Allow the initial attempt plus three repair cycles. The user merges.
- Stable submission/operation IDs, explicit intervention records, and external-effect reconciliation. Closing the browser never cancels a development run.

## Build and verification approach

Implement the stages in order. Each stage must meet its completion gate before dependent work relies on it. Develop the relevant UI alongside the corresponding backend capability rather than constructing the entire interface first.

Use deterministic fake models, fake GitHub responses, controlled commands, disposable repositories, and real durable storage for the offline suite. Add recovery tests with each capability; do not postpone them to final hardening. Automated verification uses simulated providers and does not require accounts or paid model calls. Never use a production repository for destructive recovery tests.

Cross-cutting rules for all stages:

- Keep stage transitions explicit and backed by stored outcomes rather than agent prose.
- Preserve effective role settings, specification snapshots, validation identity, and evidence.
- Treat a lost response as uncertain until reconciled; a repeated request must not create another workflow or external object.
- Record observed compatibility and limitations. Do not infer successful authentication, model access, or tool behavior from a catalog entry alone.

## Stage 1 — Prove Pi integration and recovery

**Status:** Complete.

**Objective:** Prove the agent runtime and storage behavior before building application abstractions around it.

**Dependencies:** A supported local runtime and access to candidate Pi packages.

**Deliverables:**

- A minimal Node harness using Pi Durable, SQLite, a deterministic fake provider, and controlled read-only/mutating tools.
- A pinned compatible Pi Durable/pi-ai dependency set, with a short compatibility record.
- Requesty provider registration, Pi-owned subscription sign-in, and a private credential store supporting automatic token refresh; deterministic tests cover persistence and credential safety.

**Recovery verification:** Terminate the process during a model turn and during replay-safe and unsafe tools. Reopen the same storage; inspect queued inputs, partial results, replay decisions, and side effects.

**Completion gate:** Conversation state survives restart, safe work resumes correctly, and uncertain unsafe effects surface for handling rather than silently running twice. No separate Codex or Claude Code worker is introduced by assumption.

## Stage 2 — Establish the frontend and backend foundation

**Status:** Complete.

**Objective:** Create a small application skeleton with durable configuration and clear ownership boundaries.

**Dependencies:** Stage 1's proven package set and storage behavior.

**Deliverables:**

- Bun + Vite React/TypeScript frontend and a Node service, with a framework-independent shared TypeScript contract/client boundary.
- Local API versioning, typed errors, health/readiness reporting, and production serving of the built frontend.
- Service-owned SQLite application documents, configuration records, schema versioning, private credential storage, and a configurable runtime-data directory outside source and target repositories.
- Initial repository configuration, provider/role settings, localhost request protections, and redacted structured logs.
- A single stored source of scheduling/workflow truth; avoid a second independent queue database. Define the lifecycle transition table before implementing scheduler behavior.

**Recovery verification:** Save configuration, restart the service, verify persistence and exclusive storage ownership, and test startup with unavailable credentials or a newer unsupported schema.

**Completion gate:** The browser reaches the service, configuration persists, readiness reflects startup recovery, and secrets do not appear in responses or logs. Application upgrades do not replace runtime data.

## Stage 3 — Deliver durable web chat

**Status:** Complete. Planning chat is the home screen; settings remain available at `/settings`. The shared client handles ordered SSE snapshots/updates, heartbeat recovery, history pagination, and submission reconciliation. Offline tools cover detailed transcript rendering; stage 4 adds production planning tools. At stage 3 completion, developer steering and reviewer restrictions had contract/fixture coverage; stages 5–7 now connect them to run execution. See [docs/CHAT.md](docs/CHAT.md) and [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

**Objective:** Make the persistent agent useful from the browser, including detailed inspection of its work.

**Dependencies:** Stage 2's service, configuration, and shared contract.

**Deliverables:**

- Saved conversation navigation, a message composer, streaming replies, paginated history, and expandable tool inputs, commands, live output, and results.
- Stable request/submission IDs, acknowledgement and completion states, queued follow-ups, input withdrawal, explicit developer steering, and interruption.
- Snapshot-plus-update rendering, heartbeats, bounded stream buffers, reconnect backoff, and browser connection status separate from execution status.
- Framework-independent transcript reduction and a minimal plain-CSS React shell. Do not replace the detailed transcript with only an activity summary.

**Recovery verification:** Close and reopen the browser, break the event stream, retry an uncertain send, and restart the backend while work or queued input exists. Exercise slow clients and withdrawal races.

**Completion gate:** Accepted messages, tools, and results restore without omission or duplication; unsent input remains recoverable; browser closure does not stop the agent. The transcript is usable before additional workflow UI is added.

## Stage 4 — Complete planning → GitHub issue

**Status:** Complete. Planning tools inspect current repository files and scoped history, persist revisioned tickets, and propose issue creation in chat. Affirmative replies authorize the proposed revision through service checks. The service-owned GitHub adapter validates access and reconciles issue operations using hidden markers. Offline tests cover duplicate approvals, rejection/uncertainty, pagination, stale approval, upgrade, token errors, repository boundaries and filters, and SIGKILL after issue creation. Browser verification covers ticket display, chat approval, retry, restart, GitHub validation, and mobile layout. Stage 4 itself did not implement development admission; stages 5–7 now provide it. See [the planning contract](docs/PLANNING.md) and [compatibility evidence](docs/COMPATIBILITY.md).

**Objective:** Turn an agreed planning conversation into exactly one linked GitHub issue.

**Dependencies:** Stage 3's durable chat and Stage 2's private configuration storage.

**Deliverables:**

- Repository registration, read-only planning context, and a persistent ticket containing goal, scope, acceptance criteria, and validation approach.
- GitHub token settings and connection/capability validation for the selected repository. Prefer a fine-grained repository-scoped token where supported.
- An explicit chat-driven issue-creation operation, with a durable operation ID, reconciliation marker, and returned issue link.
- A service-owned GitHub adapter; issue creation alone must not start development.

**Recovery verification:** Simulate a timeout after GitHub creates the issue but before the app records its ID. Restart and find the existing issue by operation identity. Exercise expired tokens and retries.

**Completion gate:** An explicit user instruction creates one issue from the agreed ticket and persists the link. Repeated submissions or ambiguous responses do not create duplicates. No development starts implicitly.

## Stage 5 — Implement the workflow using deterministic fake agents

**Status:** Complete. Explicit simulation mode runs durable Pi stage tasks against scripted adapters, with a serial queue, captured settings/specification, revision-bound evidence, interventions, repair accounting, deadline/cancellation handling, and an activity inspector. Offline and browser evidence includes forced termination at validation, repair, question, and publication boundaries. Stage 5 establishes simulation only; stages 6–7 add real execution/publication adapters with offline verification. See [the workflow contract](docs/WORKFLOW.md) and [compatibility evidence](docs/COMPATIBILITY.md).

**Objective:** Validate orchestration independently of unpredictable model behavior.

**Dependencies:** Stage 4's linked issues and existing durable configuration/client infrastructure.

**Deliverables:**

- Shared run admission for manual starts, a durable serial queue, and the complete developer/check/reviewer/publication state machine using fake adapters.
- Run-owned tasks/conversations, stable stage attempts, repair counting, source/evidence identity, and explicit transition prerequisites.
- Capture effective setup commands, required checks, and operation timeouts per run. Settings updates affect future runs; explicit adoption records a configuration revision and invalidates affected evidence.
- Exercise developer input at stage boundaries, publication-time rejection of new implementation input, post-PR new-run requirements, and repair accounting that distinguishes user guidance from failure-triggered fixes.
- Use deterministic deadlines and cancellation adapters to model late provider results, confirmed process termination, and an unresolved termination blocker that retains the execution slot.
- Durable questions and answers, stale-update protection, pause/resume/cancel propagation, and correct execution-slot ownership.
- Minimal activity and intervention UI sufficient to inspect and operate the workflow.

**Recovery verification:** Force termination at stage boundaries, during a repair, and while waiting for an answer. Test duplicate starts, duplicated callbacks, stale/conflicting answers, and cancellation while a child task is active. Change settings mid-run and explicitly adopt configuration; verify captured values and evidence invalidation. Inject guidance during checks/review and around publication admission, deadline expiry, late provider results, and an unconfirmed termination outcome.

**Completion gate:** Scripted success, check failure, reviewer rejection, ambiguity, provider failure, and repair exhaustion all transition correctly. Restart does not count another repair or record another successful attempt. Settings cannot silently alter an admitted run; user guidance does not reset or evade repair accounting. Late input cannot bypass validation or trigger edits after publication starts. Paused work releases its slot only after active work is quiescent; an unconfirmed termination retains the slot, and resumption reacquires it after confirmed release.

## Stage 6 — Add real development, checks, and independent review

**Status:** Complete. Real Pi agents use role-scoped worktree/candidate tools, supervised commands, baseline/check gates, structured review, and captured commit identity. Offline cases cover generated content, source changes, steering/withdrawal, provider deadlines, detached children and forced service termination. Worktree isolation is an application boundary, not an OS sandbox.

**Objective:** Produce a verified local implementation from an issue.

**Dependencies:** Stage 5's tested orchestration and the existing provider registration and credential integration.

**Deliverables:**

- Per-run branch/worktree creation, configured dependency/setup commands, base-branch selection, commit identity, required check commands, and timeouts.
- Baseline checks before development; pre-existing failures pause with evidence instead of being silently exempted.
- Real developer tools scoped to the run worktree and a fresh reviewer conversation for each reviewed revision, with role-specific tool sets.
- Stop automatic developer mutations and confirm mutating tools/processes are quiescent before checks/review. Persist structured review results and check/review evidence tied to the intended commit's Git tree/content identity and effective configuration revision. Include generated files intended for the commit; exclude only disposable build output that will not be committed. Source changes invalidate affected evidence; use existing run/evidence records rather than another snapshot subsystem.
- Explicit specification/configuration adoption and developer steering behavior. A message cannot introduce edits during validation without returning through the development and validation gates. Use captured commands/timeouts, repeat setup and baseline checks after adopting setup changes, and preserve repair accounting for guidance versus failed-check/reviewer fixes.
- Apply configured deadlines to real setup/tool/check commands and provider requests. Bound cancellation, terminate service-owned local process groups, account for children, and keep the execution slot blocked if termination cannot be confirmed.

**Recovery verification:** Interrupt real tools in a disposable repository, preserve the worktree, reconcile processes before resuming, and verify the original user checkout remains untouched. Exercise configured deadlines and confirmed/unconfirmed child-process termination. Change files during or after validation, including generated files intended for the commit, and ensure old evidence cannot authorize publication. Changing disposable output alone must not invalidate source identity. Change effective configuration explicitly and verify affected evidence is invalidated.

**Completion gate:** An issue reaches a validated local change using actual developer/check/reviewer components. Developer mutations stop during validation, and only evidence for the same intended commit content and configuration revision can pass. Baseline/setup errors, malformed reviews, ambiguous requirements, and exhausted repairs pause usefully. Real timeout/cancellation handling cannot release the execution slot while mutating processes remain unaccounted for.

## Stage 7 — Publish PRs and add GitHub label triggers

**Status:** Complete. Service-owned commit/push/PR operations use persisted identity, private credential delivery, base integration and commit-tree verification. Offline Git and fake-GitHub cases cover lost PR responses, startup/manual label races, commit/push/PR crashes, hook revalidation, and stable new-run retries. No live account write or paid call was used.

**Objective:** Complete the handoff to GitHub and support unattended admission through the agreed label.

**Dependencies:** Stage 6's validated change, Stage 4's GitHub adapter/token, and Stage 5's admission/recovery logic.

**Deliverables:**

- Service-owned commit, HTTPS push, and non-draft PR creation referencing the issue, with validation and review summaries.
- Push authentication using the configured token without storing it in remote URLs, ordinary logs, or the agent command environment.
- Fetch/check the target branch before publication, integrate base changes when needed, and rerun validation. Immediately before publication, verify source identity and effective configuration revision against check/review evidence. Handle or withdraw undelivered developer input first. Stop automatic developer edits once publishing starts; reject new implementation input during publishing or after PR readiness, with an explicit new run required for post-PR implementation. Verify the resulting commit tree before pushing, including changes made by commit hooks; changed content requires validation again. The published commit must contain the validated source tree. Credential replacement can resume an interrupted publication without changing captured execution configuration.
- Reconcile uncertain pushes and PR creation by branch, revision, and operation identity.
- Poll `agent:ready` issues every 30 seconds and on startup through the same admission path as manual starts. Persistent labels cannot restart finished work automatically.

**Recovery verification:** Lose the push/PR response after the remote effect succeeds, restart between commit/push/PR steps, and deliver simultaneous manual/label triggers. Simulate a moved base branch and token failure. Inject changed source/configuration immediately before publication and developer input on both sides of the publication transition; verify stale evidence blocks publication and late input never schedules automatic edits.

**Completion gate:** One issue produces one run and one ready-for-review PR under duplicate triggers and interruptions. Evidence matches the published change and effective configuration revision, with an identity check immediately before publication. Pending developer input is resolved before publishing; input during publication or after PR readiness cannot trigger automatic developer edits. No automatic merge occurs; no future publication starts after cancellation is observed.

## Stage 8 — Finish local operation, inspection, and merged-run cleanup

**Status:** Implemented; verification is recorded in docs/COMPATIBILITY.md. Backup/restore and startup at login are deferred by agreement. The original archive/backup deliverables are replaced with automatic permanent cleanup after merge.

**Objective:** Make the first version usable locally, with manual Bun startup and safe automatic removal of completed work.

**Deliverables:**

- Complete the inspector with active commands/tools, captured role models, repair counts, pending questions, recovery events, reported token usage and explicitly labelled cost estimates/unavailable values.
- Retain `bun run start` after building, graceful shutdown/recovery, and settings/diagnostic instructions for reconnecting all three model connections or replacing the GitHub token. No login service is installed.
- Reject closed GitHub issues through all real admission paths. Poll original PR identities on startup and every 30 seconds; clean up only after confirmed merge and issue closure.
- Persist cleanup intent, wait for idle maintenance and confirmed process quiescence, verify worktree/branch ownership/content, and remove all run-owned files and records. Delete the planning conversation only if unshared. Keep settings, credentials, unrelated runs and GitHub objects.
- Close Pi under exclusive ownership before schema-version-checked SQLite maintenance. Purge scoped entries/tasks/submissions/documents and historical session revisions, including agent-operation records and admission receipts. Retry interrupted filesystem phases safely; show blocked cleanup in the inspector. No archive or permanent local completion record remains.

**Recovery verification:** Exercise browser reconnection, shutdown/restart, merge/issue state delays, changed worktrees, active processes, partial cleanup and incompatible storage. Use deterministic providers, disposable repositories and fake GitHub transport, with no account-backed writes or paid calls.

**Completion gate:** Plan → issue → failed check → repair → independent review → PR, including a restart, followed by confirmed merge/closure and automatic local cleanup. Shared planning, other runs/settings/credentials survive. Closed issues cannot restart after local deletion. One active development run and human-only merge remain enforced.

## First-version completion checklist

- [x] All eight stage gates have recorded results.
- [x] Offline workflow/recovery tests pass without paid model calls.
- [x] Requesty, OpenAI subscription, and Anthropic subscription connections and private credential handling are implemented.
- [x] The user can inspect and steer development while preserving the agreed specification and validation rules.
- [x] Manual and label starts converge on the same durable admission operation.
- [x] Interrupted external operations reconcile without duplicate issues or PRs.
- [x] Manual local startup, merged-run cleanup and explicit intervention paths are documented and exercised; backup/restore and startup at login are deferred.
- [x] The implementation retains the architecture's one-repository, one-active-run, human-merge boundaries.
- [x] Per-run check/setup/timeout configuration remains stable unless explicitly adopted, with affected evidence invalidated.
- [x] Validation/publication uses the same intended commit content, including committed generated files, and automatic developer mutations stop during validation/publication.
- [x] Late developer input follows stage-boundary rules and never silently resets or bypasses the repair budget.
- [x] Unconfirmed process termination remains visible and retains the execution slot until reconciled.

## Combined handoffs and evidence release

Adds explicit approved issue criteria/regression requirements, developer implementation reports, criterion-based independent review, supervised before/after regression proof, a chronological inspector and deterministic frozen PR descriptions. New real runs capture contract version 2; older runs retain legacy behavior. Verification covers pure contract validation, temporary-repository integration, forced termination, browser rendering/reconnect, and existing workflow/cleanup regressions. No account-backed model/GitHub evidence is implied by offline testing.
