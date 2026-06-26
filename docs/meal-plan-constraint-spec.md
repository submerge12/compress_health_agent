# Meal-Plan Constraint & Scoring Spec

**Status:** Draft for implementation
**Scope:** Weekly meal-plan generation in `compass-health-agent` (`src/engine/meal-planner.ts`).
**Source:** Ported and simplified from the Python reference (`compass-health/backend/services/{menu_planner,food_library}.py`).

## Design philosophy

A meal plan has exactly **two** things that make it *wrong* (hard), and many things that make it *better* (soft). Over-constraining with hard rules collapses the feasible region against a finite dish pool and prevents the planner from converging. Therefore:

- **HARD** = correctness/safety gates. Keep this set tiny. A plan that violates one is rejected.
- **SOFT** = a single weighted objective the generator **minimizes**. Health-critical terms get high weight so the planner tries hard, but a miss never makes the plan infeasible.
- **ADVISORY** = derived outputs and warnings produced *after* a plan exists. Never gate generation.

> Litmus test for "hard vs soft": *if a violation still yields a safe, usable plan, the rule is soft.*

---

## 0. Prerequisite data model — food classification

Groups in §2/§3 cannot be expressed without this. Extend `food_items` (currently a single `category`) with:

```ts
interface FoodClass {
  slug: string;
  executionBuckets: string[]; // e.g. ["red_meat"] | ["deep_sea_fish"] | ["lean_white_meat"] | ["shellfish"] | ["soy_product"] | ["egg"] | ["dairy"] | ["vegetable"] | ["staple"] | ["fat_functional"]
  roles: string[];            // micronutrient roles: ["iron","zinc","b12"] | ["omega3","vitamin_d"] | ...
  weeklyFloor?: number;       // min servings/week this bucket should appear (0 if none)
  maxServingG?: number;       // practical portion ceiling
  tags?: string[];
}
```

Bucket vocabulary (from the Python `EXECUTION_BUCKETS`): `lean_white_meat`, `red_meat`, `deep_sea_fish`, `shellfish`, `soy_product`, `egg`, `dairy`, `vegetable`, `staple`, `fat_functional`. Role vocabulary: `iron`, `zinc`, `b12`, `omega3`, `vitamin_d` (extend as needed).

A **dish** inherits buckets/roles from its ingredients (a dish "is red meat" if any ingredient ∈ `red_meat`).

---

## 1. HARD gates (feasibility)

A candidate plan is **feasible** iff all hold. Enforced in the generator/validator; violations are never scored, they're excluded.

| ID | Gate | Definition | Constant |
|----|------|------------|----------|
| **H1** | User exclusions | No dish contains any excluded ingredient, rejected seasoning, or allergen. Enforced as a **pre-filter** (removes dishes from the pool). | — |
| **H2** | Daily energy band | For each day: `|dayKcal − E*| ≤ τ_E · E*` | `τ_E = 0.12` (widen policy §5) |
| **H3** | Structural completeness | Each day has 3 meals: 1 **breakfast** + 2 **main** meals. Dishes are eligible by category only (`breakfast` vs `main`); lunch and dinner are **not** distinguished. Each slot holds one main (+ optional staple/side). | — |
| **H4** | Daily protein floor | For each day: `dayProtein ≥ τ_P · P*` | `τ_P = 0.80` |

That is the entire hard set. Everything else is soft.

> **Feasibility cost note:** H4 is the one term we promote to hard because under-eating protein undermines the plan's purpose. It does shrink the feasible region (energy band **and** protein floor must both hold against a finite pool), so the infeasibility fallback in §5 is what keeps the planner from dead-ending. If you see frequent protein-floor misses, the fix is a richer protein-carrier pool, not a lower floor.

---

## 2. SOFT objective (weighted penalty)

The generator **minimizes** total penalty `P` over feasible plans:

```
P(plan) =  Σ_days ( wP·protein + wNa·sodium + wMacro·macro )
         + wFloor·weeklyFloor
         + wRepeat·repetition
         + wDiv·diversity
         + wRec·recency
         − wPref·preferenceBonus
```

Each term returns a **normalized penalty ≥ 0** (0 = satisfied; ~1 = badly violated per its natural unit), so weights are directly comparable.

### Weights (defaults)

| Term | Weight | Level | Rationale |
|------|:------:|-------|-----------|
| `protein` top-up | **10** | day | Pulls from the 80% floor (H4) up toward 100% of target. Adequacy (<80%) is now a hard gate; this term optimizes the 80→100% residual. |
| `weeklyFloor` (micronutrient cadence) | **6** | week | Iron/B12 (red meat), omega-3/vit-D (deep-sea fish). Health-meaningful → high weight, but soft. |
| `sodium` | **5** | day | Ceiling; penalize excess, don't reject. |
| `repetition` | **4** | week | Monotony hurts adherence. |
| `macro` (fat/carb distribution) | **3** | day | Looser than protein. |
| `diversity` | **3** | week | Spread across the dish pool. |
| `preferenceBonus` | **3** | week | Personalization (subtracts from penalty). |
| `recency` | **2** | week | Avoid dishes served in the last few days. |

### Term definitions

- **protein** top-up(day) = `max(0, (P* − P_actual) / P*)` — asymmetric: over-target = 0. Note `dayProtein < 0.80·P*` is already excluded by **H4**, so in feasible plans this term ranges only over `[0, 0.20]`.
- **sodium**(day) = `max(0, (Na_actual − Na_cap) / Na_cap)`, `Na_cap = 2300`.
- **macro**(day) = `clip(|fat% − fat*%|) + clip(|carb% − carb*%|)` (fractions of energy).
- **weeklyFloor**(week) = `Σ_buckets max(0, floor_b − servings_b) / floor_b` — one term covers red-meat/fish/etc. via their `weeklyFloor`.
- **repetition**(week) = `(# ingredients appearing in >2 consecutive meals) / N_meals`.
- **diversity**(week) = `max(0, (minDistinct − distinctDishes))/minDistinct + Σ_dish max(0, uses − maxUses)/N_meals`.
- **recency**(week) = `(# dishes served within R days, weighted by closeness) / N_meals`.
- **preferenceBonus**(week) = `min(cap, matches(preferredIngredients) + matches(preferredMethods)) / cap` (subtracted).

### Constants (defaults — all tunable)

| Constant | Default | Meaning |
|----------|:-------:|---------|
| `τ_E` | 0.12 | daily energy band (hard) |
| `τ_P` | 0.80 | daily protein floor, fraction of target (hard) |
| `Na_cap` | 2300 mg | sodium ceiling (soft) |
| `R` | 2 days | recency window |
| `maxUses` | 3 / week | per-dish overuse threshold |
| `minDistinct` | 10 / week | distinct-dish floor |
| `cap` | 6 | preference-bonus saturation |
| `E*`, `P*`, `fat*%`, `carb*%` | from `bmr_profiles` | per-user targets |

---

## 3. ADVISORY (post-hoc, never gates)

Produced after a feasible, score-minimized plan exists:

- **Procurement list** — aggregate ingredient grams across the week, `× 1.15` buffer, round up to 10 g, flag key foods.
- **Daily report** — status vs target: kcal `>115% = over`, `<80% = under`; protein `<80% = under`, `>130% = over`.
- **Coverage report** — for every unmet soft objective, surface it so the agent can explain: e.g. `red_meat: 1/2 weekly servings (shrimp excluded blocked the 2nd)`, `protein avg 92% of target`.

---

## 4. Deliberately dropped / demoted (rule reduction)

To keep the agent's feasible space large (your convergence concern):

- **`red_meat_day` / `deep_sea_fish_day` are NOT scored constraints.** They become an **optional generation heuristic** that biases pool ordering toward the bucket on chosen days. The *measured, scored* outcome is the **weekly serving floor** (`weeklyFloor`). This removes double-counting and an entire rule class while preserving the nutritional intent.
- **Activity-based day types** (`low/moderate/high_activity` carb timing) — out of scope for v1; revisit if activity logging drives plans.
- **`pantry_clearance` day type** — out of scope for v1.
- **20% pool-diversity cap** — folded into the `diversity` term, not a separate hard rule.
- **Exact macro matching** — never; only protein floor + loose fat/carb distribution.
- **Lunch/dinner distinction + per-meal calorie split (25/40/35)** — removed. Lunch and dinner share one `main` dish pool; only the **daily** energy band (H2) and protein floor (H4) are enforced, not per-slot kcal. This enlarges each main slot's candidate pool and eases convergence.

---

## 5. Generation & conflict policy

1. **Pre-filter** the pool by H1 (exclusions).
2. Generate to **minimize `P`** subject to H2/H3/H4. Greedy-with-lookahead is acceptable; the score in §2 is the single oracle for both ranking and validation.
3. **Energy infeasible** (no plan meets H2 with the pool): widen `τ_E` in steps of 0.01 up to `0.15`; if still infeasible, return the best-effort plan **flagged with a hard-violation report** rather than throwing.
4. **Protein-floor infeasible** (pool can't reach `τ_P · P*` on some day, e.g. exclusions removed the protein carriers): **do not auto-relax `τ_P`** — return the best-effort plan that maximizes protein, **flagged with a hard-violation report** naming the day(s) and the blocking exclusions. Adequacy is a health gate, so the failure is surfaced loudly, never silently lowered.
5. **Soft trade-offs:** always return the min-`P` plan and emit the §3 coverage report for every unmet term. Never fail on soft.

---

## 6. Testing notes

- **Hard gates** → deterministic unit tests: feasible vs infeasible pools; exclusion always removes dishes; energy band boundary cases; **protein floor boundary** (a day at 79% of target is infeasible, 80% is feasible) and **protein-floor infeasibility** (carriers excluded ⇒ best-effort plan returned with a hard-violation report, not a throw).
- **Scoring** → property tests: penalty is monotonic under worsening perturbations; the minimizer honors priority ordering (e.g. a plan that sacrifices variety to hit protein scores better than the reverse).
- **Infeasibility** → assert best-effort + advisory report (the conflict policy is the oracle).
- **Golden** → fixed profile + pool ⇒ expected plan (or expected penalty bounds) so weight changes are reviewable.
- **Weights are config**, not magic numbers — load from a constants module so they're tunable and test-pinnable.

---

## 7. Implementation order

1. Port the **classification data model** (§0) into `food_items` + seed (the prerequisite).
2. Add the **scoring module** (§2) as a pure function `scorePlan(plan, profile, prefs, weights) → { penalty, breakdown }`.
3. Wire it into `generate-meal-plan` as the ranking oracle; keep H1–H3 as gates.
4. Add the **validator** that returns the §3 coverage report.
5. Add **advisory outputs** (§3) as separate, post-hoc functions.
