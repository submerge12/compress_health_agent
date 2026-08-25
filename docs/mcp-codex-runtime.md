# Codex MCP runtime

The production startup order is:

1. PostgreSQL is healthy.
2. `pnpm db:migrate` completes.
3. A projection worker starts.
4. Codex starts `pnpm mcp:stdio`.

`mcp:stdio` starts an embedded projection worker by default outside tests, so
the local Codex configuration is self-contained. Set
`COMPASS_HEALTH_PROJECTION_WORKER_MODE=external` when a separately supervised
`pnpm projection:worker` process owns queue draining. Tests default to
`disabled` unless they explicitly exercise the runtime.

Each outbox claim commits `status=processing`, a worker id, and an expiring
lease before projection begins. Other workers skip the event while the lease
is live. A worker renews its lease during processing; after a crash, another
worker can reclaim the expired lease.

