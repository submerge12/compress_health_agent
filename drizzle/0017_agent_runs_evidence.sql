-- P3 / WO-MCP: Agent Run, Evidence and Review data layer (plan §八).
-- interaction_events remains the low-level domain log; these tables index
-- one agent user journey at a higher level and never copy raw payloads.

CREATE TABLE IF NOT EXISTS "compass_health"."agent_actors" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "actor_type" text DEFAULT 'other' NOT NULL,
    "runtime_name" text,
    "runtime_version" text,
    "agent_profile" text,
    "agent_profile_version" text,
    "model_provider" text,
    "model_name" text,
    "status" text DEFAULT 'active' NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "agent_actors_type_idx"
    ON "compass_health"."agent_actors" ("actor_type", "status");

CREATE TABLE IF NOT EXISTS "compass_health"."agent_runs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
    "actor_id" uuid,
    "journey_id" text,
    "objective" text,
    "input_channel" text DEFAULT 'mcp' NOT NULL,
    "mode" text DEFAULT 'production' NOT NULL,
    "started_at" timestamptz DEFAULT now() NOT NULL,
    "finished_at" timestamptz,
    "outcome" text DEFAULT 'running' NOT NULL,
    "response_summary" text,
    "parent_run_id" uuid,
    "comparison_group_id" uuid,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "agent_runs_user_started_idx"
    ON "compass_health"."agent_runs" ("user_id", "started_at");
CREATE INDEX IF NOT EXISTS "agent_runs_journey_idx"
    ON "compass_health"."agent_runs" ("journey_id");

CREATE TABLE IF NOT EXISTS "compass_health"."agent_run_steps" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "run_id" uuid NOT NULL REFERENCES "compass_health"."agent_runs"("id") ON DELETE CASCADE,
    "sequence" integer NOT NULL,
    "stage" text NOT NULL,
    "mcp_method" text,
    "mcp_name" text,
    "resource_uri" text,
    "aggregate_type" text,
    "aggregate_id" text,
    "state_revision_before" integer,
    "state_revision_after" integer,
    "status" text DEFAULT 'ok' NOT NULL,
    "error_code" text,
    "arguments_redacted_json" jsonb,
    "result_summary_json" jsonb,
    "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "agent_run_steps_run_idx"
    ON "compass_health"."agent_run_steps" ("run_id", "sequence");

CREATE TABLE IF NOT EXISTS "compass_health"."review_findings" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "reviewer_actor_id" uuid,
    "target_run_id" uuid NOT NULL REFERENCES "compass_health"."agent_runs"("id") ON DELETE CASCADE,
    "verdict" text NOT NULL,
    "failure_stage" text,
    "severity" text,
    "rule_code" text,
    "evidence_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "recommended_target" text,
    "recommended_change" text,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "review_findings_run_idx"
    ON "compass_health"."review_findings" ("target_run_id");
