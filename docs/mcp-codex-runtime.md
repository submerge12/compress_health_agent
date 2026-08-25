# Codex MCP runtime

The production startup order is:

1. PostgreSQL is healthy.
2. `pnpm db:migrate` completes.
3. The bound user already exists.
4. A projection worker starts.
5. Codex starts `pnpm mcp:stdio`.

MCP user provisioning is disabled by default. Create a binding explicitly:

```powershell
$env:DATABASE_URL = "postgres://..."
pnpm user:bootstrap --external-id "compass-health:1" --timezone "Asia/Shanghai" --locale zh
```

`COMPASS_HEALTH_USER_BINDING` must then match that exact external id. A typo
causes startup to fail; it never creates an empty user. The opt-in
`COMPASS_HEALTH_ALLOW_USER_PROVISIONING=true` exists for isolated tests only
and must not be set in the Codex production configuration.

Every omitted health date is resolved from the stored
`compass_health.users.timezone`. Tools, `today` resources and outbox payloads
therefore use the same local calendar day.

`mcp:stdio` starts an embedded projection worker by default outside tests, so
the local Codex configuration is self-contained. Set
`COMPASS_HEALTH_PROJECTION_WORKER_MODE=external` when a separately supervised
`pnpm projection:worker` process owns queue draining. Tests default to
`disabled` unless they explicitly exercise the runtime.

Each outbox claim commits `status=processing`, a worker id, and an expiring
lease before projection begins. Other workers skip the event while the lease
is live. A worker renews its lease during processing; after a crash, another
worker can reclaim the expired lease.
