# Durable workflow contract

Stages 5–7 implement this contract with deterministic simulation and real repository/provider/publication adapters. Pi tasks/documents remain the only durable source of workflow truth. One service owns storage and only one development run may hold the execution slot.

| Current state | Trigger / prerequisite | Next state and required action |
| --- | --- | --- |
| No run | Explicit start or ready-label admission | Queued; deduplicate by repository/issue identity and capture specification, models, execution configuration and base revision |
| Queued | Execution slot acquired | Developer; establish isolated workspace, setup and passing baseline before mutations |
| Developer | Developer stops; mutations confirmed quiescent | Checks; record intended source identity and effective configuration revision |
| Checks | Every required check passes for that identity/configuration | Reviewer; start an independent inspection-only conversation |
| Checks | Required validation fails; repair budget remains | Developer; consume the next repair cycle when repair work starts |
| Reviewer | Structured pass for the same source/configuration | Publication admission; require stopped mutations, no undelivered developer input, current base and matching evidence |
| Reviewer | Changes requested; repair budget remains | Developer; consume the next repair cycle when repair work starts |
| Checks / Reviewer | Initial attempt plus three repair cycles exhausted | Needs input; retain evidence and require explicit recorded continuation |
| Checks / Reviewer | Developer guidance, source change or explicit specification/configuration adoption | Return to Developer at a controlled boundary; invalidate affected evidence; retain repair count |
| Before publication | Base changed | Integrate changes and repeat validation before publication |
| Publication admission | All gates pass atomically | Publishing; reject new implementation input, verify committed tree, reconcile commit/push/PR operations by stored identity |
| Publishing | Push and one non-draft PR confirmed | PR ready; human merge only; implementation changes require explicit new run |
| Publishing | Ambiguous remote response | Remain pending reconciliation; never blindly repeat external creation |
| Any active stage | User pause, question, provider/auth failure or infrastructure blocker | Pausing; stop scheduling, interrupt/account for children, then Paused / Needs input only after quiescence |
| Any active stage | User cancels | Cancelling; stop future work/publication and propagate cancellation; then Cancelled only after quiescence and recording uncertain effects |
| Pausing / Cancelling | Child termination cannot be confirmed | Termination blocker; retain execution slot until inspection confirms no prior mutating work |
| Paused / Needs input | Valid answer/resume against expected revision | Queue for execution slot; resume existing attempt after reacquisition |
| Any unfinished stage | Service restart | Inspect/reconcile existing attempt before scheduling; preserve attempt identity and repair count; increment recovery count only |
| Completed / Cancelled | Explicit new-run instruction | Admit a new run; persistent labels and duplicate requests cannot restart it |

Commit outcomes before scheduling the next stage. A developer statement does not authorize a transition. User guidance, retries and recovery do not reset repair accounting; guidance accompanying a failed-check/reviewer repair still consumes its normal cycle. Setup changes require setup and baseline checks again. Adoption preserves any outstanding setup/baseline prerequisite, even when the new setup commands are unchanged. Publication-time source or configuration changes invalidate evidence rather than bypassing validation. Active external requests may finish after cancellation; record their outcome without claiming they were undone.

## Simulation and durable execution

`DURABLE_FACTORY_WORKFLOW_MODE=simulation` enables fake workflow starts. Without an explicit override, real execution and label polling activate when configuration is complete. `disabled` suppresses starts and polling. Real admission requires commit identity, repository/base, development/review models and stored connections, and a non-empty required gate. The service’s `workflow` injection accepts a scripted adapter and clock for offline tests. Adapters expose stage execution, source/base/quiescence inspection, latest specification, cancellation confirmation, and publication reconciliation. Reconciliation may confirm a result, confirm no publication effect, or retain uncertainty; absence of a result alone never permits blindly repeating an uncertain effect. The built-in adapter has no external side effects.

The `factory.workflow` session document holds run admission receipts, FIFO ordering, the execution-slot owner, run snapshots, stage attempts, evidence, interventions and control decisions in the existing Pi SQLite storage. `factory.workflow-stage` Pi tasks execute admitted stages. There is no separate queue database or independent model loop. Related stage outcomes, evidence, next-stage tasks and slot changes commit atomically. Task identity fences old callbacks, including callbacks from a task replaced after a safe pause. Expected revisions reject stale controls; operation receipts are checked first for idempotent retries.

A process crash retains the current stage attempt ID, task ID, start timestamp, deadline and repair count; recovery increments its recovery count. Startup reconciles old work before Pi scheduling resumes. Cancellation remains the stop target through concurrent chat interruption and restart; a later pause cannot make cancelled work resumable. A safely paused attempt keeps its logical ID on resumption, records its replacement Pi task ID and receives a fresh active-operation deadline after reacquiring the slot. Human-answer waits have no active execution deadline. A missing adapter blocks active recovery and retains the slot until compatible inspection confirms quiescence. Faulted tasks without a committed stage outcome require intervention.

Source identity is synthetic for simulation runs. Each fake developer output may establish a new identity; checks/review use the same identity plus effective configuration/specification revisions. Source changes invalidate evidence. Base changes return through development and validation without consuming a failure repair. Publication admission checks evidence, pending/withdrawn input and quiescence in the same transaction that closes implementation input. A publication content mismatch cannot be promoted to readiness by reconciliation. Real runs use a temporary service-owned Git index and tree identity, including selected ignored generated additions. Tracked files remain included even when ignored. Source changes invalidate active evidence; historical real evidence remains inspectable. Submodules fail closed. Commit hooks and base refresh cannot bypass validation.

## HTTP and shared client

All routes retain `/api/v1`, the existing localhost/origin protections, CSRF checks and typed JSON errors. `WorkflowClient` and `WorkflowReducer` are framework independent.

| Method and route | Behavior |
| --- | --- |
| `GET /runs` | Capability/mode, document revision, slot owner and ordered run snapshots |
| `POST /runs` | `{conversationId, operationId, newRun?}`, `{issueNumber, operationId}`, or `{sourceRunId, operationId, newRun:true}`; exactly one selector; shared issue admission or explicit new run |
| `GET /runs/:id` | Full run snapshot, including attempts, input, evidence, decisions and interventions |
| `POST /runs/:id/commands` | `{operationId, expectedRevision, action, ...}`; revision-checked operation |
| `GET /runs/events` | Initial snapshot and ordered replacement updates; API version, stream ID and increasing sequence; 15-second heartbeat |

Paused publication may be reconciled without resuming execution. Confirmed publication or confirmed absence resolves its uncertainty while preserving the paused state; explicit resume is still required.

Command actions are `pause`, `resume`, `cancel`, `answer`, `continue`, `adopt_configuration`, `adopt_specification`, `reconcile`, and `revalidate`. `revalidate` is restricted to stopped real publication before any remote write; it repeats checks and fresh review with implementation input still closed. Changing the target base branch requires a new run. Answers additionally require `interventionId`, `interventionRevision` and `answer`. An identical operation ID/payload is idempotent; conflicting reuse fails. Explicit new-run buttons persist their operation ID across uncertain responses and reloads; a confirmed response clears that pending record. Continuation explicitly grants one additional repair. Adoption requires a paused, needs-input or queued run and cannot change repository identity. Adoption invalidates evidence, preserves repair accounting and records the decision. The simulation specification adapter supplies the adopted ticket; the default retains the admission snapshot.

Developer input and withdrawal use the existing chat routes. Publication closes new input atomically; previously accepted retries remain idempotent. A queued/active/paused run is returned for duplicate issue starts. A completed/cancelled issue is also returned unless `newRun: true` explicitly admits a new run; persistent labels cannot request it. Real mode polls open `agent:ready` issues at startup and every 30 seconds, with pagination, no overlapping polls, rate-limit backoff, and shared deduplication. Persistent labels never request explicit new runs.

The `/runs` inspector separates browser connection status from execution status and exposes simulation labels, queue/slot ownership, stage results, pending questions, captured commands/timeouts/models, repairs and conversation links. Streaming bounds the response buffer to 1 MiB and disconnects slow clients; the client reconnects with a fresh snapshot, detects sequence gaps and watches heartbeat loss. Workflow event snapshots currently contain the run collection; archival and retention are stage 8 work.

## Real execution and recovery

Real run records add issue title/body/update snapshots, workspace path/branch/base and selected ignored files, detailed command results/artifact IDs, structured reviewer findings, historical evidence, and commit/push/PR operation fields. Commit identity is captured with settings. Settings migrations add empty identity without selecting a model or enabling incomplete installations. A saved run's mode selects its compatible adapter; synthetic and Git identities are never interchangeable.

`factory.processes` and `factory.agent-operations` documents in the existing Pi database retain command and agent operation identities. Command launch persists intent, starts a waiting supervisor, commits its PID/start identity, and only then authorizes execution. An intent that never reached authorization cannot execute after restart. Process-group inspection, observed descendants, and inherited ownership markers account for ordinary detached children. Deliberately clearing markers and escaping supervision is outside this application boundary, which is not an OS sandbox. Inspection failures retain the slot. Replayed task callbacks are fenced; unsafe tools never replay automatically.

Startup restores models/tools before reconciling old commands, agent tasks, workspace effects, and publication. Workflow stage tasks wait behind an activation barrier. Chat recovery no longer independently resumes the harness. Interrupted real work retains logical attempt/repair identity, increments recovery count, and requires explicit inspection/continuation. Provider deadlines apply per generation and compaction request; human waits do not expire. Real steering is placed at Pi's post-tool hook, while follow-ups wait for the developer boundary. Reviewers accept no ordinary input.

Checks retain each command's real exit code, duration and paginated output at `GET /api/v1/runs/:id/artifacts/:commandId?offset=…`. Paths are resolved from stored operation records, never browser input. Reviewer tools read the complete candidate tree/diff, including selected ignored additions. Publication refreshes the base, validates the final commit tree, pushes only the owned branch over HTTPS, and reconciles PRs in all states using a durable marker. Uncertain PR creation never permits another POST solely because a search found nothing. Confirmed remote results remain recorded after cancellation.

## Stage 8 completion cleanup

Real admission resolves GitHub issue state and rejects closed issues, including manual and planning-chat starts. A completed local record is not required to enforce this rule.

The service polls recorded original PRs every 30 seconds and on startup. Cleanup requires a closed PR with explicit `merged=true`, the recorded number/head/repository/branches, and a closed linked issue. A closed unmerged PR is retained. Errors/rate limits defer polling.

`WorkflowRun.cleanup` reports pending or blocked cleanup with a reason. Cleanup waits for idle admission/agent execution, checks supervised processes and verified worktree content, closes the Pi harness under exclusive ownership, then removes run-owned worktrees/local references and artifacts. SQLite maintenance removes scoped records and historical payloads from workflow, catalog, process and agent-operation documents. Filesystem operations are idempotent and precede the atomic database purge, so persisted intent survives interruption. Before the first push, publication captures `publication.cleanupIgnored`, a digest and file count for ignored files. Cleanup verifies it without following symlinks or running Git filters; additions or changes block deletion. Older runs without this baseline retain any ignored files rather than adopting their current state. Other runs and shared planning conversations remain. No remote deletion, archive or permanent completion marker is created.

`GET /api/v1/runs/:id/inspection` returns active command identities/state plus conversation tool state and provider-reported usage. Conversation scans are bounded to 10,000 entries and report partial history. Cost estimates are available only for positive reported Requesty API costs; subscription usage is not treated as billing. The selected inspector refreshes this detail every five seconds. Maintenance ends existing streams; clients reconnect through the existing snapshot protocol. Storage reopening has up to three attempts with short backoff even while readiness is blocked. Partial initialization is closed before retry; an uncertain close disables further automatic attempts. Exhaustion exposes a fixed actionable readiness/API error, and successful recovery clears it. Shutdown cancels retry timers and keeps ownership until storage closes.

Startup remains manual (`bun run build`, then `bun run start`). Backup/restore and startup at login are deferred.

## Stronger handoffs and evidence contract

New real runs capture `contractVersion: 2`. Missing versions retain legacy execution behavior, even after restart; history is not backfilled with invented reports or criterion assessments. Simulation retains its existing deterministic contract.

The developer-only `submit_implementation` tool saves a candidate-bound report with summary, exact changed paths, all approved criterion IDs, validation performed, concerns and reviewer notes. Changed paths come from the actual base/candidate tree diff, with renames represented by both paths. Added, deleted and selected ignored files are included. Tool-task receipts make replay idempotent. A final model response without a matching report pauses before checks. All submitted reports remain in `WorkflowRun.implementations`, committed atomically with tool receipts in the existing agent-operation document. The developer boundary separately decides whether the final report may advance the run; interrupted and superseded submissions remain inspectable. Repairs receive prior reports, failures and human answers in the same developer conversation.

`submit_review` adds one assessment per approved criterion, with `met`, `unmet` or `needs_input`, explanation and candidate-file references with optional line numbers. A met criterion needs at least one existing nonempty code/test reference. The service validates identifier coverage, duplicate IDs, paths, line bounds and verdict consistency; the independent reviewer judges whether the references substantively support the requirement. Passing tests alone cannot authorize approval. Reviewer conversations stay fresh and inspection-only.

Reports, review and regression proof are authoritative only for their captured candidate/configuration/specification. Source changes invalidate validation. Commit-hook changes can therefore leave a new-contract report stale: service-only revalidation cannot manufacture a developer report, and publication remains blocked; start an explicit new run after preserving the change. Legacy hook revalidation retains its prior behavior.

### Regression substep

When the approved issue requires proof, checks create two owned detached Git worktrees from immutable snapshot commits: the base plus only the approved test/fixture files, and the complete candidate tree. Snapshot commits are internal Git objects, not extra workflow branch commits. Both snapshots run captured setup commands separately. The approved command must fail on the base with its literal signature and pass on the candidate; the normal required gate must also pass. Setup/test mutations of snapshot source invalidate proof. Ignored disposable output is allowed and inventoried for cleanup.

`RunEvidence.regression` binds the base, source, revisions, result and supervised command artifacts. Behavioral failures use the existing repair count; infrastructure failures, timeouts and interruptions pause for inspection. Ownership records in `WorkflowRun.proofWorkspaces` precede worktree creation, retain per-command results, and survive restart. Unsafe commands never replay automatically. Interrupted snapshots without a final inventory are deleted only if their Git state is clean; otherwise preserve unexpected files and restore the recorded snapshot before retrying. Inventory mismatches, repository/head changes or uncertain process termination block removal. Successful proof snapshots are removed after fingerprint verification; merged cleanup also checks all recorded proof resources.

### Inspection and publication

The chronological timeline combines existing stage attempts, human decisions, interventions and timestamped recovery events. Elapsed durations include waits/recovery and are not active execution time. Repairs link to failed evidence. Reports and evidence distinguish current and superseded records; provider usage remains conversation-wide.

PR bodies are built deterministically from the current report, approved criteria, accepted review, required commands, regression result and remaining concerns. Publication persists `publication.payload` before setting the PR request to sending. Retries use that frozen payload; uncertain creation still requires reconciliation, and no PR is recreated merely because lookup found nothing. The closing issue reference and durable operation marker remain.
