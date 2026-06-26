# Implementation Build Plan

**Status:** Draft
**Sequences:** `data-architecture.md` + `add-dish-ingestion-spec.md` + `meal-plan-constraint-spec.md` into ordered, shippable phases.
**Conventions:** pnpm + this repo's TS config; TDD (tests before code, verify red); no commits without an explicit ask; new agent tools also need framework registration (see cross-repo note).

## Already done (Phase 0)
- Presets reconciled to `breakfast` / `main` (the 10 mains are `["lunch","dinner"]`-eligible).
- Constraint spec updated: lunch/dinner split removed; protein promoted to a hard floor (H4).
- These three specs written. No runtime code beyond the preset change.

## Dependency graph

```
        ┌────────────────────────────┐
P1 user_dishes ─────────────┐        │
                            ▼        ▼
P2 classification ─► P3 add-dish    P4 scorer+planner ─► P5 validator/advisory
        │                            ▲
        └────────────────────────────┘
```
- **P1** (data foundation) and **P2** (classification) are independent — can run in parallel.
- **P3** (add-dish) needs **P1** (storage) + **P2** (bucket/role derivation).
- **P4** (scoring) needs **P2** (weekly-floor) and benefits from **P1** (user dishes in the pool).
- **P5** needs **P4**.

**Two tracks** converge: *ingestion* (P1→P3) and *intelligence* (P2→P4→P5). Recommended single-implementer order: **P1 → P2 → P3 → P4 → P5**.

---

## Phase 1 — Data foundation: `user_dishes` + candidate rewire
**From:** data-architecture.md · **Depends on:** nothing · **Ships:** the clean initial state (candidate library = 14 presets).

- **Files:** `src/db/schema.ts` (new `user_dishes` table), drizzle migration, `src/db/repository.ts` (`UserDishRow`, `upsertUserDish`, `listUserDishes`), `src/tools/candidate-loader.ts` (rewire).
- **Changes:**
  - `user_dishes`: `id, user_id, slug, name, meal_category('breakfast'|'main'), ingredients_json, seasonings_json, method, calories_kcal, protein_g, carbs_g, fat_g, sodium_mg, source, created_at`; unique `(user_id, slug)`.
  - `loadCandidateDishes` = presets ∪ `user_dishes` (deduped by slug, filter valid nutrition). **Stop reading `cooking_records`.** Map `meal_category` → eligibility: `main`→`["lunch","dinner"]`, `breakfast`→`["breakfast"]`.
- **Tests:** candidate-loader unit (empty `user_dishes` ⇒ 14 presets; one row ⇒ appears, deduped); repository CRUD (integration, needs Postgres).
- **Acceptance:** empty DB + seed ⇒ pool is exactly the 14 presets; inserting a `user_dishes` row makes it a candidate; `cooking_records` no longer consulted.

## Phase 2 — Classification model (the hub prerequisite)
**From:** meal-plan-constraint-spec §0 · **Depends on:** nothing · **Ships:** buckets/roles/`weekly_floor` on the catalog (unblocks P3 and P4).

- **Files:** `src/db/schema.ts` (`food_items` += `execution_buckets`, `roles`, `weekly_floor`), seed source (extend `seed/ingredients.csv` or add `seed/food_classification.csv`) + `src/db/seed.ts`, `src/db/catalog.ts` (load into `FoodCatalogRecord`), `src/engine/classification.ts` (new: `dishBucketsRoles(dish, catalog)`).
- **Changes:** classify the protein carriers — `red_meat` (beef/pork), `lean_white_meat` (chicken), `deep_sea_fish` (salmon/cod/mackerel/sardine), `shellfish` (shrimp), `soy_product`, `egg`, `dairy`; roles `iron/zinc/b12`, `omega3/vitamin_d`; `weekly_floor` (e.g. red_meat 2, deep_sea_fish 2, shellfish 1).
- **Tests:** seed maps the 6+ preset proteins to correct buckets; `dishBucketsRoles` derives a dish's buckets from its ingredients (a beef dish ⇒ `red_meat`).
- **Acceptance:** every catalog food has buckets/roles; dish-level derivation correct; `weekly_floor` present.

## Phase 3 — Add-dish ingestion (`propose_dish` / `save_dish`)
**From:** add-dish-ingestion-spec · **Depends on:** P1 + P2 · **Ships:** users can add dishes (the headline feature).

- **Files:** `src/tools/slug-resolver.ts` (zh/en name → slug), `src/tools/handlers.ts` (`handleProposeDish`, `handleSaveDish`), `src/agent.ts` (tool metadata: `propose_dish` read-only, `save_dish` write), `src/index.ts` (toolRegistry entries).
- **Changes:**
  - `propose_dish` (read-only): NL → extract name/ingredients(grams)/seasonings/method **or** accept structured `draft`; resolve slugs; **compute nutrition from catalog**; derive buckets/roles (P2); return `ResolvedDish` + `unresolved[]`. **No write.**
  - `save_dish` (write): validate (§4 of add-dish spec) → persist to `user_dishes` (P1).
- **Cross-repo:** also register the two tools in the framework (`pi-harness/.../compass-health/tools.ts` TypeBox registrations) — same pattern as existing tools. *(You apply the pi-harness side; this repo exports the handlers.)*
- **Tests:** slug resolution (zh+en), nutrition compute from fixed catalog, validation rejects (unresolved/zero-gram/empty), approval gate (`propose_dish` writes nothing; `save_dish` persists, idempotent on `(userId,slug)`), planner integration (saved dish becomes candidate). NL parse → eval/rubric harness (separate, non-deterministic).
- **Acceptance:** NL "洋葱炒牛肉, 200g beef, onion, spinach" → reviewed `ResolvedDish` with computed kcal/protein → on approval persisted and selectable by `generate_meal_plan`.

## Phase 4 — Constraint scorer + planner refactor
**From:** meal-plan-constraint-spec §1–§2, §5 · **Depends on:** P2 (+P1) · **Ships:** plans that respect protein floor, weekly floors, variety.

- **Files:** `src/engine/scoring-weights.ts` (config), `src/engine/meal-plan-scoring.ts` (new `scorePlan(plan, profile, prefs, weights) → {penalty, breakdown}`), `src/engine/meal-planner.ts` (refactor), `src/tools/generate-meal-plan.ts`/handlers (wire).
- **Changes:**
  - Hard gates: H1 exclusions (extend `filterUsableCandidates` to ingredients/allergens), H2 energy band (`τ_E=0.12`, widen→0.15), **H3** breakfast+2 main slots (remove `MEAL_KCAL_SPLIT`/`targetForSlot` split), **H4 protein floor** (`τ_P=0.80`, best-effort fallback).
  - Soft scorer = weighted sum (protein top-up, weeklyFloor, sodium, repetition, macro, diversity, recency, preferenceBonus). Use as the **ranking oracle** + plan validator.
  - Conflict policy: energy auto-widen; protein → best-effort + hard-violation report.
- **Tests:** protein boundary (79%→infeasible, 80%→feasible), energy band, exclusions remove dishes; scoring property tests (monotonic; protein beats variety); infeasibility ⇒ best-effort + report (no throw).
- **Acceptance:** generated weeks satisfy H1–H4 or return best-effort-with-report; weekly red-meat/fish floors are pulled toward target; removing the split didn't regress kcal totals.

## Phase 5 — Validator + advisory outputs
**From:** meal-plan-constraint-spec §3 · **Depends on:** P4 · **Ships:** coverage report, daily-report thresholds, procurement list.

- **Files:** `src/engine/procurement.ts` (new), `src/tools/weekly-report.ts`/`daily-summary.ts` (thresholds + coverage), plan validator surface.
- **Changes:** coverage report (unmet floors, protein avg, cadence X/2); daily-report status (kcal >115%/<80%, protein <80%/>130%); procurement aggregation (×1.15, round 10g, key-food flags).
- **Tests:** coverage enumerates every unmet soft term; procurement aggregation/rounding; daily-report thresholds.
- **Acceptance:** after a plan, the agent can explain unmet floors and emit a shopping list; reports never gate generation.

---

## Cross-cutting notes
- **`meal_category` vs `mealTypes`:** keep the planner's internal `mealTypes` vocabulary; `user_dishes.meal_category` maps `main→["lunch","dinner"]`, `breakfast→["breakfast"]` at load time (no type-system refactor).
- **New tools need framework registration:** P3's `propose_dish`/`save_dish` require a matching pi-harness `tools.ts` change (read-only/write TypeBox registrations). This repo owns the handlers; the framework owns the registration — coordinate as before.
- **Reserved (not in scope):** main-agent structured ingestion (the `propose_dish({draft})` seam is built in P3, the research pipeline is not); legacy 99-recipe import (decided against).
- **Minimum path to a usable system:** P1 + P2 + P4 (clean data + classified catalog + smart planner). P3 (add-dish) and P5 (reports) layer on top.
