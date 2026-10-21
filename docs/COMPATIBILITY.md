# Foundation compatibility and verification

Recorded 2026-10-21. This records observed application integration, not certification of every upstream Pi feature.

## Pinned environment

| Component | Version | Result |
| --- | --- | --- |
| Node.js | 24.18.0 | Service, SQLite, type checks and Node test runner exercised |
| Bun | 1.4.3 | Install, lockfile, Vite build and Node-targeted bundle exercised |
| Pi Durable | 1.3.0 | Published package installed; real SQLite documents and forced restart recovery exercised |
| pi-ai | 1.3.0 | Published package installed; faux provider, explicit model collections, provider factories and persistent credential adapter exercised |
| Chord | 1.3.0 | Published package installed; context and document transactions exercised through Pi |
| React / Vite / TypeScript | 19.2.0 / 7.1.12 / 5.9.3 | Pinned in manifests and Bun lockfile |

The reference durable-pi backend pins 1.0.3; we use the published 1.3.0 package set and current APIs rather than copying that older setup. No reference application code was copied.

Sources: [Pi Durable package and API](https://github.com/earendil-works/pi/tree/main/packages/durable), [pi-ai provider/credential interfaces](https://github.com/earendil-works/pi/tree/main/packages/ai), [Requesty endpoint documentation](https://docs.requesty.ai/quickstart).

## Offline evidence

- Configuration persists through a service restart in real SQLite. Revision checks reject stale saves atomically.
- A newer application schema blocks readiness and writes; the stored configuration is not replaced.
- Exclusive storage ownership blocks a second service and recovers after abrupt process death and lease expiry.
- A committed partial model response survives process death as interrupted history; the accepted input and queued follow-up finish after reopening the same storage. Retrying the request ID returns the original submission.
- A read-only tool declared replay-safe runs again after restart and produces one committed tool result.
- An unsafe fixture writes an observable effect, emits committed partial output, and is killed before result commit. Recovery does not execute it again; the transcript contains an interrupted tool result and retained output. The application must interpret that outcome before future workflow mutations; no scheduler exists yet.
- Credential modifications serialize read-modify-write and preserve concurrent token rotations. API responses omit secrets. Host/origin/CSRF boundaries and configuration validation are exercised.

## Verification results

- `bun run check`, `bun run format:check`, and `bun run build`: passed.
- Offline Node suite: eight tests, including three forced-termination scenarios, passed.
- Browser suite: settings, restart, token privacy, stale updates (including credential-save races), and mobile layout passed; desktop/mobile screenshots visually inspected.
- Built production Node service: readiness, shared client, and served frontend assets passed on localhost.
- Real-provider calls: not run; required evidence remains outstanding below.

## Real-provider matrix

| Connection | Login / credentials | Streaming + tools | Refresh | Live interruption / limits |
| --- | --- | --- | --- | --- |
| Requesty | Untested; settings key storage implemented | Untested; explicit model diagnostic available | Not applicable (API key) | Untested; interrupt diagnostic available |
| OpenAI subscription | Untested; Pi-owned login command available | Untested; explicit model diagnostic available | Untested; Pi-owned refresh command available | Untested; interrupt diagnostic available |
| Anthropic subscription | Untested; Pi-owned login command available | Untested; explicit model diagnostic available | Untested; Pi-owned refresh command available | Untested; interrupt diagnostic available |

No real accounts or paid calls were used during implementation. Per-installation diagnostic outcomes are recorded separately in the runtime-data directory; they do not imply the checked-in matrix has been completed. Step 1 stays incomplete until the required live checks have evidence. Missing stored credentials are an explicit authentication error, never permission to use environment keys or another provider.

## Known boundaries

- Pi Durable's SQLite backend uses WAL with `synchronous=NORMAL`: process-crash recovery is not a guarantee against power loss. Do not copy just a live database file while ignoring WAL state.
- Pi does not provide cross-process ownership locking. The application uses a heartbeat lock with 10-second staleness and terminates on compromised ownership. Crash tests allow 12.5 seconds for filesystem timestamp precision.
- Subscription credentials are stored only under their selected provider. Ambient environment credentials and CLI logins are not used. Provider-owned refresh runs inside the credential-store lock.
- Requesty is registered as a custom OpenAI Chat Completions provider at `https://router.requesty.ai/v1`. Conservative diagnostic limits are 8192 context / 1024 output tokens; catalog capacity, reasoning, price and account access are not inferred. No cost estimates are displayed.
- The credential files are protected with local filesystem permissions and atomic replacement, not encryption. Tests use temporary secrets and never enumerate personal credentials.
- The application has no public chat API or task scheduler yet. Restart checks are intentionally confined to disposable diagnostics. Full workflow reconciliation, command/process-group termination, streaming clients, authentication UI, and backup/restore remain later work.
