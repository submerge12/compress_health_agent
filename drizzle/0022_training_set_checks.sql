-- MCB-09: training set telemetry is defended by the database as well as the domain service.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_set_logs_set_number_check' AND conrelid = 'compass_health.training_set_logs'::regclass) THEN
    ALTER TABLE "compass_health"."training_set_logs"
      ADD CONSTRAINT "training_set_logs_set_number_check" CHECK ("set_number" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_set_logs_reps_check' AND conrelid = 'compass_health.training_set_logs'::regclass) THEN
    ALTER TABLE "compass_health"."training_set_logs"
      ADD CONSTRAINT "training_set_logs_reps_check" CHECK ("reps" IS NULL OR "reps" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_set_logs_load_value_check' AND conrelid = 'compass_health.training_set_logs'::regclass) THEN
    ALTER TABLE "compass_health"."training_set_logs"
      ADD CONSTRAINT "training_set_logs_load_value_check" CHECK (
        "load_value" IS NULL OR (
          "load_value" >= 0
          AND "load_value" NOT IN ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_set_logs_rir_check' AND conrelid = 'compass_health.training_set_logs'::regclass) THEN
    ALTER TABLE "compass_health"."training_set_logs"
      ADD CONSTRAINT "training_set_logs_rir_check" CHECK (
        "rir" IS NULL OR ("rir" = trunc("rir") AND "rir" BETWEEN 0 AND 10)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_set_logs_target_muscle_feel_check' AND conrelid = 'compass_health.training_set_logs'::regclass) THEN
    ALTER TABLE "compass_health"."training_set_logs"
      ADD CONSTRAINT "training_set_logs_target_muscle_feel_check" CHECK (
        "target_muscle_feel" IS NULL OR "target_muscle_feel" BETWEEN 1 AND 5
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_set_logs_pain_json_check' AND conrelid = 'compass_health.training_set_logs'::regclass) THEN
    ALTER TABLE "compass_health"."training_set_logs"
      ADD CONSTRAINT "training_set_logs_pain_json_check" CHECK (
        "pain_json" IS NULL OR (
          jsonb_typeof("pain_json") = 'array' AND jsonb_array_length("pain_json") <= 8
        )
      );
  END IF;
END $$;
