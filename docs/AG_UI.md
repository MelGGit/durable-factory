# AG-UI integration

Durable Factory exposes a text-chat subset of **AG-UI 1.0**, using the official core schemas and encoder pinned to **1.0.3**. Pi Durable remains authoritative for execution, history, admission, approvals, and recovery. The original REST API remains available.

## Standard run endpoint

`POST /api/v1/ag-ui/run` accepts JSON `RunAgentInput` and returns `text/event-stream`. Send `Accept: text/event-stream`. Obtain the current `csrfToken` from `GET /api/v1/session` and send it as `X-Factory-CSRF`. Existing localhost host/origin checks apply: use the same-origin frontend proxy or connect server-to-server. Arbitrary browser origins and remote hosting are not enabled.

Create/list conversations through the existing `/api/v1/conversations` API. Use the conversation ID as `threadId`. Planning and authorized developer conversations accept input; reviewers remain inspection-only. Developer input still passes through workflow admission and publication restrictions.

```ts
import { HttpAgent } from '@ag-ui/client';

const session = await fetch('/api/v1/session').then((response) =>
  response.json(),
);
const agent = new HttpAgent({
  url: '/api/v1/ag-ui/run',
  threadId: conversationId,
  headers: { 'X-Factory-CSRF': session.csrfToken },
  initialMessages: [
    { id: crypto.randomUUID(), role: 'user', content: 'Plan this change' },
  ],
});
await agent.runAgent({ runId: crypto.randomUUID() });
```

Direct requests should declare `protocolVersion: "1.0"`; absence is accepted, other explicit versions are rejected. The last message must be a user message containing text. Its text is admitted as the new input. Older client history, system/developer messages, tool results, `state`, `context`, and `forwardedProps` never overwrite server history or grant permissions. Non-text parts are not forwarded to the model. Non-empty frontend `tools` and AG-UI `resume` lists are rejected before admission.

Run/message IDs must be non-empty and at most 512 characters. User IDs in the numeric server `entry`, `live`, and `result` namespaces are reserved. The request limit is 2 MiB and the new user text limit is 32 KiB; other API request limits remain unchanged.

## Events, identities, and durability

- `RUN_STARTED` carries the requested exchange `runId`, conversation `threadId`, and protocol version. Exchange IDs are independent of factory development-run IDs.
- Text and backend tools use `TEXT_MESSAGE_*` and `TOOL_CALL_*` events. The standard run endpoint restores durable history before admission and keeps a complete exchange transcript independently of the bounded observation view. Prior text/tools hydrate through `MESSAGES_SNAPSHOT` without replaying generation callbacks. Replacement snapshots retain earlier messages; token updates use deltas without resending the full transcript. Large snapshots use bounded UTF-8 byte writes with backpressure, keeping heartbeats outside each event.
- `STATE_SNAPSHOT` carries `{ factory: { schemaVersion: 1, kind: "conversation", snapshot } }`. The authoritative snapshot contains conversation metadata, entries, partial text, tool previews, submissions, execution, and optional planning/workflow state. Full tool outputs remain available through artifact APIs.
- Original AG-UI user-message IDs survive committed history. Other messages and tool calls are namespaced by conversation. A live generation has an exchange-local ID and is replaced by its committed message.
- Each exchange observes its own submission. A terminal receipt triggers a fresh projection and any missing-history backfill before `RUN_FINISHED`, so a completion racing the watch cannot omit its final reply. Withdrawal/interruption uses the cancelled outcome; provider failure emits `RUN_ERROR`. A durable workflow pause/question also closes the exchange, with `result.factory.awaitingInput = true`. This does not mean the whole development workflow finished.
- Bindings between exchange IDs, user-message IDs, content, and submission receipts persist in conversation-scoped storage. Different content under an existing identity returns `409`. The same user-message ID in a new exchange reuses the accepted submission, including after restart. Use a new message ID for genuinely new work.
- Closing a connection or switching conversations detaches observation and never cancels accepted work. Explicit interrupt/pause controls retain their existing semantics. Standard AG-UI HTTP has no `Last-Event-ID` resumption: recover durable history, and retry uncertain delivery with a new exchange ID and the original user-message ID.

## Factory observation extensions

These read-only interfaces carry standard AG-UI events but are **not** the standard POST/run transport:

| Endpoint                                                           | Result                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GET /api/v1/conversations/:id/ag-ui/snapshot`                     | JSON `{ events }` containing message/state snapshots                                           |
| `GET /api/v1/conversations/:id/ag-ui/history?cursor=...&limit=...` | JSON `{ events }`; state contains `factory.kind = "history"`, `entries`, and optional `cursor` |
| `GET /api/v1/conversations/:id/ag-ui/events`                       | Passive SSE message/state snapshots                                                            |
| `GET /api/v1/runs/:id/activity/ag-ui?cursor=...&limit=...`         | JSON `{ events }` for the combined developer/reviewer/service timeline                         |
| `GET /api/v1/runs/:id/activity/ag-ui/events`                       | Passive SSE timeline, live tools, and developer composer state                                 |

Passive state snapshots contain `factory.schemaVersion = 1`, `kind` (`conversation` or `activity`), `apiVersion`, `streamId`, `sequence`, `type`, and `snapshot`. Connections begin with replacement snapshots; updates increase the sequence. Duplicate frames are ignored; gaps require reconnect/history backfill. Pagination matches the existing APIs. Streams preserve 15-second heartbeats, bounded output buffers, and the 45-second client watchdog.

The shipped frontend uses `AgUiChatClient` and `AgUiRunActivityClient` for these views. Existing REST submission/receipt endpoints handle uncertain sends, durable queueing, steering, withdrawal, interruption, human answers, and workflow controls. Settings, drafts, tools, scroll behavior, and inspector panels retain their existing behavior. Legacy `ChatClient` and `RunActivityClient` remain available.

## Compatibility and limits

The integration supports text, backend tool calls/results, message/state snapshots, lifecycle events, and factory observation extensions. Client tools, AG-UI approvals/resume, attachments, reasoning events, history editing/branching, WebSockets, and protobuf are outside this release. Human answers and approvals continue through factory APIs; generic AG-UI compatibility does not supply those application controls automatically.

`tests/ag-ui.test.ts` exercises the endpoint with the official `HttpAgent`, validates events against official schemas, and mounts the real assistant-ui AG-UI runtime as a test-only fixture. Assistant-ui is a development dependency only; the shipped UI keeps our components.
