-- MCB-06: agent-run evidence sequence is a durable per-run total order.
-- Existing duplicates deliberately make this migration fail for manual
-- investigation; silently deleting audit evidence is never acceptable.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_run_steps_run_sequence_uidx"
  ON "compass_health"."agent_run_steps" ("run_id", "sequence");
