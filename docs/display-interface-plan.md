# Display interface plan (C:\Users\Holly\compass-health as the UI)

**Date:** 2026-07-05
**Status:** P0 (this contract) + P1 (display server) implemented; P2+ pending.
**Decision:** the v0 full-stack project at `C:\Users\Holly\compass-health` becomes the *display
interface* for the pi-harness agent. Its frontend is rewired to a new display API served from this
package; its FastAPI backend and `compass.db` (SQLite) retire as a read-only archive. There is one
source of truth (Postgres `compass_health`) and one behavior layer (this package's tool handlers) —
the chat agent and the display UI are two clients of the same handlers.

```
frontend (C:\Users\Holly\compass-health\frontend, rewired in P2)
        |  fetch JSON
        v
display server (this repo: src/server/, `pnpm serve:display`)
        |  thin adapters: route -> existing tool handler
        v
handlers (generate / swap / checkin / summary / report / logs / profile)
        v
Postgres compass_health  <-- same DB, same rows as the pi-harness chat agent
```

## Why writes must go through handlers

A check-in button that wrote SQLite (or raw Postgres) would be invisible to the W2 behavior loop
that adjusts next week's pool. Every UI write maps to the same handler the chat agent calls, so
swaps re-lever the day, check-ins attach to plan rows, and regeneration supersedes safely — the
duplicate-row defenses from the review fix pass are what make two concurrent clients safe.

## Auth model (v1)

- Server binds `127.0.0.1` by default (`COMPASS_DISPLAY_HOST` to override deliberately).
- Optional static bearer token: set `COMPASS_DISPLAY_TOKEN` and every `/api/*` request must send
  `Authorization: Bearer <token>`; unset means localhost-trusted single-user mode.
- CORS allows exactly one origin (`COMPASS_DISPLAY_CORS_ORIGIN`, default `http://localhost:5500`).
- Single user: the context is `createToolContextFromEnv()` → `COMPASS_HEALTH_USER_ID` or
  `default-user`. Multi-user is explicitly out of scope until P5.

## API contract (v1)

All responses are JSON. Handler `RangeError`s map to `400 {"error": message}` — including
swap refusals, whose message names currently-valid swaps and is intended as UI copy. Unknown
routes are 404; unexpected failures are `500 {"error":"internal error"}` (detail in server log).

| Route | Handler / source | Input | Notes |
| --- | --- | --- | --- |
| `GET /api/health` | — | — | `{ok, userId}` liveness + which user |
| `GET /api/profile` | `handleGetProfile` | — | profile row + calorie plan; null profile if none |
| `POST /api/profile` | `handleSetProfile` | `{sex, ageYears, heightCm, weightKg, activityLevel, goal}` | recomputes targets (fat floor 0.7 g/kg male) |
| `GET /api/plan?start=YYYY-MM-DD&days=7` | `repo.listMealPlanEntriesRange` | query | stored rows grouped by date; read-only display query |
| `POST /api/plan/generate` | `handleSmartGenerateMealPlan` | `{startDate?}` | full result: plan, pool, notices, alternates, procurement, overview; supersedes planned rows |
| `POST /api/swap` | `handleSwapMeal` | `{date, mealType, alternateSlug}` | re-levers the day; 400 with suggestions when the swap would break it |
| `POST /api/checkin` | `handleMealCheckin` | `{date, mealType, status, actualDescription?}` | status: followed / substituted / skipped |
| `GET /api/summary?date=` | `handleDailySummary` | query | eaten vs target vs remaining, water, exercise |
| `GET /api/report?endDate=` | `handleWeeklyReport` | query | 7-day report incl. weekly budget line |
| `GET /api/recommend?mealType=&maxKcal?=` | `handleSmartRecipeRecommend` | query | recipe ideas for one meal |
| `POST /api/log/meal` | `handleLogMeal` | `{date, mealType, description}` | free-text off-plan meals |
| `POST /api/log/water` | `handleLogWater` | `{date, description}` | description carries the amount ("500ml") |
| `POST /api/log/exercise` | `handleLogExercise` | `{date, description}` | |
| `POST /api/log/weight` | `handleLogWeight` | `{date, description}` | |

Not exposed on purpose: `remember`/`recall` (memory stays a conversation concern),
`propose_dish`/`save_dish` (dish curation needs the review dialogue), `update_cooking_record`.
If the UI later needs them, they join the contract rather than bypassing it.

## Frontend page triage (P2 scope)

Keep and rewire: `meal_engine` (weekly plan — the main adaptation: natural-unit portions, top-ups,
alternates chips, budget bars, notices banner), `dashboard`, `diet`, `water`, `exercise`, `bmr`
(profile), `stats`, `settings`, `i18n`. Drop for v1: `admin`, `community_recipes`, `condition`,
`preferences` (preference capture lives in chat via remember/W2), `assistant_widget` (conversation
stays in pi-harness), `auth` (replaced by the token header).

## Phases

- **P0 — this contract.** Done.
- **P1 — display server.** `src/server/display-server.ts` (`createDisplayServer(ctx, options)`,
  dependency-free `node:http`) + `src/server/serve.ts` entry + `pnpm serve:display`; contract
  tests with a fake context (no DB needed). Done.
- **P2 — rewire the frontend** (`api.js` endpoint map, `meal_engine.js` for the v2 plan shape).
  Work happens in the `C:\Users\Holly\compass-health` repo.
- **P3 — v2-native UI**: 换一个 alternates chips, weekly budget bars, pool/grocery view, notices
  banner, one-tap check-ins.
- **P4 — cutover**: `start.bat` boots the display server + static frontend; old backend stops.
- **P5 — later**: miniprogram client, non-localhost auth, chat embedding.
