# Data Architecture

**Status:** Canonical reference
**Scope:** How `compass-health-agent` data is partitioned, what is seeded vs. user-owned, and the required clean initial state.

This is the source of truth for "what lives where." The constraint spec (`meal-plan-constraint-spec.md`) and the add-dish spec (`add-dish-ingestion-spec.md`) both build on these layers.

## The five layers

| # | Layer | What it is | Owned by | Initial state |
|---|-------|-----------|----------|---------------|
| 0 | **Reference catalog** | Ingredients, their nutrition, aliases, seasonings, natural units | System (seeded) | **SEEDED — not empty** |
| 1 | **Dish candidate library** | Reusable dishes the planner can choose from | Curated (code) + user | 14 presets; user portion **empty** |
| 2 | **Planned meals** | The generated weekly plan | User (via generation) | **empty** |
| 3 | **Actual logs** | What the user really ate / did | User (via logging) | **empty** |
| 4 | **Profile & identity** | Who the user is, targets, preferences | User | **empty** until first use |

> **The one trap:** "start with an empty database" means **layers 1–4 user data are empty** — it does **not** mean skip layer 0. The reference catalog (layer 0) must be seeded, or the 14 presets can't compute nutrition and nothing works.

## Table mapping

### Layer 0 — Reference catalog (SEEDED, not user data)
- `food_items` — ingredients + per-100g nutrition (+ planned classification fields: execution buckets, roles, `weekly_floor`).
- `food_aliases`, `seasonings`, `natural_units`.
- **Source:** `pnpm db:seed` (from `seed/ingredients.csv`, `seed/seasonings.csv`, `seed/natural_units.csv`). Static/shared; not per-user.

### Layer 1 — Dish candidate library
- **14 curated presets** → live in **code** (`src/data/preset-dishes.ts`), always present, not DB rows.
- **`user_dishes`** (NEW table, to be implemented) → the **canonical home for user-added dishes**. Starts **empty**; written only by `save_dish` (see add-dish spec).
- **Candidate pool = presets ∪ `user_dishes`.** `loadCandidateDishes` reads both, deduped by slug.
- **Decided:** the **`cooking_records` candidate path is retired.** `loadCandidateDishes` will read `user_dishes` instead of `cooking_records`. (`cooking_records` is no longer a source of plannable dishes; if ever needed it can be repurposed as a genuine cooking *log*, but that's out of scope and unused for now.)
- **Decided:** **no import** of the old Python DB's 99 recipes. Start clean with the 14 presets only.

### Layer 2 — Planned meals
- `meal_plan_entries` — one row per (date, meal slot) with the chosen dish + nutrition + `status` (`planned`/`followed`/`substituted`/`skipped`).
- **Empty** until the user runs `generate_meal_plan`. `meal_checkin` updates `status`.

### Layer 3 — Actual logs
- `diet_logs` — meals actually eaten (written by `log_meal`, and by `meal_checkin` when followed/substituted).
- `water_logs`, `exercise_logs`, `physical_conditions` (weight) — written by `log_water` / `log_exercise` / `log_weight`.
- All **empty** initially.

### Layer 4 — Profile & identity
- `users` (created on first interaction), `bmr_profiles` (`set_profile` → targets), `user_seasoning_preferences`, `memory_records`, `daily_activity_plans`.
- **Empty** until the user sets up / interacts.

## Data flow (who writes what)

```
seed ──► Layer 0 (catalog)            [required, one-time]
code ──► Layer 1 presets              [the 14, always present]
save_dish ──► Layer 1 user_dishes     [user grows the library]
generate_meal_plan ─► Layer 2         [planned meals]
log_* / meal_checkin ─► Layer 3       [actual logs]
set_profile ──► Layer 4               [targets/preferences]
```

The planner reads **Layer 0 + Layer 1** (catalog + candidates) and **Layer 4** (targets/preferences) to produce **Layer 2**. Reports compare **Layer 2 vs Layer 3**.

## Required clean initial state

1. **Empty Postgres**, then `pnpm db:seed` → populates **Layer 0 only**.
2. **Layer 1:** 14 presets via code; `user_dishes` empty (or not-yet-created). No 99-recipe import.
3. **Layers 2–4:** empty — no plan, no logs, no profile until the user acts.

Result:
- candidate library = **14 curated presets**
- planned meals = **empty**
- actual logs = **empty**
- profile = **empty**
- catalog = **seeded** (required)

## Implementation notes (deltas from current code)

- **Add** the `user_dishes` table (see add-dish spec §3).
- **Rewire** `loadCandidateDishes` (`src/tools/candidate-loader.ts`) from the `cooking_records` / `caloriesKcal>0` path to read `user_dishes`.
- **Deprecate** `cooking_records` as a candidate source (leave the table; stop reading it for dishes).
- No reset/clear script is needed for the documented clean start (empty DB + seed). A `truncate user_dishes` reset can be added later if a populated environment needs wiping (presets are code, untouched).
