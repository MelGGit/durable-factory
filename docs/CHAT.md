# Durable chat contract — stages 3–7

The shipped frontend now consumes [AG-UI observation views](AG_UI.md). The original endpoints below remain available; the AG-UI POST/run endpoint delegates to the same durable admission and role boundaries.

The Node service owns one Pi harness in `factory.sqlite`. Configuration, conversation catalog/metadata, admission receipts, submissions, transcripts, and execution share that storage and its existing exclusive process ownership. A conversation and its metadata are created atomically. There is no independent application agent loop or queue database.

## HTTP interface

All routes use `/api/v1`, existing localhost/origin protections, and JSON error bodies. Mutations require the current session's CSRF token. The shared client refreshes the session once after a forbidden mutation response, then retries the identical action. Text input is limited to 32 KiB; requests retain the service's 64 KiB JSON-body limit. Conversation titles are 1–120 characters. IDs are opaque to browser code.

| Method and route | Behavior |
| --- | --- |
| `GET /conversations` | Saved conversation summaries, newest created first |
| `POST /conversations` | `{title, requestId}`; atomically create an independent planning conversation with captured repository/model settings; repeat requests return the same conversation |
| `GET /conversations/:id/history` | Newest page in ascending display order; optional `cursor` and `limit` (default 50, maximum 100) |
| `POST /conversations/:id/submissions` | `{content, requestId, mode?}`; default `followUp`, return 202 after durable admission without waiting for completion |
| `GET /conversations/:id/submissions?requestId=…` | Reconcile an uncertain send; 404 means there is no admission receipt |
| `POST /conversations/:id/submissions/:submissionId/withdraw` | `{}`; withdraw unconsumed input, idempotently; consumed input returns a conflict |
| `POST /conversations/:id/interrupt` | `{}`; return 202 while Pi aborts active work and withdraws queued inputs |
| `GET /conversations/:id/events` | SSE handshake snapshot followed by ordered update frames |
| `GET /conversations/:id/artifacts/:artifact?offset=…` | UTF-8 output page, at most 64 KiB, plus optional next byte offset |

History cursors belong to a conversation and use an exclusive entry-ID boundary so newer commits cannot shift older pages. Both pre-compaction and active history are available. Output IDs are service-created identifiers, never paths supplied by the browser. Tool logs live under the protected runtime data directory; long transcript content can be read directly from its persisted entry. Output is retained after interruption and restart; cleanup/retention management remains stage 8.

## Admission and role boundaries

A durable receipt records request content/mode before Pi admission. Pi deduplicates by conversation/request ID. Receipt recovery completes admission after a crash between those commits; a repeated ID with different content or mode returns a conflict. Receipts are not a second execution queue: Pi submissions determine running and terminal outcomes. Conversation creation has its own stable request ID.

States are `acknowledged`, `queued`, `running`, `completed`, `interrupted`, `failed`, and `withdrawn`. Failed input retains its evidence and requires explicit new input; queued follow-ups retain Pi's native failure behavior. There is no provider fallback. Interruption remains visible until Pi reports idle, and blocks new input during that interval. Restart reconciles a persisted interruption before normal scheduling.

Production exposes planning creation and ordinary follow-ups with the restricted tools described in [the planning contract](PLANNING.md). Role capabilities define developer-only `steer`, delivered at Pi's post-tool boundary, and reject arbitrary reviewer input. Developer input also requires an injected workflow authorization callback; no HTTP parameter grants that authorization. Standalone developer/reviewer conversations are not exposed in the browser. Fixtures install controlled tools and create role-specific conversations directly through the service adapter.

## Streaming and browser recovery

Each connection attaches a Pi watch before capturing its first snapshot, so later committed updates remain observable. Frames contain `apiVersion`, a new `streamId`, increasing `sequence`, `type` (`snapshot` or `update`), and a bounded replacement snapshot. This is an application view, not the raw Pi/Chord wire format. Custom admission/interruption document changes are watched as well.

Snapshots normally contain the newest 50 active entries; large history windows shrink to keep frames below the output-buffer ceiling. Older history is loaded explicitly and merged by stable entry ID. Partial replies and tool output replace existing live state rather than appending duplicates. The browser rejects sequence gaps, unknown streams, and unsupported API versions. Every reconnection attaches a fresh authoritative snapshot; no `Last-Event-ID` replay is required. The browser backfills durable history to its last displayed entry before merging a fresh stream, including gaps larger than one page. Missed windows during the same stream are backfilled as well. A failed backfill triggers reconnection; history reads use both the selected-view cancellation signal and the stream watchdog signal. The shared client awaits snapshot consumers to preserve delivery order. Switching conversations cancels history reads and invalidates all state updates from the previous view, including delayed pagination responses.

Heartbeat comments arrive every 15 seconds. The shared client treats 45 seconds without traffic as connection loss and reconnects with jittered exponential delays capped at 30 seconds. Socket output exceeding 1 MiB closes that stream; Pi watches also bound pending frames. Tool/live previews are capped at 64 KiB, with complete logs available separately. Browser disconnection never aborts execution.

The browser stores each conversation draft and pending request as a separate local-storage record under the `factory.chat.v1` namespace. Tabs update only the records they change and synchronize draft/pending changes through storage events; a stale tab cannot replace another conversation’s saved data. Conversation selection and uncertain creation requests are kept per tab in session storage, with the last selected conversation also available as the default for new tabs. Existing single-record browser data migrates automatically without replacing newer records. A pending send keeps its original content/request ID until reconciliation succeeds. History and credentials are never made authoritative by browser storage. Settings keep their existing stale-save handling.

Shutdown rejects new actions, closes stream watches/connections, drains accepted actions, checkpoints/closes Pi, then releases storage ownership. Abrupt termination is covered by disposable-service recovery tests for model streaming and safe/unsafe tools.

## Stage 4 planning state

Snapshots optionally include `planning`: captured repository registration, saved ticket, pending proposal, revision-bound authorization, and issue operation/link. A conversation-scoped planning-document watch participates in the existing ordered SSE delivery. Tool executions remain visible through the same transcript and artifact interface. The shared `ChatClient.retryIssue()` reconciles or retries a saved operation; it cannot create an unapproved operation. `FactoryClient.validateGitHub()` validates the repository configured in saved settings. See [PLANNING.md](PLANNING.md) for routes, authorization, and recovery rules.

## Stage 5 run conversations

Simulation admission atomically creates a run-owned developer conversation using captured role/repository settings. Stage tasks belong to that conversation; each reviewed attempt gets its own task-owned reviewer conversation. These conversations use no model generation or mutation tools. Simulated stage output is persisted as transcript entries and renders through the existing history/SSE interface.

Developer submissions use durable Pi submission records and the workflow’s revision-serialized admission boundary. Follow-ups and steering wait for a controlled developer boundary; withdrawal applies only before consumption. They are never independently scheduled by chat recovery. Reviewers reject ordinary input. Chat snapshots include `workflow` with run ID, status, stage, and input availability, and watch the workflow document so pause/publication updates also restore correctly. Developer interruption requests a workflow pause rather than independently aborting its conversation. Use the implementation sidebar for full run controls.

The planner’s `start_development` tool requires a consumed, explicit subsequent human start instruction and a confirmed issue. The service derives a stable admission operation from that instruction. Tool invocation alone, issue approval, repository text, and ordinary planning messages grant no start authorization. A repeated start and the application start button converge on one run. The planner cannot request an explicit new run after completion; that is a separate inspector action.

## Real run conversations

Real developer/reviewer conversations use captured providers and role-specific tools. Developer reads/edits/commands target the recorded worktree; reviewer reads target the validated candidate tree. Tools and provider callbacks require the active attempt and conversation. Real steering is placed at Pi's post-tool boundary; ordinary follow-ups wait for a developer boundary. Questions persist before stopping, and reviewer verdicts require structured tool submission. Publication closes admission to implementation input, including during service-only revalidation. Internal agent submissions and human guidance retain separate durable identities. Provider requests and compaction use captured deadlines without a short whole-conversation timeout.


## Independent implementation conversations

The root workspace groups Planning and Implementation conversations separately. Starting an issue opens its existing developer conversation, while reviewer contexts remain independent internally. The implementation transcript presents developer/reviewer messages, tools and service events in chronological order; model prompts are excluded from this presentation. Run/Ticket/Details sidebar tabs expose current execution, controls, the captured specification and retained evidence. Settings stays at `/settings`; legacy `/runs#<id>` links redirect to the implementation conversation.

`GET /api/v1/runs/:id/activity` returns a bounded, cursor-paginated read model with stable item IDs, available timestamps, actor and source references. `/activity/events` supplies a fresh snapshot and sequenced updates, with heartbeats and bounded buffering. Reconnect fills missed history and merges updates by identity. The activity stream also carries developer composer state, so each implementation tab uses one persistent connection. Navigation refreshes through cancellable, non-overlapping short requests; additional tabs cannot exhaust the browser connection pool with redundant streams. Tool cards keep stable identities across live updates, durable commits and older history loads, preserving expanded output. Original conversations and workflow/process records stay authoritative; display events do not enter model context. Command output is read separately in bounded pages, including new bytes after temporary EOF while running.

Dependency setup precedes development. Repository-configured checks run afterward, followed by independent review. Targeted base/candidate regression proof remains a separate post-development requirement when approved. Historical baseline evidence is retained; stopped legacy baseline attempts are skipped only after process reconciliation, preserving pause and intervention state.

## Permanent chat deletion

`DELETE /api/v1/conversations/:id` and `DELETE /api/v1/runs/:id` accept an empty JSON object using the normal CSRF header and return `202` with a durable `DeletionOperation`. A run-owned conversation deletes its entire implementation. Repeated requests return the same operation; requesting a blocked target again retries it. `GET /api/v1/deletions/:id` returns its current state, and `GET /api/v1/deletions` lists operations for navigation and cross-tab reconciliation.

The states are `pending`, `stopping`, `waiting`, `deleting`, `blocked`, and `completed`. Intent is saved before cancellation and suppresses target admission, recovery, and scheduling. Deletion waits for application-wide idle maintenance, serializes with automatic cleanup, removes owned files first, then purges Pi history with storage closed. A minimal completion receipt retains identifiers for retries and browser draft removal. Planning and implementation chats are deleted independently; retained links are cleared. Automatic cleanup retains its existing stricter checks for unpublished content.

Manual implementation deletion retains repository and issue identifiers to suppress automatic label admission across restarts. Only an explicit successful new admission clears this suppression. Maintenance preparation failures reopen the runtime before reporting the deletion as blocked, so unrelated chats remain usable.
