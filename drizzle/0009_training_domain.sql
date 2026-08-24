-- WO-HS-01 / M06+M07: structured training domain.

CREATE TABLE IF NOT EXISTS "compass_health"."exercise_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" text NOT NULL UNIQUE,
  "name_zh" text NOT NULL,
  "name_en" text,
  "aliases" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "movement_pattern" text NOT NULL,
  "training_purpose" text NOT NULL DEFAULT 'hypertrophy',
  "primary_muscles" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "secondary_muscles" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "equipment" text,
  "stability_demand" text NOT NULL DEFAULT 'medium',
  "contraindication_tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "regressions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "progressions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "compass_health"."exercise_substitutions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "from_exercise_slug" text NOT NULL,
  "to_exercise_slug" text NOT NULL,
  "retained_note" text,
  "lost_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exercise_substitutions_pair_key' AND conrelid = 'compass_health.exercise_substitutions'::regclass) THEN
    ALTER TABLE "compass_health"."exercise_substitutions"
 ADD CONSTRAINT "exercise_substitutions_pair_key" UNIQUE ("user_id", "from_exercise_slug", "to_exercise_slug");
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "compass_health"."training_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "day_role" text NOT NULL,
  "items_json" jsonb NOT NULL,
  "cycle_pattern" jsonb,
  "source_version_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "compass_health"."training_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "session_date" date NOT NULL,
  "plan_version_id" uuid,
  "status" text NOT NULL DEFAULT 'planned',
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "notes" text,
  "journey_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "training_sessions_user_date_idx"
  ON "compass_health"."training_sessions" ("user_id", "session_date");

CREATE TABLE IF NOT EXISTS "compass_health"."training_session_exercises" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "compass_health"."training_sessions"("id") ON DELETE CASCADE,
  "exercise_slug" text NOT NULL,
  "order_index" integer NOT NULL DEFAULT 0,
  "target_sets" integer NOT NULL DEFAULT 3,
  "target_rep_range_low" integer,
  "target_rep_range_high" integer,
  "target_rir_low" double precision,
  "target_rir_high" double precision,
  "replacement_for_id" uuid,
  "replaced_by_id" uuid,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "training_session_exercises_session_idx"
  ON "compass_health"."training_session_exercises" ("session_id");

CREATE TABLE IF NOT EXISTS "compass_health"."training_set_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_exercise_id" uuid NOT NULL
    REFERENCES "compass_health"."training_session_exercises"("id") ON DELETE CASCADE,
  "set_number" integer NOT NULL,
  "load_value" double precision,
  "load_unit" text,
  "reps" integer,
  "rir" double precision,
  "target_muscle_feel" integer,
  "pain_json" jsonb DEFAULT '[]'::jsonb,
  "performed_at" timestamptz NOT NULL DEFAULT now(),
  "source" text NOT NULL DEFAULT 'ui',
  "idempotency_key" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_set_logs_exercise_set_key' AND conrelid = 'compass_health.training_set_logs'::regclass) THEN
    ALTER TABLE "compass_health"."training_set_logs"
 ADD CONSTRAINT "training_set_logs_exercise_set_key" UNIQUE ("session_exercise_id", "set_number");
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS "training_set_logs_idem_idx"
  ON "compass_health"."training_set_logs" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "compass_health"."training_reflections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "compass_health"."training_sessions"("id") ON DELETE CASCADE,
  "completed_vs_planned_json" jsonb,
  "best_cue_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "unresolved_issues_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "pain_summary_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "proposed_adjustments_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "next_validation_questions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "proposal_plan_version_id" uuid,
  "user_accepted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
