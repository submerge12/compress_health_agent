-- Plan Governance: serialize version allocation, bind reflections to proposal
-- arguments, and make exercise range-of-motion safety explicit.

ALTER TABLE "compass_health"."training_reflections"
  ADD COLUMN IF NOT EXISTS "proposal_argument_hash" text;

ALTER TABLE "compass_health"."exercise_definitions"
  ADD COLUMN IF NOT EXISTS "range_of_motion" text NOT NULL DEFAULT 'full';

DO $$
DECLARE
  duplicate_versions text;
BEGIN
  SELECT string_agg(
    format('user=%s scope=%s version=%s count=%s', user_id, scope, version_number, duplicate_count),
    '; '
  )
  INTO duplicate_versions
  FROM (
    SELECT user_id, scope, version_number, count(*) AS duplicate_count
    FROM "compass_health"."plan_versions"
    GROUP BY user_id, scope, version_number
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_versions IS NOT NULL THEN
    RAISE EXCEPTION 'plan version duplicates must be resolved before 0025: %', duplicate_versions;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'plan_versions_user_scope_version_key'
      AND conrelid = 'compass_health.plan_versions'::regclass
  ) THEN
    ALTER TABLE "compass_health"."plan_versions"
      ADD CONSTRAINT "plan_versions_user_scope_version_key"
      UNIQUE ("user_id", "scope", "version_number");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'exercise_definitions_range_of_motion_check'
      AND conrelid = 'compass_health.exercise_definitions'::regclass
  ) THEN
    ALTER TABLE "compass_health"."exercise_definitions"
      ADD CONSTRAINT "exercise_definitions_range_of_motion_check"
      CHECK ("range_of_motion" IN ('reduced', 'full', 'extended'));
  END IF;
END $$;
