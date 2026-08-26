-- Evidence Privacy: encrypted free-text payloads, explicit reviewer grants,
-- and references from agent_runs. Evidence rows keep only redacted metadata.

CREATE TABLE IF NOT EXISTS "compass_health"."sensitive_payloads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "payload_type" text NOT NULL,
  "ciphertext" text,
  "key_version" text NOT NULL,
  "content_hash" text NOT NULL,
  "content_length" integer NOT NULL,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "retention_until" timestamptz NOT NULL,
  "deleted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sensitive_payloads_length_check" CHECK ("content_length" >= 0),
  CONSTRAINT "sensitive_payloads_ciphertext_lifecycle_check"
    CHECK ("ciphertext" IS NOT NULL OR "deleted_at" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "sensitive_payloads_user_type_idx"
  ON "compass_health"."sensitive_payloads" ("user_id", "payload_type", "created_at");
CREATE INDEX IF NOT EXISTS "sensitive_payloads_retention_idx"
  ON "compass_health"."sensitive_payloads" ("retention_until", "deleted_at");

CREATE TABLE IF NOT EXISTS "compass_health"."sensitive_payload_access_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payload_id" uuid NOT NULL REFERENCES "compass_health"."sensitive_payloads"("id") ON DELETE CASCADE,
  "reviewer_actor_id" uuid NOT NULL REFERENCES "compass_health"."agent_actors"("id") ON DELETE CASCADE,
  "granted_by_actor_id" uuid NOT NULL REFERENCES "compass_health"."agent_actors"("id"),
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sensitive_payload_access_grants_payload_reviewer_key"
    UNIQUE ("payload_id", "reviewer_actor_id")
);

CREATE INDEX IF NOT EXISTS "sensitive_payload_access_grants_reviewer_idx"
  ON "compass_health"."sensitive_payload_access_grants" ("reviewer_actor_id", "revoked_at");

ALTER TABLE "compass_health"."agent_runs"
  ADD COLUMN IF NOT EXISTS "objective_payload_id" uuid,
  ADD COLUMN IF NOT EXISTS "response_summary_payload_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_runs_objective_payload_id_sensitive_payloads_id_fk'
      AND conrelid = 'compass_health.agent_runs'::regclass
  ) THEN
    ALTER TABLE "compass_health"."agent_runs"
      ADD CONSTRAINT "agent_runs_objective_payload_id_sensitive_payloads_id_fk"
      FOREIGN KEY ("objective_payload_id") REFERENCES "compass_health"."sensitive_payloads"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_runs_response_summary_payload_id_sensitive_payloads_id_fk'
      AND conrelid = 'compass_health.agent_runs'::regclass
  ) THEN
    ALTER TABLE "compass_health"."agent_runs"
      ADD CONSTRAINT "agent_runs_response_summary_payload_id_sensitive_payloads_id_fk"
      FOREIGN KEY ("response_summary_payload_id") REFERENCES "compass_health"."sensitive_payloads"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Legacy rows cannot be encrypted during SQL migration because deployment
-- keys deliberately never enter migration files. Remove plaintext in place;
-- new runs can retain encrypted text through sensitive_payloads.
UPDATE "compass_health"."agent_runs"
SET
  "objective" = format('<legacy-redacted:string:length=%s>', char_length("objective")),
  "updated_at" = now()
WHERE "objective" IS NOT NULL
  AND "objective" NOT LIKE '<sensitive:%'
  AND "objective" NOT LIKE '<redacted:%'
  AND "objective" NOT LIKE '<legacy-redacted:%';

UPDATE "compass_health"."agent_runs"
SET
  "response_summary" = format('<legacy-redacted:string:length=%s>', char_length("response_summary")),
  "updated_at" = now()
WHERE "response_summary" IS NOT NULL
  AND "response_summary" NOT LIKE '<sensitive:%'
  AND "response_summary" NOT LIKE '<redacted:%'
  AND "response_summary" NOT LIKE '<legacy-redacted:%';
