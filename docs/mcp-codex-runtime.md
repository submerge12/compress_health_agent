# Codex MCP runtime

The production startup order is:

1. PostgreSQL is healthy.
2. `pnpm db:migrate` completes.
3. The bound user already exists.
4. A projection worker starts.
5. A media runtime is selected.
6. Codex starts `pnpm mcp:stdio`.

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
worker can reclaim the expired lease. A worker that loses its lease never
marks the event successful or overwrites the successor's state; it records a
`projection/lease_lost` operational event instead.

## Headless media

`mcp:stdio` defaults to `COMPASS_HEALTH_MEDIA_RUNTIME=embedded`. It starts a
separate HTTP listener on an ephemeral `127.0.0.1` port while MCP traffic
continues over STDIO. `health_search_training_media` returns an absolute,
five-minute HMAC-signed `streamUrl`, `expiresAt`, and `contentType`; it never
returns the asset's `localPath`. The stream endpoint supports byte ranges and
serves only the segment's validated time window.

Available modes are:

- `embedded`: the default local Codex mode. An optional
  `COMPASS_HEALTH_MEDIA_BASE_URL=http://127.0.0.1:<port>` pins the loopback
  port; omitting it chooses a free port.
- `external`: no listener is started. Both `COMPASS_HEALTH_MEDIA_BASE_URL`
  and a secret of at least 32 bytes in
  `COMPASS_HEALTH_MEDIA_SIGNING_SECRET` are required. The external service
  must implement the same signed segment route.
- `off`: no media listener or URL issuer. Media search returns
  `domain_unavailable` instead of an unusable relative path.

The embedded server rejects non-loopback binding, unsigned or expired URLs,
unknown or superseded segments, unsafe decode tails, and ranges outside the
virtual segment window. A successful partial fetch looks like:

```http
GET /api/v1/media/segments/<uuid>/stream?expires=<unix>&signature=<hmac>
Range: bytes=0-65535

HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 0-65535/<segment-window-bytes>
Cache-Control: private, no-store
```

## Formal Agent identity

Each verified runtime resolves to a durable `agent_actors` profile and every
run binds that actor. Set `COMPASS_HEALTH_ACTOR` plus, when available:

```text
COMPASS_HEALTH_ACTOR_TYPE
COMPASS_HEALTH_RUNTIME_NAME
COMPASS_HEALTH_RUNTIME_VERSION
COMPASS_HEALTH_AGENT_PROFILE
COMPASS_HEALTH_AGENT_PROFILE_VERSION
COMPASS_HEALTH_MODEL_PROVIDER
COMPASS_HEALTH_MODEL_NAME
```

Receipt replay is allowed only for the same user, run, tool, argument hash,
idempotency key, and verified actor. `health_get_run_evidence` returns the
formal actor profile and terminal `tool_attempt` / `tool_result` evidence.
