# Design: rotation-based meal planner (v2)

**Date:** 2026-07-04
**Status:** Design + phased migration plan. Not started.
**Relation to existing docs:** supersedes the *generation mechanics* of
`food-preferences-and-planning-plan.md` §1 when implemented (the priority tiers survive; the
*enforcement* moves from search-and-block to correct-by-construction). Preference collection (§3–4
there) and the W2 behavior loop are unchanged and feed this design directly.

## Why (evidence from this codebase)

The v1 planner accumulated ~18 active constraints across a weighted-sum combo scorer
(`energyMiss×2000 + proteinMiss×1500 + …`) inside a 5-nested candidate loop. Observed symptoms,
all classic over-constrained-optimizer failures:

- Seafood allergy alone made plans **infeasible** (protein floor unreachable by search) — R1.
- kcal silently ran **5–11% under target** for weeks until the staple lever was wired — R4.
- The fat advisory fired **7 days out of 7** (daily fat targets are unmeetable with real Chinese
  dishes) — R4.
- Generation took **~11s** (combinatorial search) — accepted as Finding 2.

Each was fixed by adding another weight/tolerance/lever. This design removes the class of failure
instead.

## Philosophy

**Few hard rules, two levers, rotation instead of optimization.** A nutritionist doesn't solve a
constraint program; they build a weekly rotation and adjust portions. Optimality was never actually
delivered by v1 — legibility, feasibility, and speed are worth more.

## The design

### 1. Two layers: weekly pool → daily fill

- **Layer 1 — weekly pool selection** (the only hard decision): choose 3–4 breakfasts, 5–7 mains,
  3–4 sides for the week. Allergies (hard filter), dislikes, weekly floors (as pool quotas, e.g.
  "≥2 red-meat mains"), and variety all apply **here**, as set-selection rules — trivially
  verifiable and explainable. The pool doubles as the **grocery list** (procurement falls out for
  free).
- **Layer 2 — daily fill**: assign pool members to days with rotation *rules* (not penalties):
  no main two days in a row; each main ≤2×/week; sides rotate. Then make every day correct **by
  construction** via the two levers (below).

This deletes the 5-nested-loop search: two small problems replace one huge one.

### 2. Exactly three hard constraints; days are correct by construction

1. **Safety** — allergen/forbidden filter at pool selection.
2. **Daily kcal** — solved arithmetically by the existing **staple lever** (proven: deviation
   10.5% → 0.7%).
3. **Daily protein** — solved by a new **protein top-up lever**: a small ordered menu of add-ons
   (egg / tofu / soy milk / chicken-breast extra grams) appended until the floor is met.

Key shift: protein and energy stop being *search objectives that can fail* and become *solved
arithmetic*. Per-day infeasibility becomes structurally impossible. Infeasibility can only occur at
**pool time**, where it becomes the right conversation *before* planning:
"去掉海鲜后，高蛋白主菜只剩 2 个，加一个鸡胸菜好吗？" (the Case-7 dialog, moved earlier).

### 3. Weekly budgets, not daily targets, for fat / sodium / carbs

Daily 42g fat is unmeetable with real dishes and physiologically pointless; **294g/week** is
manageable (Tuesday 红烧 balanced by Thursday 清蒸). Fat, sodium, and carbs become **weekly
budgets**: reported as "this week is X% over/under," and the daily fill *biases* dish assignment to
keep the running budget on track (e.g. after a fatty day, prefer lean mains). No daily advisories —
the every-day advisory noise is deleted structurally, not tuned away.

### 4. Preferences as pool frequency, not score bonuses

- Like → more slots in the pool (e.g. a liked main appears 2–3× in the week).
- Soft dislike / skipped ≥2 (W2 signal) → 0–1 slots.
- Forbidden → excluded at pool filter.

Legible by design: "你喜欢鸡胸，这周排了 3 次" explains itself; `+2 per match, capped, /6` never
did. The W2 behavior loop plugs in unchanged — it just adjusts pool frequencies instead of scoring
weights.

### 5. The plan is a draft with pre-computed swaps

Every entry carries 1–2 **alternates** from the same pool (pre-vetted: any swap keeps the day
correct after re-running the levers). Primary interaction becomes "换一个" — one word, like
check-ins. Swaps + check-ins feed W2, so the pool personalizes weekly.

## What survives / what is deleted

**Survives:** staple lever; hard/soft distinction; allergen pre-filter + dish-level tag checking;
W2 check-in mining; presets + user dishes as the pool source; `cannotSatisfy` block-and-explain
(now emitted at pool time); slim onboarding and all prompt workflow.

**Deleted:** weighted-sum `comboScore` and the 5-nested loop; per-day fat/carb/sodium scoring;
recency/diversity/repetition *penalties* (replaced by rotation *rules*); weekly floors as scoring
(become pool quotas).

## Surface impact

- `generate_meal_plan` input/output **shape is extended, params unchanged**: result gains
  `pool` (with grocery summary), `weeklyBudgets` (fat/sodium/carbs running report), and per-entry
  `alternates`. Pass-through JSON → **no pi-harness param change**.
- **The one pi-harness-touching item:** a real "swap" needs a small new write tool
  (`swap_meal`: date + mealType + alternate slug → update the plan entry). New tool → `tools.ts`
  registration. Deferred to the last phase; until then alternates are informational and a swap is
  handled conversationally via regenerate-day.

## Phased migration (each phase shippable alone)

### V2-P1 — Weekly budgets in reporting (small, immediate value)
Switch fat/sodium/carbs from per-day advisories to weekly-budget reporting in
`validateWeeklyMealPlan` consumers and `weekly_report`; prompt mentions budget status once.
*Acceptance:* no per-day fat advisories; weekly fat/sodium budget line appears in plan output and
weekly report.

### V2-P2 — Pool selection stage (in front of the existing planner)
New `selectWeeklyPool(candidates, preferences, targets)` module: allergen filter, weekly-floor
quotas, preference frequencies, protein-density feasibility check with pool-time
`cannotSatisfy`. Initially feeds the *existing* day assignment (shrinks its search space; expected
to also cut the ~11s generation time).
*Acceptance:* pool respects quotas/preferences; infeasible exclusion sets fail fast at pool time
with the relaxation dialog; generation time drops materially.

### V2-P3 — Rotation fill + protein lever (the core swap)
Replace `comboScore`/nested loops with rule-based day assignment over the pool + the two levers
(staple for kcal, new protein top-up for protein). Delete the deleted-list scoring.
*Acceptance:* every generated day meets kcal band + protein floor **by construction** (property
test over randomized pools); default-profile generation < 1s; simulation scenarios (seafood
allergy, default profile) green.

### V2-P4 — Preference-frequency pools + alternates in output
W2 signals adjust pool frequencies; every entry ships 1–2 pre-vetted alternates; plan output
includes the grocery-list summary.
*Acceptance:* liked mains appear ≥2×/week; skipped-≥2 dishes drop out of the pool; alternates
present and lever-valid.

### V2-P5 — `swap_meal` tool (the only pi-harness item)
CHA: handler + repo update + registry + profile registration. pi-harness: `tools.ts` registration
(record in `pi-harness-pending-changes.md` as Change 3).
*Acceptance:* "换一个" round-trips: entry updated, day re-levered, check-ins still attach.

## Ownership

| Phase | CHA | pi-harness |
|---|---|---|
| V2-P1…P4 | all code/tests/prompt | `pnpm build` pickup only |
| V2-P5 | handler/registry/profile | `tools.ts` Change 3 + build |
| AOH | governance: register V2-P1…P5 as board nodes; CHA reports via outbox | — |

## Non-goals

- Raw-ingredient → dish composer (unchanged non-goal).
- Global optimality — explicitly traded for legibility, feasibility-by-construction, and speed.
- Daily hard constraints for fat/carbs/sodium (weekly budgets by design).
- GUI; this remains a chat agent.

## The trade-off, stated honestly

A global optimizer can in principle find combinations the rotation misses. v1 never actually
delivered that optimality — it delivered an 11-second search that undershot calories for weeks
unnoticed. v2 buys: one-sentence explainability for every decision, near-zero infeasibility, sub-
second generation, and a grocery list as a byproduct.
