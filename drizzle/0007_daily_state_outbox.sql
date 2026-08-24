-- WO-HS-01 / M03+M04: daily state facts, outbox, interaction events, projections.
-- Idempotent (IF NOT EXISTS) so it can run against a DB where these were
-- created earlier via drizzle-kit push without duplicating anything.

CREATE TABLE IF NOT EXISTS "compass_health"."plan_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "parent_version_id" uuid,
  "version_number" integer NOT NULL DEFAULT 1,
  "content_json" jsonb NOT NULL,
  "adjustment_reason" text,
  "previous_version_problems" jsonb DEFAULT '[]'::jsonb,
  "validation_questions" jsonb DEFAULT '[]'::jsonb,
  "created_by_actor" text NOT NULL DEFAULT 'user',
  "activated_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "plan_versions_user_scope_idx"
  ON "compass_health"."plan_versions" ("user_id", "scope", "status");

CREATE TABLE IF NOT EXISTS "compass_health"."active_plan_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "plan_version_id" uuid NOT NULL REFERENCES "compass_health"."plan_versions"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'active_plan_assignments_user_scope_key' AND conrelid = 'compass_health.active_plan_assignments'::regclass) THEN
    ALTER TABLE "compass_health"."active_plan_assignments"
 ADD CONSTRAINT "active_plan_assignments_user_scope_key" UNIQUE ("user_id", "scope");
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "compass_health"."health_observation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "observed_on" date NOT NULL,
  "kind" text NOT NULL,
  "value_json" jsonb NOT NULL,
  "source" text NOT NULL DEFAULT 'user',
  "revoked_at" timestamptz,
  "journey_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "health_observation_events_user_day_idx"
  ON "compass_health"."health_observation_events" ("user_id", "observed_on", "kind");

CREATE TABLE IF NOT EXISTS "compass_health"."health_constraints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "constraint_type" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'warn',
  "target_json" jsonb NOT NULL,
  "reason" text NOT NULL,
  "active_from" date NOT NULL,
  "active_to" date,
  "lifted_at" timestamptz,
  "lifted_by_actor" text,
  "source_observation_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "health_constraints_user_active_idx"
  ON "compass_health"."health_constraints" ("user_id", "active_from");

CREATE TABLE IF NOT EXISTS "compass_health"."user_decision_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "decision_type" text NOT NULL,
  "subject_json" jsonb NOT NULL,
  "journey_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "compass_health"."outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "aggregate_type" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "type" text NOT NULL,
  "payload_json" jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "outbox_events_status_available_idx"
  ON "compass_health"."outbox_events" ("status", "available_at");

CREATE TABLE IF NOT EXISTS "compass_health"."interaction_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid,
  "request_id" text,
  "journey_id" text,
  "actor" text NOT NULL DEFAULT 'web',
  "stage" text NOT NULL,
  "stage_code" text NOT NULL,
  "detail_json" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "interaction_events_journey_idx" ON "compass_health"."interaction_events" ("journey_id");
CREATE INDEX IF NOT EXISTS "interaction_events_stage_idx" ON "compass_health"."interaction_events" ("stage", "stage_code");

CREATE TABLE IF NOT EXISTS "compass_health"."projection_checkpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "projection_name" text NOT NULL,
  "checkpoint_key" text NOT NULL,
  "last_event_at" timestamptz,
  "status" text NOT NULL DEFAULT 'fresh',
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projection_checkpoints_name_key_key' AND conrelid = 'compass_health.projection_checkpoints'::regclass) THEN
    ALTER TABLE "compass_health"."projection_checkpoints"
 ADD CONSTRAINT "projection_checkpoints_name_key_key" UNIQUE ("projection_name", "checkpoint_key");
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "compass_health"."daily_health_state_projection" (
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "state_date" date NOT NULL,
  "revision" integer NOT NULL DEFAULT 0,
  "timezone" text NOT NULL DEFAULT 'UTC',
  "state_json" jsonb NOT NULL,
  "source_event_count" integer NOT NULL DEFAULT 0,
  "projection_status" text NOT NULL DEFAULT 'fresh',
  "built_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "state_date")
);
