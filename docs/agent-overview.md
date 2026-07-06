# Compass Health Agent — Overview

Canonical onboarding reference for how the agent is structured and runs. For deeper detail see the
companion specs: `data-architecture.md`, `meal-plan-constraint-spec.md`, `meal-composition-model.md`,
`add-dish-ingestion-spec.md`, `l2-l3-retrieval-and-memory-plan.md`, `scheduled-reminders-and-habits-spec.md`,
and `pi-harness-pending-changes.md`.

## Architecture — two pieces

- **`compass-health-agent` (this repo) = the domain agent.** Owns the *what*: tool handlers, meal
  planning, nutrition, classification, memory. It is **framework-agnostic** — it defines local
  profile-compatible types and does **not** import pi-harness internals.
- **`pi-harness` = the runtime framework.** Owns *how it runs*: the LLM loop, **tool dispatch**, the
  permission gate, the scheduler, and context management.

They are joined by a `file:` link — pi-harness consumes this repo's built `dist`. After the "Option-B"
refactor, the framework's `profile.ts` is a thin adapter that spreads this repo's
`compassHealthProfileSpec` and delegates `proactiveCheck`/`install`; its `tools.ts` holds TypeBox tool
registrations that call this repo's handlers.

## Data — 5 layers

| Layer | What | Where | Initial state |
|---|---|---|---|
| 0 | **Reference catalog** — ingredients + nutrition + classification, seasonings, aliases, natural units | `food_items`, `seasonings`, `natural_units`, `food_aliases` | **seeded** (`pnpm db:seed`) |
| 1 | **Dish candidate library** | 25 preset dishes (6 breakfast / 14 mains / 5 sides, code in `preset-dishes.ts`) ∪ `user_dishes` (DB) | presets only; `user_dishes` empty |
| 2 | **Planned meals** | `meal_plan_entries` | empty |
| 3 | **Actual logs** | `diet_logs`, `water_logs`, `exercise_logs`, `physical_conditions` | empty |
| 4 | **Profile & memory** | `bmr_profiles`, `memory_records`, `user_seasoning_preferences`, `users` | empty until first use |

> "Empty database" means layers 1–4 user data are empty — **not** layer 0. The catalog must be seeded
> or nutrition/classification can't resolve.

## Tool flow (runtime path)

```
LLM ──(pi-harness)──► tool call
   → pi-harness tools.ts: TypeBox validate + permission gate (read-only | write)
   → execute() → this repo's handler, e.g. handleLogMeal(ctx, params)
   → ToolContext { repo, catalog, seasoningRecords, userId, locale }
   → Postgres
```

`ToolContext` is built once by the `install` hook (`createToolContextFromEnv → initToolContext`: open
DB + load catalog). **16 tools:** `set_profile`, `log_meal`/`log_water`/`log_exercise`/`log_weight`,
`daily_summary`, `weekly_report`, `nutrition_estimate`, `recipe_recommend`, `generate_meal_plan`,
`meal_checkin`, `update_cooking_record`, `propose_dish`, `save_dish`, `remember`, `recall`.

## Meal-plan generation logic

`handleSmartGenerateMealPlan` loads candidates (presets ∪ user_dishes, each **classified** into buckets),
targets (`bmr_profiles`), and preferences, then:

1. **H1 — exclusions:** drop any dish containing a rejected ingredient/seasoning/allergen.
2. **Enumerate** per day: `breakfast × main × main`, and for each main a **side option**
   (`[no side]` if the main is `selfContained`, else the side pool).
3. **Compose** each meal = `main + side + staple`, and **solve the staple (rice) grams to hit the daily
   energy band (H2)** — calories are closed by the rice lever, not by filtering dishes.
4. **Score** the day (lower is better): strong penalties for the **protein floor (H4, 80% of target)**
   and the energy band, plus the soft objective — **weekly floors** (`red_meat >= 2`, `deep_sea_fish >= 2`,
   `shellfish >= 1`, sourced from config so an absent bucket still counts), sodium, repetition, diversity,
   recency, preference. Greedy per-day pick of the min-penalty combo.
5. **Best-effort:** always returns a plan; unmet floors/bands are **reported**, never hidden.
6. **Advisory (post-hoc):** coverage report (unmet floors), procurement list (×1.15, round 10 g,
   includes the staple), daily kcal/protein threshold warnings.

### Hard Gates Vs Soft Objective
- **Hard filter:** H1 exclusions only (`filterUsableCandidates`) — rejected ingredients, rejected seasonings,
  and allergens are removed before enumeration.
- **Strong soft penalties + reported violations:** H2 energy band and H4 protein floor never reject a plan.
  They are heavily weighted in `comboScore`, and misses are reported through `hardViolations`.
- **Structural invariant:** H3 is the generated shape (breakfast + 2 mains, with sides/staples composed as
  needed). The planner is best-effort: it always returns the lowest-penalty plan it can find.

## Dish composition model

A **meal = main dish + (optional side) + staple**:
- **Dishes carry only their own ingredients** — no rice, no bundled side.
- **Staple** = a separate `brown_rice` component, portion-solved (40–180 g) to close calories.
- **Side** = a separate `vegetable`/`soup` dish, added only when the main is **not** `selfContained`
  (option B; the old "X配Y" composites were split into a `main` + a `side`).
- Dish fields: `role: "main" | "side"`, `sideKind?: "vegetable" | "soup"`, `selfContained?` (mains).

## Memory & retrieval (L2 + L3)

- **L2 — food resolution:** `food-matcher.ts` normalizes zh/en/traditional/full-width + synonyms
  (西红柿→番茄, 鸡蛋→蛋), then matches **exact → alias → trigram**. Below a confidence threshold it
  returns `needsConfirmation` candidates instead of guessing. Wired into `nutrition_estimate`.
- **L3 — episodic memory:** `memory_records` (kind = `preference | dislike | routine | note`) with
  subject-scoped supersession: the same `(kind, subject)` and changed `content` creates a new active row and
  marks the prior row superseded. Recall normalizes content into `content_norm`, searches it with a
  `pg_trgm` GIN index and `word_similarity`, then applies a small recency factor in SQL.

## pi-harness interaction

- The framework **registers** each tool (TypeBox schema + access level + an `execute` that calls this
  repo's handler) and runs the loop + scheduler. The repo owns the handler logic.
- **Edit pi-harness only when the tool *surface* changes** (a new tool, or a tool's parameters change).
  Logic/preset changes just need `pnpm build` of this repo.
- **One pending pi-harness change** (`pi-harness-pending-changes.md`): add `role`/`sideKind`/
  `selfContained` to the `propose_dish`/`save_dish` schemas. Main-dish saves tolerate those fields being
  absent, but the LLM cannot create side dishes or non-self-contained mains until the framework schema exposes them.

## How it runs — concrete examples

**A. Logging a meal (L2).** "中午吃了西红柿炒蛋" → `log_meal` → matcher folds 西红柿→番茄 / 鸡蛋→蛋 →
catalog slugs → nutrition from `food_items` → row in `diet_logs`.

**B. Weekly plan.** "生成这周的餐单" (1771 kcal / 140 g protein) → `generate_meal_plan` composes e.g.
**Mon**: 豆浆鸡蛋馒头 / 洋葱炒牛肉 + 蒜蓉西兰花 + 糙米饭 110 g / 清蒸鲷鱼 + 香菇小白菜 + 糙米饭 100 g.
Rice grams flex to hit the band; the week satisfies red_meat 2 / deep-sea fish ≥2 / shellfish ≥1; entries
persist to `meal_plan_entries` with the staple folded in.

**C. Add a dish (propose -> approve -> save).** "Add scallion tofu: 280g tofu, 20g scallion" -> `propose_dish` resolves
only explicitly quantified ingredients (`<number>g <food>`), **computes nutrition from the catalog**,
classifies `soy_product`, shows the draft -> on approval
`save_dish` writes to `user_dishes` → it's a candidate in the next plan.

**D. Remember a preference.** "I don't eat cilantro" -> `remember` (kind `dislike`, subject `cilantro`) ->
`memory_records`; later `recall("cilantro")` or a short Chinese query for 香菜 searches `content_norm`
through `pg_trgm` and surfaces the active row before recommendations. If the same subject changes later
(for example, "I can eat a little cilantro now"), the old row is superseded.

**E. Proactive reminder (scheduled).** At 18:30 the scheduler fires `proactiveCheck` → dinner check-in
plus a 🧊 thaw reminder because tomorrow's planned meal contains 带鱼 (a `deep_sea_fish` ingredient).

## Current state / caveats

- DB is a **clean start** — presets only; no profile/logs/user dishes until the user acts.
- Work lives on branch `codex/pi-harness-alignment`, **not pushed**; the pi-harness adapter is wired, with
  only the noted add-dish schema fields pending on the framework side.
- DB-integration tests are **skipped without Postgres**. The `pg_trgm` recall path was verified against local
  PostgreSQL on 2026-06-27: `tests/db/integration.test.ts` ran 14/14 tests, including the index-use `EXPLAIN`
  probe for `memory_records_content_norm_trgm_idx`.

## Known follow-ups
- Apply the pending pi-harness `propose_dish`/`save_dish` schema change to enable adding side dishes.
- Hard per-dish weekly usage cap (the salad-over-use mitigation), and/or a realistic protein target.
- A generative `suggest_dishes` flow (turn an ingredient into dish options to curate) — not built.
- Scheduled reminders + habit learning (`scheduled-reminders-and-habits-spec.md`) — deferred.
- One real-DB end-to-end run.
