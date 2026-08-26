-- DailyHealthState V2: make the serialized public contract explicit on each projection row.

ALTER TABLE "compass_health"."daily_health_state_projection"
  ADD COLUMN IF NOT EXISTS "schema_version" text NOT NULL DEFAULT 'daily-health-state.v2';

-- Existing V1 JSON remains auditable but must be rebuilt before it is served as V2.
UPDATE "compass_health"."daily_health_state_projection"
SET
  "schema_version" = COALESCE("state_json" ->> 'schemaVersion', 'daily-health-state.v1'),
  "projection_status" = 'lagging',
  "updated_at" = now()
WHERE COALESCE("state_json" ->> 'schemaVersion', 'daily-health-state.v1') <> 'daily-health-state.v2';
