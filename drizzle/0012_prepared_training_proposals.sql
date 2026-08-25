-- WO-HS-06 / M20: prepared training proposals bridge prepare -> start so the
-- constraint-filtered plan (not the raw template) is what becomes a session.

CREATE TABLE IF NOT EXISTS "compass_health"."prepared_training_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "session_date" date NOT NULL,
  "day_role" text NOT NULL,
  "source_daily_state_revision" integer NOT NULL DEFAULT -1,
  "plan_version_id" uuid,
  "proposal_json" jsonb NOT NULL,
  "constraints_snapshot_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "expires_at" timestamptz NOT NULL DEFAULT now() + interval '12 hours',
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "consumed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "prepared_training_proposals_user_idx"
  ON "compass_health"."prepared_training_proposals" ("user_id", "session_date", "status");
