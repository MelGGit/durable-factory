# Durable Factory

A personal, locally hosted tool for planning software with an LLM and implementing approved GitHub issues through a durable developer → checks → reviewer → PR workflow.

Steps 1–2 are complete: a local settings application, Pi Durable/SQLite configuration, private credentials, and offline process-recovery checks. Planning chat, GitHub operations, and development runs follow in later stages.

## Start locally

Requires **Node 24** and **Bun 1.4.3**. The backend always runs on Node; Bun manages dependencies, frontend tooling, and the Node-targeted service bundle.

```sh
bun install --frozen-lockfile
bun run dev
```

Open [the development app](http://127.0.0.1:5173). Vite proxies requests to the Node service on port 4317. Save a repository path, commands, and independent provider/model selections for each role. Configuration may be partial while setting up; no model is chosen automatically, and saving commands never runs them.

For the production build:

```sh
bun run build
bun run start
```

Open [the local application](http://127.0.0.1:4317). Node serves the built frontend and API. Do not run development and production services against the same data directory simultaneously.

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

Requesty and GitHub tokens are entered in the settings screen. GitHub connectivity/permissions are deferred to step 4; token storage alone does not contact GitHub.

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

The offline suite uses Node's test runner, real Pi SQLite storage, deterministic faux models, and disposable data directories. It requires no account or paid call. Crash tests send SIGKILL to child processes and verify immediate lock recovery. A separate regression stalls a live owner for 15 seconds and confirms that it cannot be replaced; the suite takes about 17 seconds. The browser suite validates this checkout path read-only and requires a built frontend and installed Chromium. Optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium executable. It saves desktop/mobile screenshots in ignored `test-results/`.

## Operating notes

- `/health` reports process responsiveness; `/ready` admits work only after storage ownership, schema checks, and startup inspection succeed. A blocked service keeps health and readiness diagnostics available.
- A newer application schema is never overwritten. Run a compatible application version or restore a compatible backup. Stop the service before copying the SQLite database and associated files; live SQLite-aware backup/restore belongs to step 8.
- A conflict means another window saved newer settings. Your current edits remain visible; reload settings explicitly to adopt the saved configuration. Reloading discards the current edits.
- A malformed or unreadable credential produces a connection-specific error while settings remain editable. Replace a Requesty/GitHub token directly, or remove a damaged subscription connection and sign in again. Authentication still fails closed for damaged credentials.
- Provider failures do not prevent inspecting or editing settings. There is no automatic authentication, token refresh, model call, or provider fallback on page load.
- The service binds only to `127.0.0.1`. Host/origin checks and a per-process CSRF token protect local mutations. This is a personal local app, not a remotely hosted or multi-user service.
- Source code can be replaced without replacing runtime data. Do not put credentials or runtime databases in Git. Cancellation/backup/worktree cleanup controls are later-stage features.

See [ARCHITECTURE.md](ARCHITECTURE.md) for behavior and boundaries, [IMPLEMENTATION.md](IMPLEMENTATION.md) for stage gates, and [the workflow transition table](docs/WORKFLOW.md) before implementing the scheduler.
