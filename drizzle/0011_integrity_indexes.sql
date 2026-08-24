-- WO-HS-01 / ownership + integrity indexes for cross-user isolation queries
-- and hot join paths added by M03-M08 features.

CREATE INDEX IF NOT EXISTS "diet_logs_user_date_effective_idx"
  ON "compass_health"."diet_logs" ("user_id", "log_date") WHERE "superseded_by_id" IS NULL;
CREATE INDEX IF NOT EXISTS "diet_logs_correction_of_idx"
  ON "compass_health"."diet_logs" ("correction_of_id") WHERE "correction_of_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "training_sessions_user_status_idx"
  ON "compass_health"."training_sessions" ("user_id", "status");
CREATE INDEX IF NOT EXISTS "training_reflections_session_idx"
  ON "compass_health"."training_reflections" ("session_id");
CREATE INDEX IF NOT EXISTS "outbox_user_aggregate_idx"
  ON "compass_health"."outbox_events" ("user_id", "aggregate_type", "aggregate_id");
CREATE INDEX IF NOT EXISTS "health_observation_events_kind_day_idx"
  ON "compass_health"."health_observation_events" ("kind", "observed_on")
  WHERE "revoked_at" IS NULL;
