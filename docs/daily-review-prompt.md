You are reviewing the locally-running **compass-health** agent (running under pi-harness) for the
last 24 hours. Read through the local records, find problems, and write a short report. Do not
modify anything in `G:\pi-harness` — read only.

## Records to read

1. **Today's log file**: `G:\pi-harness\logs\compass-health-<today>.log` (also check yesterday's
   file if the run started before midnight). Scan for `error`, `throw`, `unhandled`,
   `ECONNREFUSED`, and stack traces.
2. **The database** (`compass_health` schema + pi-harness `public`). Use `$DATABASE_URL` or
   `postgres://compass:compass@localhost:5433/compass_health`:
   ```sql
   select count(*) as logs_24h, max(created_at) as last_log
     from compass_health.diet_logs where created_at > now() - interval '1 day';
   select count(*) as plans_24h, max(created_at) as last_plan
     from compass_health.meal_plan_entries where created_at > now() - interval '1 day';
   select count(*) as memories_24h
     from compass_health.memory_records where updated_at > now() - interval '1 day';
   -- pi-harness core events (adjust column names to the actual schema if needed):
   select * from public.agent_events where created_at > now() - interval '1 day' order by created_at desc limit 50;
   ```

## What to flag

- Any error / stack trace in the log (quote the line + timestamp).
- `ECONNREFUSED` or DB connection failures → Docker/Postgres was down.
- `relation does not exist` → the `compass_health` schema or seed is missing (provisioning gap).
- Frozen activity: `max(created_at)` not advancing, or zero rows for a day you know you used it.
- Scheduled tasks that didn't fire: the breakfast/lunch/dinner check-ins and midnight summary
  (crons at 08:30 / 12:30 / 18:30 / 00:00) leaving no trace in logs or `agent_events`.

## Output

Write the report to `reports/agent-health-<today>.md` (create `reports/` if absent) with:

- **Verdict** — one line: `clean` or `problems found`.
- **Activity summary** — row counts + latest write times from the DB queries above.
- **Problems** — each with evidence (log line + timestamp, or the failing query), most severe
  first. If none, say so explicitly.
- **Suggested next step** — only if problems were found (e.g. "restart the agent", "run
  `pnpm db:push`", "start Docker"). Do not perform these — just recommend.

If everything is clean, still write the report (a daily trail is useful) and reply `clean` in the
chat. If problems were found, reply `problems found` plus the one-line verdict.
