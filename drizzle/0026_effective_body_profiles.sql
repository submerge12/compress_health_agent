ALTER TABLE compass_health.bmr_profiles
  ADD COLUMN IF NOT EXISTS goal_weight_kg double precision,
  ADD COLUMN IF NOT EXISTS training_cadence text,
  ADD COLUMN IF NOT EXISTS training_split text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bmr_profiles_goal_weight_positive_chk'
      AND conrelid = 'compass_health.bmr_profiles'::regclass
  ) THEN
    ALTER TABLE compass_health.bmr_profiles
      ADD CONSTRAINT bmr_profiles_goal_weight_positive_chk
      CHECK (goal_weight_kg IS NULL OR goal_weight_kg > 0) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bmr_profiles_user_effective_date_idx
  ON compass_health.bmr_profiles (user_id, effective_date DESC, created_at DESC);
