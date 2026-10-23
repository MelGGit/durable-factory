# Durable Factory

A personal, locally hosted tool for planning software with an LLM and implementing approved GitHub issues through a durable developer → checks → reviewer → PR workflow.

Stages 1–8 provide durable planning, approved GitHub issues, real development in isolated worktrees, required checks, independent review, ready-for-review PR publication, live inspection, and automatic local cleanup after merge. Offline verification uses deterministic models, disposable repositories, and fake GitHub responses; it does not claim account-backed model or GitHub access.

## Start locally

Requires **Node 24** and **Bun 1.4.3**. The backend always runs on Node; Bun manages dependencies, frontend tooling, and the Node-targeted service bundle.

```sh
bun install --frozen-lockfile
bun run dev
```

Open [the development app](http://127.0.0.1:5173). Planning chat is the home screen; settings are at `/settings`. Vite proxies requests to the Node service on port 4317. Save a repository path, commands, and independent provider/model selections for each role. Configuration may be partial while setting up; no model is chosen automatically, and saving commands never runs them.

For the production build:

```sh
bun run build
bun run start
```

Startup is manual: run `bun run start` from this repository after building. Stop with Ctrl+C; the service drains accepted requests and accounts for owned processes before releasing storage. Nothing is installed to start at login. Sleeping or powering off the computer suspends local execution.

Open [the local application](http://127.0.0.1:4317). Node serves the built frontend and API. Do not run development and production services against the same data directory simultaneously.

## Planning chat

Choose a planning provider/model in settings, configure its connection, then create a named conversation from the home screen. Each conversation captures its repository and model settings; later settings saves affect new conversations. Planning can list, read, and search current non-ignored repository files, inspect tracked changes, and search its own persisted history. Uncommitted files are included. The planner cannot edit files or run arbitrary commands. Save repository settings before creating a conversation; existing conversations retain their captured repository.

Messages are acknowledged after durable acceptance. Follow-ups queue while the agent is busy; withdraw them before consumption. **Interrupt conversation** stops the current work and withdraws queued inputs. Partial replies and results remain visible. Interrupting a planning turn prevents it from starting a new GitHub creation request; a request already sent may still create an issue, whose result is recorded or reconciled. An interrupted or failed input is never retried as a new message automatically; send a new message explicitly to continue. A lost response to a send retains its request ID for reconciliation. Explicit new-run requests also retain their operation ID in browser storage until acknowledged.

Closing the browser does not stop accepted work. Reopening restores drafts and pending sends from this browser’s local storage; each tab keeps its own conversation selection. Separate records prevent another tab’s edits from overwriting saved drafts or uncertain sends. Drafts are local to the browser, while accepted input and conversation history live in SQLite. Changing the browser origin/port or clearing browser data removes local drafts, not server history. Pending sends reconcile when their conversation reconnects; use **Retry send** after an uncertain response. Browser connection status is separate from agent execution status.

Load older messages on demand. Expand tool cards to inspect inputs, commands, results, and live output. Previews are bounded; complete tool logs and long messages are available through paginated output controls. No transcript content is executed as HTML. See [the chat API contract](docs/CHAT.md) for streaming and recovery details.

## Planning → issue

Ask the planner to shape a ticket. It saves a title, goal, scope, acceptance criteria, and validation approach, presents the ticket in chat, and asks whether to create the issue. Reply **yes**, **yes please**, **create it**, or **go ahead** to approve that exact ticket revision. Ambiguous or negative replies cancel the pending proposal; the agent must clarify and propose again. Ticket changes also require a fresh proposal. No separate preview screen or slash command is required.

The saved ticket, creation status, and confirmed GitHub link restore after reconnecting. One planning conversation creates at most one linked issue. Issue creation never starts development or adds a ready label. Start a new conversation for another issue or to revise a ticket already submitted to GitHub.

An operation marker in the issue body lets the service recover a lost response without creating another issue. **Retry reconciliation** checks open and closed issues for that marker. If an earlier request might have succeeded and no issue is found, it stays uncertain and is never blindly sent again. A confirmed rejection can be retried after repairing credentials or permissions. Multiple matching issues require inspection. Do not remove the marker while creation is pending.

## Real development and PRs

Complete repository/base-branch settings, commit author name/email, independent development/review models and connections, at least one required check, and the GitHub connection. Real execution activates automatically when configured. Setup commands are optional; saving settings does not itself execute commands. Open `/runs` to see missing prerequisites or start an existing issue by number. A linked planning issue also offers **Start implementation**. Explicit starts and open issues labelled `agent:ready` share one durable admission path; labels are checked at startup and every 30 seconds. Adding the label authorizes implementation and PR publication. Issue creation alone still never starts development.

Set `DURABLE_FACTORY_WORKFLOW_MODE=disabled` to disable admission and polling, or `simulation` for the deterministic workflow below. Existing runs retain their mode. A real-mode service can inspect/recover simulation runs using the simulation adapter; simulation or disabled mode cannot execute real runs.

Each run captures its issue, base commit, commands, deadlines, models, and commit identity. The service creates a dedicated branch and worktree under its private runtime directory. The original checkout and its uncommitted changes are not copied into the run. Worktrees and tool filtering are application boundaries, not an OS sandbox: repository commands and hooks run with the service user's permissions. macOS and Linux require working POSIX process inspection; unsupported or unavailable inspection blocks execution.

Setup and the complete baseline gate must pass before development starts. Pre-existing failures pause with output. Developers can edit and run supervised commands; reviewers receive fresh, inspection-only conversations with the exact candidate Git tree and check evidence. Required checks and structured review must approve the same source/configuration/specification. Tracked changes and non-ignored additions are included; the developer explicitly selects ignored generated files intended for the commit. Unselected ignored build output does not affect validation. Submodules require manual handling.

Before publishing, the service refreshes the base, integrates changes when necessary, and repeats validation. It commits with the captured identity, verifies the resulting tree including hook effects, pushes the dedicated branch without force, and creates a non-draft PR referencing the issue. It never merges. Lost push/PR responses reconcile existing effects before retrying. Credential replacement can repair the same operation without changing execution settings. Git authentication uses a private, short-lived helper channel; tokens are absent from remote URLs, ordinary logs, helper files, and agent environments.

Developer input closes when publishing begins. Hook-generated content can use **Repeat checks and review** before any remote write; this keeps developer input closed. Further developer edits or changes to the target base branch require an explicit new run. After remote publication starts, resolve uncertainty before further action. Completed/cancelled issues require an explicit new run; persistent labels cannot restart them.

Pausing/cancelling preserves worktrees and evidence. Deadlines stop supervised process groups and observed descendants; uncertain termination retains the execution slot. Commands must retain their ownership marker and must not deliberately evade supervision. On restart, the service reconciles processes before admitting resumed execution; interrupted mutating commands require inspection and explicit continuation. Merged-run cleanup is described below; backup/restore is deferred.

## Workflow simulation

Start the service with explicit simulation mode:

```sh
DURABLE_FACTORY_WORKFLOW_MODE=simulation bun run dev
```

After a planning conversation has a confirmed issue, choose **Start simulated run**, or explicitly tell the planner **start implementation**. Both use the same durable admission service. Issue creation alone never starts a run. The `/runs` inspector shows queue position, active stage, repairs, captured configuration/models, evidence, conversations, and questions. Simulation labels remain visible throughout: no coding model is called, no repository command runs, and no GitHub PR is created by the workflow. Planning and issue creation retain their existing real provider/GitHub behavior.

One run holds the execution slot. Runs follow setup → baseline → developer → checks → independent reviewer → publication admission → simulated publishing. Pause, resume, cancellation, answers, configuration/specification adoption, and explicit repair continuation are revision checked. Guidance queues for a developer boundary; input during validation returns through development and validation. Reviewer conversations accept no ordinary input. Publishing closes implementation input; finished runs require **Start explicit new simulated run** for another implementation.

Settings saves affect future runs. Pause before choosing **Adopt saved configuration**; setup changes repeat setup and baseline, and evidence is invalidated. **Adopt saved specification** takes the simulation adapter’s latest ticket (the default adapter retains the admitted ticket); scripted tests model updated issues. The initial attempt permits three repairs, with one additional repair only after explicit recorded authorization. Neither guidance nor adoption resets the repair count.

Unconfirmed termination retains the execution slot until **Reconcile run** confirms quiescence. Lost publication responses require reconciliation before retrying; late outcomes remain recorded after cancellation. Restart with simulation or real mode to operate existing simulation runs; disabled mode preserves records and blocks unsafe recovery. New runs use the current service mode. Closing the browser does not stop a run; graceful service shutdown pauses active workflow work. See [the workflow contract](docs/WORKFLOW.md) for API and recovery details.

## Completed-run cleanup and inspection

The run inspector shows captured role models, repairs, pending questions, recovered attempts, active tools/commands and command output. Reported tokens include input, output and cache usage when available. Positive Requesty cost estimates are labelled in USD; missing estimates remain unavailable. Subscription token counts are not per-token bills. Long histories are bounded and labelled partial when necessary.

In real mode the service checks completed PRs on startup and every 30 seconds. After GitHub confirms the original PR was merged and its linked issue is closed, cleanup runs automatically when the application is idle. Generated PR descriptions include `Closes #…`; GitHub closes the issue when that closing reference takes effect. Closed issues cannot start development through manual, label or planning-chat admission.

Cleanup permanently removes the local run, its worktree, service-created local branch/base reference, conversations, questions, checks/reviews, usage, command/tool logs, artifacts and admission receipts. It deletes the originating planning conversation only when no retained run shares it. There is no archive or permanent completion marker. GitHub issues, PRs, merged code and remote branches remain on GitHub; settings, credentials and unrelated local runs are preserved. Browser-local drafts are separate from server data.

The browser may briefly reconnect during cleanup. The service stops admission and closes Pi storage while retaining exclusive ownership, removes verified files, then transactionally purges records and their historical revisions before reopening. Interrupted cleanup is retried after restart. A failed storage reopening is retried automatically up to three times while readiness stays blocked. If recovery still fails, `/ready` and API errors explain that you must restore data-directory access and restart the service; partially initialized storage is closed before another attempt. SQLite maintenance supports only the pinned Pi Durable 1.3.0/schema 1; upgrades must update and verify the adapter first.

A changed worktree/branch, active process or uncertain resource ownership blocks cleanup and shows a reason in the inspector. Inspect and preserve unexpected edits, then resolve the reported condition; cleanup retries on the next poll. Ignored files are fingerprinted before publication. Cleanup removes them only if their paths, contents and modes still match that baseline; new or changed ignored files block deletion too. Older runs without a baseline retain ignored files until you preserve or remove them. Cancelled runs, open issues and unmerged/closed PRs are retained. GitHub failures or rate limits defer cleanup without deleting data. Backup/restore and startup at login are deferred.

## Runtime data and credentials

On macOS, data defaults to `~/Library/Application Support/Durable Factory`. On Linux, it defaults to `$XDG_DATA_HOME/durable-factory` or `~/.local/share/durable-factory`. Set `DURABLE_FACTORY_DATA_DIR` to an absolute path to override it. Use a directory outside both this application and your target repository. `DURABLE_FACTORY_PORT` changes the Node service port; development uses a fixed Vite proxy to 4317.

Configuration lives in Pi Durable documents in `factory.sqlite`; there is no second application database. Tokens and OAuth credentials live in private files under `credentials/` (directory mode 0700, files mode 0600), outside the checkout. Credentials are protected by filesystem permissions, **not encrypted at rest**. The browser can store or replace Requesty/GitHub tokens and disconnect accounts; it receives only credential status. A stored credential is not proof of valid account access. Provider catalogs are capability lists, not access guarantees. Requesty uses an explicitly entered model ID; unverified reasoning options are unavailable.

One service or diagnostic owns a data directory at a time. Ownership uses an operating-system file lock held through Node's SQLite adapter; a stalled or suspended process keeps the lock, and process death releases it immediately. The empty `ownership.lock` and `credentials/write.lock` files are mutexes only, with no application records or second queue. Never delete or replace a lock file while a process may be using it. Graceful shutdown closes HTTP admission, drains accepted requests, closes Pi storage, then releases ownership.

When upgrading from the original heartbeat-lock build, stop the older service and diagnostics first. A remaining legacy `<data-directory>.lock` directory blocks the upgrade rather than being silently reclaimed. If the old process crashed, verify that it has exited before explicitly removing that legacy directory. Do not remove the new lock files.

## Connect providers

Stop the service before running diagnostics. Use the same data-directory override in both shells if configured. Sign-in is interactive and uses Pi's provider-owned OAuth flow:

```sh
bun run diagnose status
bun run diagnose login openai
bun run diagnose login anthropic
```

Requesty and GitHub tokens are entered in the settings screen. Use a fine-grained GitHub token scoped to the selected repository with Issues, Contents, and Pull requests read/write permissions for the complete workflow. GitHub may require additional permission when changing workflow files. **Validate GitHub repository** checks repository and issue readability using the saved settings. Readability does not prove write permission; GitHub checks that when an approved issue is created. Saving a token alone does not contact GitHub.

The diagnostic interface provides only `status` and `login`. Status reports stored credential configuration without contacting providers or checking account access. Pi handles subscription token refresh automatically when resolving authentication for a model request. Provider/model availability depends on your account; an unavailable connection reports an error without silently switching providers.

## Verification

```sh
bun run check
bun run format:check
bun run build
bun run test
bunx playwright install chromium
bun run test:browser
```

The offline suite uses Node's test runner, real Pi SQLite storage, deterministic faux models, and disposable data directories. It requires no account or paid call. Crash tests send SIGKILL to child processes and verify immediate lock recovery. A separate regression stalls a live owner for 15 seconds and confirms that it cannot be replaced; the expanded offline suite takes about four minutes. The browser suite validates this checkout path read-only and requires a built frontend and installed Chromium. Optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium executable. It saves desktop/mobile screenshots in ignored `test-results/`.

## Operating notes

- `/health` reports process responsiveness; `/ready` admits work only after storage ownership, schema checks, and startup inspection succeed. A blocked service keeps health and readiness diagnostics available.
- A newer application schema is never overwritten. Run a compatible application version or restore a compatible backup. Backup/restore tooling is deferred. Do not copy a live SQLite file without its WAL state.
- A conflict means another window saved newer settings. Your current edits remain visible; reload settings explicitly to adopt the saved configuration. Reloading discards the current edits.
- A malformed or unreadable credential produces a connection-specific error while settings remain editable. Replace a Requesty/GitHub token directly, or remove a damaged subscription connection and sign in again. Authentication still fails closed for damaged credentials.
- Provider failures do not prevent inspecting or editing settings. There is no automatic authentication, token refresh, model call, or provider fallback on page load.
- The service binds only to `127.0.0.1`. Host/origin checks and a per-process CSRF token protect local mutations. This is a personal local app, not a remotely hosted or multi-user service.
- Source code can be replaced without replacing runtime data. Do not put credentials or runtime databases in Git. Run cancellation and supervised real process termination are available; merged-run cleanup is automatic as described below; backup/restore is deferred.

See [ARCHITECTURE.md](ARCHITECTURE.md) for behavior and boundaries, [IMPLEMENTATION.md](IMPLEMENTATION.md) for stage gates, and [the workflow transition table](docs/WORKFLOW.md) for the simulation and real workflow adapters.

## Stronger handoffs and regression evidence

New real runs require an explicit issue contract. During planning, review the complete proposed GitHub issue with numbered acceptance criteria (`AC-1`, `AC-2`, …), validation, and a regression-proof decision before approving creation. If proof is required, agree its test command, test/fixture paths and expected failure text in that issue. Agents cannot add requirements after approval. Existing manually or label-started issues without this information pause before setup: update the issue, adopt its specification in the run inspector, then resume.

Developers submit a structured implementation report; independent review assesses every approved criterion with inspectable evidence. Required regression proof runs the approved test against isolated base and candidate snapshots, demonstrating the expected failure before the fix and success afterward. Failed proof uses the existing repair budget. Interrupted proof resources and output remain available for inspection; changed or unverified resources are retained rather than deleted automatically.

The run inspector provides a chronological timeline, repair causes, current and superseded reports/evidence, criterion assessments, and proof command output. PR descriptions summarize the implementation, acceptance evidence, validation and remaining limitations. Old runs retain their captured behavior and explicitly show unavailable structured evidence. See [the approved issue format](docs/PLANNING.md#approved-issue-contract--handoffs-release) and [workflow contract](docs/WORKFLOW.md#stronger-handoffs-and-evidence-contract).
