-- P0-5 / P0-6 / P0-7 schema additions. 0000-0013 are frozen; repairs and new
-- features land here.

-- ── P0-5: explicit cycle instances/positions ────────────────────────────────
CREATE TABLE IF NOT EXISTS "compass_health"."training_cycle_instances" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
    "cycle_version_id" uuid,
    "status" text DEFAULT 'active' NOT NULL,
    "started_at" timestamp with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "training_cycle_instances_user_idx"
    ON "compass_health"."training_cycle_instances" ("user_id", "status");

CREATE TABLE IF NOT EXISTS "compass_health"."training_cycle_positions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "cycle_instance_id" uuid NOT NULL REFERENCES "compass_health"."training_cycle_instances"("id") ON DELETE CASCADE,
    "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
    "position_index" integer NOT NULL,
    "position_role" text NOT NULL,
    "session_id" uuid,
    "status" text DEFAULT 'pending' NOT NULL,
    "reason" text,
    "position_date" date,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "training_cycle_positions_instance_idx"
    ON "compass_health"."training_cycle_positions" ("cycle_instance_id", "position_index");

-- ── P0-6: durable substitution proposals ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "compass_health"."substitution_proposals" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
    "session_id" uuid NOT NULL REFERENCES "compass_health"."training_sessions"("id") ON DELETE CASCADE,
    "session_exercise_id" uuid NOT NULL REFERENCES "compass_health"."training_session_exercises"("id") ON DELETE CASCADE,
    "source_revision" integer DEFAULT -1 NOT NULL,
    "remaining_sets" integer NOT NULL,
    "candidate_json" jsonb NOT NULL,
    "constraint_snapshot_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "equipment_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "expires_at" timestamp with time zone DEFAULT now() + interval '6 hours' NOT NULL,
    "status" text DEFAULT 'pending' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "applied_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "substitution_proposals_user_idx"
    ON "compass_health"."substitution_proposals" ("user_id", "session_id", "status");

-- ── P0-7: media metadata the streaming route must trust ─────────────────────
ALTER TABLE "compass_health"."media_assets"
    ADD COLUMN IF NOT EXISTS "source_role" text DEFAULT 'technique_details' NOT NULL;
ALTER TABLE "compass_health"."media_assets"
    ADD COLUMN IF NOT EXISTS "content_type" text DEFAULT 'video/mp4' NOT NULL;

-- Backfill source_role for assets that predate the manifest column.
UPDATE "compass_health"."media_assets"
SET "source_role" = CASE trainer
        WHEN 'kaishengwang' THEN 'main_program'
        WHEN 'curun' THEN 'chest_specialist'
        ELSE 'technique_details'
    END
WHERE "kind" = 'video' AND "source_role" = 'technique_details';
