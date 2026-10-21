# Durable Factory

A personal, locally hosted tool for planning software with an LLM and implementing approved GitHub issues through a durable developer → checks → reviewer → PR workflow.

The combined steps 1–2 foundation is implemented: a local settings application, Pi Durable/SQLite configuration, private credentials, and offline process-recovery checks. Planning chat, GitHub operations, and development runs follow in later stages. Real-provider compatibility is **not yet verified**.

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

One service or diagnostic owns a data directory at a time. After a forced termination, allow up to **12 seconds** for the ownership lease to expire. Never manually delete an active lock. Graceful shutdown closes HTTP admission, drains accepted requests, closes Pi storage, then releases ownership. Lost ownership terminates the process.

## Connect and check providers

Stop the service before running diagnostics. Use the same data-directory override in both shells if configured. Sign-in is interactive and uses Pi's provider-owned OAuth flow:

```sh
bun run diagnose status
bun run diagnose login openai
bun run diagnose login anthropic
```

Requesty and GitHub tokens are entered in the settings screen. GitHub connectivity/permissions are deferred to step 4; token storage alone does not contact GitHub.

Real model checks are opt-in and can consume account usage or incur Requesty charges. Replace each model placeholder with an exact model ID selected by you. Run one check at a time; no fallback provider is used:

```sh
bun run diagnose check requesty EXACT_REQUESTY_MODEL_ID
bun run diagnose check openai EXACT_OPENAI_MODEL_ID
bun run diagnose check anthropic EXACT_ANTHROPIC_MODEL_ID
bun run diagnose interrupt openai EXACT_OPENAI_MODEL_ID
bun run diagnose interrupt anthropic EXACT_ANTHROPIC_MODEL_ID
bun run diagnose interrupt requesty EXACT_REQUESTY_MODEL_ID
bun run diagnose refresh openai
bun run diagnose refresh anthropic
```

Each model check exercises the Pi harness, committed streaming observation, and a harmless tool round-trip in disposable storage. Short responses may finish before a committed streaming frame is observed; that is explicitly reported as unverified. The interrupt command cancels after the first committed model partial and verifies that the partial is retained as aborted history. If no interruptible response is observed, it reports a blocked check. The refresh command requests provider-owned token renewal without fabricating expired credentials. It can rotate credentials and must run under exclusive ownership. Missing credentials, failed authentication, inaccessible models, usage limits, and transport failures produce a blocked result without switching providers. Secret-free results are recorded in `provider-checks.json`; temporary model transcripts are removed. See [the compatibility record](docs/COMPATIBILITY.md) for outstanding live checks and recovery limitations.

## Verification

```sh
bun run check
bun run format:check
bun run build
bun run test
bunx playwright install chromium
bun run test:browser
```

The offline suite uses Node's test runner, real Pi SQLite storage, deterministic faux models, and disposable data directories. It requires no account or paid call. Crash tests send SIGKILL to child processes and wait for real ownership-lease expiry, so the suite takes about 40 seconds. The browser suite validates this checkout path read-only and requires a built frontend and installed Chromium. Optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium executable. It saves desktop/mobile screenshots in ignored `test-results/`.

## Operating notes

- `/health` reports process responsiveness; `/ready` admits work only after storage ownership, schema checks, and startup inspection succeed. A blocked service keeps health and readiness diagnostics available.
- A newer application schema is never overwritten. Run a compatible application version or restore a compatible backup. Stop the service before copying the SQLite database and associated files; live SQLite-aware backup/restore belongs to step 8.
- A conflict means another window saved newer settings. Your current edits remain visible; reload settings explicitly to adopt the saved configuration. Reloading discards the current edits.
- Provider failures do not prevent inspecting or editing settings. There is no automatic authentication, token refresh, model call, or provider fallback on page load.
- The service binds only to `127.0.0.1`. Host/origin checks and a per-process CSRF token protect local mutations. This is a personal local app, not a remotely hosted or multi-user service.
- Source code can be replaced without replacing runtime data. Do not put credentials or runtime databases in Git. Cancellation/backup/worktree cleanup controls are later-stage features.

See [ARCHITECTURE.md](ARCHITECTURE.md) for behavior and boundaries, [IMPLEMENTATION.md](IMPLEMENTATION.md) for stage gates, and [the workflow transition table](docs/WORKFLOW.md) before implementing the scheduler.
