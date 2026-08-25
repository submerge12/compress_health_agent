-- P2.2 MCB-01: durable projection worker ownership and crash recovery.

ALTER TABLE "compass_health"."outbox_events"
  ADD COLUMN IF NOT EXISTS "processing_started_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "locked_by" text,
  ADD COLUMN IF NOT EXISTS "lock_expires_at" timestamptz;

CREATE INDEX IF NOT EXISTS "outbox_events_claim_idx"
  ON "compass_health"."outbox_events" ("status", "available_at", "lock_expires_at", "created_at");

