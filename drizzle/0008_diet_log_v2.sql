-- WO-HS-01 / M05: DietLogV2 metadata columns + partial unique idempotency index.
-- Nullable columns so legacy rows stay untouched; the partial unique index only
-- covers non-null keys (matches the manually applied live DDL).

ALTER TABLE "compass_health"."diet_logs"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "estimate_confidence" double precision,
  ADD COLUMN IF NOT EXISTS "uncertain" boolean,
  ADD COLUMN IF NOT EXISTS "correction_of_id" uuid,
  ADD COLUMN IF NOT EXISTS "superseded_by_id" uuid,
  ADD COLUMN IF NOT EXISTS "journey_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "diet_logs_user_idempotency_key_uidx"
  ON "compass_health"."diet_logs" ("user_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
