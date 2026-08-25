-- P2.1 Codex real-use gate: durable MRTR state and write receipts.

CREATE TABLE IF NOT EXISTS "compass_health"."mcp_pending_input_requests" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "request_state_hash" text NOT NULL,
    "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
    "verified_actor" text NOT NULL,
    "run_id" uuid NOT NULL REFERENCES "compass_health"."agent_runs"("id") ON DELETE CASCADE,
    "tool_name" text NOT NULL,
    "target_id" text NOT NULL,
    "argument_hash" text NOT NULL,
    "idempotency_key" text NOT NULL,
    "input_requests_json" jsonb NOT NULL,
    "payload_json" jsonb NOT NULL,
    "status" text NOT NULL DEFAULT 'pending',
    "expires_at" timestamptz NOT NULL,
    "consumed_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_pending_input_requests_state_hash_uidx"
    ON "compass_health"."mcp_pending_input_requests" ("request_state_hash");
CREATE INDEX IF NOT EXISTS "mcp_pending_input_requests_user_status_idx"
    ON "compass_health"."mcp_pending_input_requests" ("user_id", "status", "expires_at");

CREATE TABLE IF NOT EXISTS "compass_health"."mcp_write_receipts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
    "run_id" uuid NOT NULL REFERENCES "compass_health"."agent_runs"("id") ON DELETE CASCADE,
    "verified_actor" text NOT NULL,
    "tool_name" text NOT NULL,
    "scope_key" text NOT NULL,
    "idempotency_key" text NOT NULL,
    "argument_hash" text NOT NULL,
    "fact_refs_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "outbox_event_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "response_json" jsonb NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_write_receipts_idempotency_uidx"
    ON "compass_health"."mcp_write_receipts"
    ("user_id", "tool_name", "scope_key", "idempotency_key");
CREATE INDEX IF NOT EXISTS "mcp_write_receipts_run_idx"
    ON "compass_health"."mcp_write_receipts" ("run_id", "created_at");
