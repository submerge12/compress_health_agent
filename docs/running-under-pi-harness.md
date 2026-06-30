# Running compass-health under pi-harness

This is the real way to *use* the agent as an assistant. compass-health is a toolbox (tools +
PostgreSQL + calorie engine); **pi-harness** is the host that supplies the LLM and the
conversation loop. By itself this repo has no chat — `pnpm start` only prints a readiness line.

- Agent name (the `--agent` value): **`compass-health`** (from `compassHealthProfileSpec.name`).
- Model provider: **DeepSeek** — the only secret required is `DEEPSEEK_API_KEY`.
- pi-harness consumes this repo through the `file:../compass-health-agent` link and reads its
  built `dist`. compass-health is already registered in pi-harness's profile index.

For the no-LLM local alternative (invoke one tool from stdin), see `pnpm dev:repl` in the README.

---

## Step 1 — publish this repo's `dist`

```bash
cd G:/compass-health-agent && pnpm build
```

The `file:` link reads `dist`, so rebuild whenever you change this repo's source.

## Step 2 — install pi-harness deps (materializes the link)

```bash
cd G:/pi-harness && npm install
```

## Step 3 — provision the database ⚠️ (easy to miss)

compass-health's `install` hook only opens a connection — it does **not** run migrations or seed.
The `compass_health` schema and preset dishes must already exist in whatever DB pi-harness
connects to. Point both at the same Postgres and provision it from this repo:

```bash
cd G:/compass-health-agent
docker compose up -d         # Postgres on :5433, runs docker/init.sql (schema + pg_trgm)
pnpm db:push                 # create tables in the compass_health schema
pnpm db:seed                 # load 25 preset dishes + seasonings
```

## Step 4 — set env for pi-harness

In `G:/pi-harness/.env` (there is an `.env.example` containing just the key):

```
DEEPSEEK_API_KEY=sk-...your real key...
DATABASE_URL=postgres://compass:compass@localhost:5433/compass_health
```

`DATABASE_URL` must point at the DB you seeded in Step 3.

## Step 5 — build and run pi-harness

```bash
cd G:/pi-harness
npm run build
node dist/cli/index.js --agent compass-health             # chat
node dist/cli/index.js --agent compass-health --scheduler # + meal-checkin / daily-summary crons
```

`node dist/cli/index.js` is the CLI bin; `npx pi-harness ...` also works if it's linked globally.
The full usage string is:

```
pi-harness [--agent name] [--scheduler] [--cwd path] [--provider name] [--model id]
           [--api-key key] [--continue|--resume id|--list-sessions] [prompt...]
```

That last command drops you into the chat — type in Chinese or English; it will ask for your
profile, then log meals, plan, and report.

---

## Troubleshooting (most likely failures, in order)

1. **`docker compose up -d` fails** — Docker engine not running. Fix this first; nothing
   DB-backed works without it.
2. **Chat starts but tool calls error with *relation does not exist*** — Step 3 was skipped, or
   `DATABASE_URL` in Step 4 points at a different DB than you seeded.
3. **Agent won't start / auth error** — `DEEPSEEK_API_KEY` missing or invalid.

## Boundary note

Steps 2 and 5 modify pi-harness (`node_modules`, `dist`). Run them from a pi-harness session or
your own shell — per this repo's CLAUDE.md, the compass-health agent must never modify
`G:\pi-harness`. Only Steps 1 and 3 belong to this repo.

---

# Monitoring the running agent with Claude Code

This agent runs locally, so it doesn't need real-time monitoring. A **once-a-day batch review** is
the right fit: cheaper, simpler, and a day's delay is fine when nothing is on fire. You store the
records locally as the agent runs, then have Claude Code read through them once a day and flag
problems.

> If you ever *do* want live alerting instead, Claude Code can poll on an interval (`/loop Nm
> <check>`) or run a background log watcher — but for a local agent that's overkill.

## You already have two local record stores

1. **The database is already durable and local.** Postgres lives in the Docker volume (`pgdata`),
   so every structured record — `compass_health.diet_logs`, `meal_plan_entries`, `memory_records`,
   plus pi-harness core's `public.agent_events` / `public.notifications` — persists across restarts
   with timestamps. This is the **authoritative per-day source**; nothing extra is needed to store
   it.
2. **Logs need capturing to a file** — otherwise stdout is ephemeral. This is the only new step,
   and it's where stack traces / errors live that the DB won't show.

## Step 1 — capture logs to a dated file

```powershell
cd G:\pi-harness
$log = "logs\compass-health-$(Get-Date -Format yyyy-MM-dd).log"
node dist/cli/index.js --agent compass-health --scheduler *>> $log
```

One file per day (`*>>` appends stdout+stderr). If the process runs past midnight it keeps writing
to the start-day's file — that's fine, because the review filters on **DB timestamps**, not the
filename.

## Step 2 — review once a day

Both ways run the same prompt — see `daily-review-prompt.md` for the full, ready-to-run text.

**(a) Manual — simplest.** Once a day, open Claude Code in this repo and paste the contents of
`docs/daily-review-prompt.md`. Zero setup; run it whenever you remember.

**(b) Automated local — headless, no open session.** A Windows Task Scheduler job runs Claude Code
in print mode once a day and drops a dated report you skim later:

```powershell
# Task Scheduler action, daily at e.g. 23:30:
claude -p (Get-Content G:\compass-health-agent\docs\daily-review-prompt.md -Raw)
```

This runs fully locally — reads the local log + DB, writes `reports/agent-health-YYYY-MM-DD.md`,
no `/loop`, no cloud. Start with (a); graduate to (b) once you trust what "normal" looks like.

## What "healthy" vs. "problem" looks like

| Signal | Healthy | Problem |
|---|---|---|
| Log (the day's file) | no error/throw lines | `ECONNREFUSED` (DB/Docker down), stack traces, repeated retries |
| DB writes | `diet_logs` / `meal_plan_entries` rows from the day; `max(created_at)` recent | no rows or a frozen `max(created_at)`; query errors (`relation does not exist` → schema/seed gap) |
| Scheduler | check-in / summary traces around 08:30 / 12:30 / 18:30 / 00:00 | those windows silent → scheduler not firing |

## Boundary note (monitoring)

Reading `G:\pi-harness`'s log and DB is fine. A review must never *edit* pi-harness or restart it
by modifying its files — if the agent is down, surface it in the report and restart the process
manually. The read-only rule still applies.
