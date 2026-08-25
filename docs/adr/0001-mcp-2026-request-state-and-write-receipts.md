# ADR 0001: MCP 2026 request state and write receipts

Status: accepted

## Context

MCP 2026-07-28 removes protocol sessions and server-to-client confirmation requests. Compass Health still needs confirmations that survive process restarts, bind to the exact proposed action, and cannot be replayed against another user, run, or target. Health writes also need one idempotency rule and one durable receipt format.

## Decision

- Serve stdio through the MCP TypeScript SDK v2 `serveStdio` entry in modern-only mode.
- Persist pending input requests in PostgreSQL. Return a 256-bit opaque `requestState`; store only its SHA-256 hash.
- Bind each pending request to the verified user and actor, run handle, tool, target, canonical argument hash, idempotency key, and expiry.
- Consume `requestState`, apply the domain mutation, append outbox rows, and write the MCP receipt in one PostgreSQL transaction.
- Route MCP mutations through the write-command module. Its interface requires a run handle, a user-scoped idempotency key, fact references, outbox event IDs, and transaction-local read-back.
- Keep health rules in existing domain modules. The MCP modules adapt wire fields and transaction metadata only.

`health_begin_run` is the bootstrap exception to the run-handle requirement. It still requires an idempotency key and creates its run fact, outbox event, receipt, and first evidence step in one transaction.

## Consequences

- A process restart or instance change does not lose a pending confirmation.
- Changing the user, actor, run, tool, target, arguments, or idempotency key rejects the retry.
- Resource reads use explicit or implicit run evidence and never rely on transport session state.
- Older initialize/session-based MCP clients are rejected by the stdio entry. Existing non-MCP HTTP/BFF routes remain unchanged.
