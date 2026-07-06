# CHA-MPV2-5 — delete comboScore; rotation fill is the only planner path — manifest

Assignment: CHA-MPV2-5-A1 (G2 APPROVED: HD-CHAMPV2-5-G2-DELETE-COMBOSCORE — delete outright, no flag)
Completed: 2026-07-06 (session compass-health-agent; parallel with CHA-MPV2-6, disjoint scopes)

## What changed

- DELETED `src/engine/meal-plan-scoring.ts` (the v1 weighted-sum scorer:
  `scorePlan`, penalty breakdown, all penalty/bonus functions). No flag, no
  dead code, per the G2 decision.
- `src/engine/scoring-weights.ts`: `MealPlanScoringWeights` and
  `DEFAULT_SCORING_WEIGHTS` deleted. Scorer-only constants
  `FAT_ADVISORY_TOLERANCE_RATIO` and `MAX_DISH_USES_PER_WEEK` deleted (zero
  remaining consumers). Shared planner constants (ENERGY_TOLERANCE_RATIO,
  MAX_ENERGY_TOLERANCE_RATIO, PROTEIN_FLOOR_RATIO, SODIUM_CAP_MG,
  MIN_DISTINCT_DISHES, WEEKLY_FLOORS) kept — they are imported by
  plan-advisory/pool-selection/handlers outside this node's write scope, so
  the filename is kept for import stability.
- `src/engine/meal-planner.ts`: `score?: MealPlanScore` removed from
  `WeeklyMealPlan`; `generateWeeklyMealPlan` returns the built plan directly.
  Rotation fill (protein-sorted rule-based day assignment) + staple kcal
  lever + node-4 protein top-up lever are the only planner path (they already
  were the assignment mechanism; the scorer was a vestigial advisory field).
- `tests/tools/generate-meal-plan-pool.test.ts`: the default-profile
  wall-time test now also writes `evidence/CHA-MPV2-5/default-profile-generation.json`
  with `thresholdMs: 1000` and asserts `< 1000` on the SUCCESSFUL generation
  (node-3's 5000ms artifact still written unchanged).

## Removed tests (constraint: listed with completion evidence)

`tests/engine/meal-plan-scoring.test.ts` deleted — all six tests existed only
to exercise the deleted scorer:
1. "penalizes lower protein more than variety loss"
2. "adds weekly floor penalty when classified bucket servings are below target"
3. "penalizes a configured floor bucket that is entirely absent from the plan (regression)"
4. "uses personalized fat and carbs gram targets instead of generic macro percentages"
5. "does not penalize fat inside the advisory tolerance band"
6. "penalizes dishes recently served or repeatedly skipped by the user"

Their surviving intents are asserted structurally elsewhere: protein floor and
kcal band by construction + rotation rules (meal-planner-rotation-property),
weekly floors as pool quotas (pool-selection tests), recency/skip signals as
pool frequency (preference-pools tests, node 6).

## doneWhen mapping

1. Scorer deleted, rotation fill only path — see above; repo-wide grep for
   scorePlan/DEFAULT_SCORING_WEIGHTS/MealPlanScore returns nothing.
2. Property test over randomized pools — `tests/engine/meal-planner-rotation-property.test.ts`
   (40 seeded random pools; every planned day in the kcal band AND >= protein
   floor by construction; blocked pools must raise MealPlanInfeasibleError).
3. Rotation rules asserted — same test: no main on two consecutive days,
   each main <= 2x/week, staple on the 30g lattice.
4. Wall time — 18ms < 1000ms on status=planned;
   `evidence/CHA-MPV2-5/default-profile-generation.json`.
5. Simulation scenarios green — full suite passes including the node-3
   seafood-allergy scenario (still PLANS with deep_sea_fish + shellfish
   floors waived).
6. Gates — literal `pnpm typecheck && pnpm test` exit 0: 54 files / 358 tests.
   Raw log: `.evidence-local/CHA-MPV2-5/gates.log` (CHA repo).
7. Outbox start/complete — canonical schema, atomic single-line appends.

## Files written (all inside allowed_write_paths)

- src/engine/meal-planner.ts
- src/engine/meal-plan-scoring.ts (deleted)
- src/engine/scoring-weights.ts
- tests/engine/meal-plan-scoring.test.ts (deleted)
- tests/tools/generate-meal-plan-pool.test.ts
- evidence/CHA-MPV2-5/default-profile-generation.json, manifest.md (this file)

`src/tools/generate-meal-plan.ts` needed no change (it never consumed the
score field). Changes are uncommitted in the CHA working tree pending
review + sync.
