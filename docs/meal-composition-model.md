# Meal Composition Model — separate dish, staple, and side

**Status:** Design (spec before code)
**Scope:** Stop bundling the staple (rice) into every dish. Model a meal as **composed** of a main dish + a staple + optional side, so dishes carry only their own ingredients and the staple becomes a separate, portionable meal component.

## Problem

Every preset dish currently bundles `brown_rice` + its nutrition, conflating **dish** (葱烧豆腐) with **meal** (葱烧豆腐 + rice). Costs:
- **Duplication** — `brown_rice` repeated across ~16 dishes.
- **No staple flexibility** — can't swap rice ↔ bun ↔ potato ↔ corn without a new dish.
- **No kcal lever** — the staple portion is the natural way to tune a day's calories; bundled, it's frozen.
- **Awkward authoring** — every dish is forced to include rice.

The old Python app modeled this correctly: separate `D` (dishes) and `S` (staples), with meals **composed** from protein + staple + vegetable roles. The TS port collapsed it. This spec restores the separation.

## Corrected model

- **Dish** = main-dish ingredients only (protein + its vegetables), with nutrition for just those. No staple.
- **Staple** = a separate component (`brown_rice`, `steamed_bun`, `quinoa_ciabatta`, `sweet_potato`, `corn_fresh`), with an **adjustable portion**. Default fixed (brown rice); optionally swappable.
- **Side** (optional, future) = an extra vegetable/soup component; for v1 keep sides inside the dish.
- **Meal** = `breakfast` | (`dish` + `staple` [+ side]). **Meal nutrition = sum of components** (computed from the catalog).

## Data model

```ts
interface Dish {                 // was RecipeDish, minus the staple
  slug: string;
  name: string;
  mealCategory: "breakfast" | "main";
  ingredients: { slug: string; grams: number }[];   // main-dish only, NO staple
  seasonings: string[];
  method?: string;
  // nutrition is now DERIVED from ingredients (catalog), not bundled per-meal
}

interface Staple {
  slug: string;                  // brown_rice | steamed_bun | sweet_potato | corn_fresh | quinoa_ciabatta
  defaultGrams: number;          // e.g. brown_rice 100
  minGrams: number; maxGrams: number;   // portion bounds, e.g. 40–180
}

interface ComposedMeal {
  dish: Dish;
  staple?: { slug: string; grams: number };   // omitted for breakfast if not applicable
  nutrition: Nutrition;          // dish + staple, summed
}
```

## Nutrition composition
`mealNutrition = dishNutrition(catalog) + stapleNutrition(slug, grams, catalog)`. Dishes stop carrying meal-level numbers; everything is summed from components at compose time. (This also means add-dish/`save_dish` stores **main-only** dishes — see add-dish spec.)

## Key insight — the staple is the kcal-closing lever
Because rice is low-protein and high-carb, separating it lets us **decouple the two hard constraints**:
- **Dish selection** optimizes protein floor (H4), weekly buckets, variety — *without* worrying about hitting kcal.
- **Staple portion** is then computed to bring the day to the **energy band (H2)**: `stapleGrams ≈ clamp((dailyKcalTarget − Σ dish kcal − breakfast kcal) / stapleKcalPerGram, min, max)`.

This largely makes the energy band **trivially satisfiable** (portion the rice), so it stops constraining dish choice. That directly serves the convergence goal — one of the two hard gates is now handled by a continuous lever instead of by candidate filtering. Protein (H4) remains the binding dish-selection constraint.

> Note: this does **not** fix the salad over-use (that's protein-floor driven, and rice is low-protein). It fixes the *model* and the *kcal lever*, and gives the planner more freedom.

## Planner changes
- Combo enumeration becomes: pick breakfast + 2 main **dishes** (protein/variety/buckets), then **solve the staple portions** to hit the daily energy band.
- The old "dinner = remainder" hack and any per-meal kcal split are replaced by staple portioning.
- If the staple lever can't close the band within `[min,max]` (e.g. dishes already over target), fall back to best-effort + report (existing conflict policy).

## Migrating the existing dishes
1. **Strip `brown_rice`** from all ~16 main presets; recompute each dish's nutrition as main-only.
2. Add the **staple set** + default `brown_rice` component.
3. Breakfasts: v1 may keep their grain inside the dish (oats/bun/ciabatta are intrinsic to the breakfast), or model a breakfast staple later — decide in Open Decisions.
4. Do it **consistently** — a half-migration (some dishes with rice, some without) breaks the kcal math.

## Interaction with other specs
- **constraint spec:** H2 (energy band) is now closed by staple portioning; H3 structural meal = dish + staple; H4 (protein) unchanged (still on the composed meal, rice adds little). The weekly-floor/scoring all run on composed-meal nutrition.
- **add-dish spec:** authored/generated dishes are **main-only** (no staple); `propose_dish` computes main-only nutrition; the planner adds the staple. Updates §1/§3 of that spec.
- **data-architecture:** `user_dishes` stores main-only dishes; a small `staples` reference set joins the catalog layer.

## Open decisions
1. **Staple: fixed vs. per-meal choice.** v1 = fixed `brown_rice`, portion-adjustable; swapping (bun/potato/corn) later.
2. **Breakfast staples** — fold into the dish (simplest) or compose like mains? (Recommend fold for v1; breakfasts are already coherent units.)
3. **Sides/vegetables** — keep inside the dish for v1, or separate as a third component later (the old app had `vegetable` + `second_vegetable` roles).
4. **Portion bounds** per staple (e.g. brown_rice 40–180 g) and rounding (to 10 g).

## Testing
- **Composition** (unit): meal nutrition = dish + staple sums correctly from a fixed catalog.
- **Staple lever** (unit): given a dish kcal and a daily target, the solved staple grams land the day in the energy band; clamped at bounds when infeasible (→ best-effort report).
- **Migration** (regression): stripped dishes + staple recompose to ~the same meal nutrition as the old bundled dishes (so the change is behavior-preserving at the meal level).
- **Planner** (integration): generated plans hit the energy band via staple portions, not dish filtering.

## Implementation order
1. Add the `Staple` set + `stapleNutrition` helper (catalog-based).
2. Split dishes: strip staples from presets; make dish nutrition main-only (derived).
3. Add meal composition (`dish + staple`) + the staple-portion solver for the energy band.
4. Update the planner to select dishes then solve staples; drop the remainder/split logic.
5. Update scoring/coverage to run on composed-meal nutrition.
6. Update `propose_dish`/`save_dish` to main-only dishes.

---

# Extension — vegetable side & soup components (option B)

**Decided:** split dishes joined by **"配"** into separate components; the planner composes **main + side + staple**. Integrated stir-fries (no 配, veg cooked in) stay whole. This restores the old Python app's `(main, staple, side)` granularity.

## Roles
- `main` — protein-centric dish (beef / chicken / fish / tofu).
- `side` — a vegetable dish, with `sideKind: "vegetable" | "soup"` (蒜蓉西兰花 = vegetable, 紫菜汤 = soup).
- `staple` — unchanged.

**Meal = `main` + (optional `side`) + `staple`.**

## Split rule (migration)
Applies to **main dishes** whose name joins a main and a *side/soup dish* with **配** (not ingredient add-ons — breakfast "配坚果"/"配鸡蛋" are exempt). The 8 composites:

| Composite | → main | → side (`sideKind`) |
|---|---|---|
| 葱爆牛肉配蒜蓉西兰花 | 葱爆牛肉 | 蒜蓉西兰花 (vegetable) |
| 鸡丝虾仁沙拉配紫菜汤 | 鸡丝虾仁沙拉 | 紫菜汤 (soup) |
| 红烧带鱼配香菇小白菜 | 红烧带鱼 | 香菇小白菜 (vegetable) |
| 洋葱炒牛肉配菠菜汤 | 洋葱炒牛肉 | 菠菜汤 (soup) |
| 清蒸鲷鱼配蒜蓉西兰花 | 清蒸鲷鱼 | 蒜蓉西兰花 (vegetable) |
| 胡萝卜炒鸡丁配香菇小白菜 | 胡萝卜炒鸡丁 | 香菇小白菜 (vegetable) |
| 香煎柠檬鲷鱼配菠菜汤 | 香煎柠檬鲷鱼 | 菠菜汤 (soup) |
| 红烧豆腐配小白菜 | 红烧豆腐 | 小白菜 (vegetable) |

- **Dedup shared sides:** 蒜蓉西兰花 (×2), 香菇小白菜 (×2), 菠菜汤 (×2) collapse to one component each → distinct new sides: **蒜蓉西兰花, 香菇小白菜, 小白菜, 紫菜汤, 菠菜汤**.
- **Stay whole (self-contained mains, no 配):** 酱鸡腿卤蛋香菇, 西兰花炒虾仁, 蒜蓉粉丝娃娃菜虾, 家常豆腐西兰花, 葱烧豆腐, 紫菜豆腐汤.

## Composition (option B)
- Each `main` carries **`selfContained: boolean`** — set explicitly during the split (a split-out 配 main = `false`; a non-配 main = `true`). *Not* derived from ingredients (fuzzy: some mains have minor veg like onion/carrot yet came 配 a side).
- Planner: pick a main; **if `!selfContained`, pick a `side`** (least-recently-used, for variety); solve the staple; nutrition = main + side + staple.
- Self-contained mains get **no** side (their veg is intrinsic).

```ts
interface Dish {
  role: "main" | "side";
  sideKind?: "vegetable" | "soup";   // side only
  selfContained?: boolean;           // main only
  // …ingredients main-only, no staple (as in the base model)
}
interface ComposedMeal { main: Dish; side?: Dish; staple?: StaplePortion; nutrition: RecipeNutrition; }
```

## Scoring / buckets
- **Protein-bucket floors come from mains only** (sides are vegetables) — unchanged.
- **Variety is tracked per role**: don't over-repeat a main; sides may repeat more (there are few). Separate main-usage / side-usage counters.
- Nutrition/coverage run on the fully composed meal. Sides add minimal kcal/protein; the **staple still closes the energy band**.

> Caveat: this does **not** affect the protein-floor / salad over-use (sides are low-protein). It's a structural + variety improvement, not a protein fix.

## Open decisions
1. **Soup vs side** — one `side` role + `sideKind` (recommended) vs two roles.
2. **Always-a-side?** — option B adds a side only to non-self-contained mains. Alternative: force a vegetable on every meal. v1 = option B (no forced side).
3. **Side variety weight** — how hard to penalize repeating a side given the small side pool.

## Testing (this extension)
- **Migration (behavior-preserving):** each of the 8 composites, re-composed as `main + side + staple`, ≈ the old bundled meal's nutrition.
- **Composition:** self-contained main → no side; non-self-contained → exactly one side; nutrition sums correctly.
- **Variety:** main and side usage tracked separately; a main isn't repeated past its cap.

## Implementation order (this extension)
1. Add `role` / `sideKind` / `selfContained` to the dish model + a `side` candidate set.
2. Split the 8 "配" presets into mains (`selfContained:false`) + deduped sides; mark non-配 mains `selfContained:true`.
3. Planner: after picking a main, pick a side when `!selfContained`; compose `main + side + staple`.
4. Scoring/coverage on the composed meal; per-role variety tracking.
5. Extend candidate-loader / `add-dish` to handle the `side` role (sides are user-addable, vegetable-only).
