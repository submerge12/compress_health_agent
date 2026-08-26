-- MCB-08: formal actor binding and complete tool terminal evidence.

ALTER TABLE "compass_health"."agent_actors"
  ADD COLUMN IF NOT EXISTS "binding_key" text;

UPDATE "compass_health"."agent_actors"
SET "binding_key" = 'legacy:' || "id"::text
WHERE "binding_key" IS NULL;

INSERT INTO "compass_health"."agent_actors" (
  "binding_key", "actor_type", "runtime_name", "agent_profile", "status"
) VALUES (
  'legacy:unattributed', 'other', 'legacy', 'legacy-unattributed', 'retired'
) ON CONFLICT DO NOTHING;

UPDATE "compass_health"."agent_runs"
SET "actor_id" = (
  SELECT "id" FROM "compass_health"."agent_actors"
  WHERE "binding_key" = 'legacy:unattributed'
)
WHERE "actor_id" IS NULL;

ALTER TABLE "compass_health"."agent_actors"
  ALTER COLUMN "binding_key" SET NOT NULL;
ALTER TABLE "compass_health"."agent_runs"
  ALTER COLUMN "actor_id" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_actors_binding_key_uidx"
  ON "compass_health"."agent_actors" ("binding_key");
CREATE INDEX IF NOT EXISTS "agent_runs_actor_idx"
  ON "compass_health"."agent_runs" ("actor_id", "started_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_runs_actor_id_agent_actors_id_fk'
      AND conrelid = 'compass_health.agent_runs'::regclass
  ) THEN
    ALTER TABLE "compass_health"."agent_runs"
      ADD CONSTRAINT "agent_runs_actor_id_agent_actors_id_fk"
      FOREIGN KEY ("actor_id") REFERENCES "compass_health"."agent_actors"("id");
  END IF;
END $$;

ALTER TABLE "compass_health"."agent_run_steps"
  ADD COLUMN IF NOT EXISTS "failure_stage" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_run_steps_status_check'
      AND conrelid = 'compass_health.agent_run_steps'::regclass
  ) THEN
    ALTER TABLE "compass_health"."agent_run_steps"
      ADD CONSTRAINT "agent_run_steps_status_check"
      CHECK ("status" IN ('ok', 'failed', 'refused', 'input_required'));
  END IF;
END $$;
