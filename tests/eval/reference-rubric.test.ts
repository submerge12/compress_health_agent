import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, test } from "vitest";

import { presetDishes } from "../../src/data/preset-dishes.js";
import { loadFoodItemsFromCsv } from "../../src/db/seed.js";
import { dishBucketsRoles } from "../../src/engine/classification.js";
import {
  computeDishNutritionFromIngredients,
  dishNutritionDivergence,
  type DishNutritionDivergence,
} from "../../src/engine/dish-nutrition.js";
import type { MealPlanDay, MealPlanEntry } from "../../src/engine/meal-planner.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import { generateMealPlan } from "../../src/tools/generate-meal-plan.js";
import type { FoodCatalogRecord, MealCatalog } from "../../src/tools/nutrition-estimate.js";

/**
 * Reference-menu evaluation harness (docs/reference-menu-eval-set.md).
 *
 * Scores the current planner against the agreed rubric for the primary
 * persona and writes the result to evidence/reference-eval/baseline.json.
 * Rubric outcomes are RECORDED, not asserted — the baseline is allowed to
 * fail gates; that is the point of a baseline. The tests only assert that
 * the planner plans and the harness itself is sound.
 */

// Primary persona: 23M / 173 cm / 70 kg, revised Harris-Benedict × 1.2 − 300,
// protein 2 g/kg, fat 0.7 g/kg (user-accepted adjustment), carbs remainder.
const PERSONA = {
  startDate: "2026-07-06",
  dailyKcalTarget: 1771,
  dailyProteinTarget: 140,
  dailyFatTarget: 49,
  dailyCarbsTarget: 192,
} as const;

const ENERGY_TOLERANCE = 0.12;
const PROTEIN_FLOOR = Math.round(PERSONA.dailyProteinTarget * 0.8); // 112
const WEEKLY_FAT_BUDGET = PERSONA.dailyFatTarget * 7; // 343
const WEEKLY_CARBS_BUDGET = PERSONA.dailyCarbsTarget * 7; // 1344
const WEEKLY_SODIUM_CAP = 2300 * 7; // 16100
const WEEKLY_AVG_KCAL_TOLERANCE = 0.03;
// Natural-unit lattice for the default staple: 1 碗 cooked = 60 g dry brown
// rice, so half-bowl steps are 30 g on the catalog's dry-weight basis.
const STAPLE_HALF_UNIT_GRAMS = 30;

interface GateResult {
  pass: boolean;
  detail: string;
}

describe("reference rubric baseline (primary persona)", () => {
  test("chaoshan_beef_soup recomputes cleanly from its own ingredients", async () => {
    const { catalog } = await loadRealPresets();
    const soup = presetDishes.find((dish) => dish.slug === "chaoshan_beef_soup");
    expect(soup).toBeDefined();
    const computed = computeDishNutritionFromIngredients(soup as RecipeDish, catalog);
    // 200 g tenderloin + 10 g scallion
    expect(computed.proteinGrams).toBeCloseTo(44.6, 0);
    expect(computed.fatGrams).toBeLessThan(2.5);
    const divergence = dishNutritionDivergence(soup as RecipeDish, catalog);
    expect(divergence.missingIngredients).toEqual([]);
    // Stored block may only exceed computed by broth + rice share, never fat-heavy.
    expect(divergence.unattributed.fatGrams).toBeLessThan(3);
  });

  test("personal label corrections are live in the catalog (rubric S7)", async () => {
    const { catalog } = await loadRealPresets();
    const bySlug = new Map(catalog.foods.map((food) => [food.slug, food]));
    expect(bySlug.get("yogurt_high_protein")?.proteinGramsPer100g).toBe(11);
    expect(bySlug.get("yogurt_high_protein")?.fatGramsPer100g).toBe(0);
    expect(bySlug.get("whole_milk")?.fatGramsPer100g).toBe(1.5);
    expect(bySlug.get("oats")?.kcalPer100g).toBe(369);
    expect(bySlug.get("quinoa_ciabatta")?.kcalPer100g).toBe(224);
    expect(bySlug.get("olive_oil")?.fatGramsPer100g).toBeGreaterThan(99);
    expect(bySlug.get("sesame_oil")?.fatGramsPer100g).toBeGreaterThan(99);
  });

  test("plans the primary persona and writes the rubric baseline report", async () => {
    const { catalog, candidates } = await loadRealPresets();
    const startedAt = performance.now();
    const result = generateMealPlan({
      ...PERSONA,
      presetDishes: candidates,
      catalog,
      preferences: { rejectedIngredients: ["pork"] },
    });
    const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;

    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw new Error(result.cannotSatisfy.reason);

    const days = result.plan.days;
    const mains = mainEntriesByDay(days);

    const gates: Record<string, GateResult> = {
      G1_safety: gateSafety(result.plan.entries),
      G2_energy_band: gateEnergyBand(days),
      G3_protein_floor: gateProteinFloor(days),
      G4_rotation: gateRotation(mains),
      G5_completeness: gateCompleteness(days),
      G6_natural_unit_lattice: gateStapleLattice(result.plan.entries),
    };

    const weekly = weeklyTotals(days);
    const avgKcal = weekly.kcal / 7;
    const budgets = {
      B1_fat: {
        pass: weekly.fatGrams <= WEEKLY_FAT_BUDGET,
        actual: round1(weekly.fatGrams),
        budget: WEEKLY_FAT_BUDGET,
        utilizationPercent: round1((weekly.fatGrams / WEEKLY_FAT_BUDGET) * 100),
      },
      B2_sodium: {
        pass: weekly.sodiumMg <= WEEKLY_SODIUM_CAP,
        actual: Math.round(weekly.sodiumMg),
        budget: WEEKLY_SODIUM_CAP,
        utilizationPercent: round1((weekly.sodiumMg / WEEKLY_SODIUM_CAP) * 100),
      },
      B3_carbs: {
        pass: Math.abs(weekly.carbsGrams - WEEKLY_CARBS_BUDGET) <= WEEKLY_CARBS_BUDGET * 0.15,
        actual: round1(weekly.carbsGrams),
        budget: WEEKLY_CARBS_BUDGET,
        deviationPercent: round1(((weekly.carbsGrams - WEEKLY_CARBS_BUDGET) / WEEKLY_CARBS_BUDGET) * 100),
      },
      B4_weekly_avg_kcal: {
        pass: Math.abs(avgKcal - PERSONA.dailyKcalTarget) <= PERSONA.dailyKcalTarget * WEEKLY_AVG_KCAL_TOLERANCE,
        actualAvg: round1(avgKcal),
        target: PERSONA.dailyKcalTarget,
        deviationPercent: round1(((avgKcal - PERSONA.dailyKcalTarget) / PERSONA.dailyKcalTarget) * 100),
      },
      B5_advisory_noise: {
        // v2 claim: budget feedback is weekly, not per-day. Record what the
        // coverage report emits so noise regressions are visible.
        coverageItemsByType: countByType(result.coverage.unmet.map((item) => item.type)),
      },
    };

    const plannedDishes = uniqueDishes(result.plan.entries);
    const divergences = plannedDishes
      .map((dish) => dishNutritionDivergence(dish, catalog))
      .sort((a, b) => b.unattributed.fatGrams - a.unattributed.fatGrams);
    const s6 = summarizeUnattributedFat(days, divergences);

    const poolShapeOk =
      result.pool.breakfasts.length >= 3 && result.pool.breakfasts.length <= 4 &&
      result.pool.mains.length >= 5 && result.pool.mains.length <= 7 &&
      result.pool.sides.length >= 3 && result.pool.sides.length <= 4;
    const mainEntries = result.plan.entries.filter((entry) => entry.mealType !== "breakfast");
    const s4 = {
      entriesWithAlternates: mainEntries.filter((entry) => (entry.alternates?.length ?? 0) >= 1).length,
      mainEntries: mainEntries.length,
      pass: mainEntries.every((entry) => (entry.alternates?.length ?? 0) >= 1),
    };

    const report = {
      doc: "docs/reference-menu-eval-set.md",
      persona: {
        description: "23M / 173cm / 70kg, HB x1.2 activity, -300 slow-loss deficit, no pork",
        ...PERSONA,
        proteinFloorGrams: PROTEIN_FLOOR,
        weeklyFatBudgetGrams: WEEKLY_FAT_BUDGET,
        weeklyCarbsBudgetGrams: WEEKLY_CARBS_BUDGET,
      },
      planner: {
        status: result.status,
        elapsedMs,
        entryCount: result.plan.entries.length,
        distinctDishCount: result.plan.distinctDishCount,
        hardViolations: result.plan.hardViolations,
        waivedFloors: result.waivedFloors ?? [],
        weeklyBudgets: result.plan.weeklyBudgets,
      },
      gates,
      budgets,
      structure: {
        S1_pool_shape: {
          pass: poolShapeOk,
          breakfasts: result.pool.breakfasts.map((dish) => dish.slug),
          mains: result.pool.mains.map((dish) => dish.slug),
          sides: result.pool.sides.map((dish) => dish.slug),
          fatBudgetNotice: result.pool.fatBudgetNotice ?? null,
        },
        S4_alternates: s4,
        S6_unattributed_fat: s6,
        worstDivergences: divergences.slice(0, 8).map(compactDivergence),
      },
      dailyTotals: days.map((day) => ({ date: day.date, ...roundTotals(day.totals) })),
      notes: [
        "Baseline is recorded, not asserted: gate failures here quantify the v1->v2 gap.",
        "G6 checks the staple lever output against the half-bowl (30 g dry) lattice; dish-internal portions are fixed servings until template scaling lands.",
        "Month-scale W2 trajectory (skips/likes/swaps) requires repository interactions and is not part of this static baseline.",
      ],
    };

    // Protein-lever add-ons must reach the shopping list (rubric S5).
    const topUpIngredientSlugs = new Set(result.plan.entries
      .flatMap((entry) => entry.proteinTopUps ?? [])
      .flatMap((topUp) => topUp.ingredients.map((ingredient) => ingredient.slug)));
    const procurementSlugs = new Set(result.procurement.items.map((item) => item.slug));
    for (const slug of topUpIngredientSlugs) {
      expect(procurementSlugs).toContain(slug);
    }

    const evidenceDir = path.resolve("evidence/reference-eval");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.join(evidenceDir, "baseline.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );

    expect(result.plan.entries.length).toBe(21);
  }, 60_000);
});

function gateSafety(entries: readonly MealPlanEntry[]): GateResult {
  const offenders = entries
    .flatMap((entry) => [entry.dish, entry.side].filter((dish): dish is RecipeDish => dish !== undefined))
    .filter((dish) => dish.ingredients.some((ingredient) => /pork|lamb/i.test(ingredient.slug)));
  return {
    pass: offenders.length === 0,
    detail: offenders.length === 0 ? "no forbidden ingredients planned" : offenders.map((dish) => dish.slug).join(", "),
  };
}

function gateEnergyBand(days: readonly MealPlanDay[]): GateResult {
  const low = PERSONA.dailyKcalTarget * (1 - ENERGY_TOLERANCE);
  const high = PERSONA.dailyKcalTarget * (1 + ENERGY_TOLERANCE);
  const outliers = days.filter((day) => day.totals.kcal < low || day.totals.kcal > high);
  return {
    pass: outliers.length === 0,
    detail: outliers.length === 0
      ? `all days within ${Math.round(low)}-${Math.round(high)} kcal`
      : outliers.map((day) => `${day.date}: ${day.totals.kcal} kcal`).join("; "),
  };
}

function gateProteinFloor(days: readonly MealPlanDay[]): GateResult {
  const under = days.filter((day) => day.totals.proteinGrams < PROTEIN_FLOOR);
  return {
    pass: under.length === 0,
    detail: under.length === 0
      ? `all days >= ${PROTEIN_FLOOR} g`
      : under.map((day) => `${day.date}: ${day.totals.proteinGrams} g`).join("; "),
  };
}

function gateRotation(mainsByDay: readonly (readonly string[])[]): GateResult {
  const problems: string[] = [];
  const weeklyCounts = new Map<string, number>();
  mainsByDay.forEach((slugs, dayIndex) => {
    for (const slug of slugs) {
      weeklyCounts.set(slug, (weeklyCounts.get(slug) ?? 0) + 1);
      if (dayIndex > 0 && (mainsByDay[dayIndex - 1] ?? []).includes(slug)) {
        problems.push(`${slug} on consecutive days ${dayIndex}/${dayIndex + 1}`);
      }
    }
  });
  for (const [slug, count] of weeklyCounts) {
    if (count > 2) problems.push(`${slug} planned ${count}x/week`);
  }
  return {
    pass: problems.length === 0,
    detail: problems.length === 0 ? "no main 2 days running; all mains <= 2x/week" : problems.join("; "),
  };
}

function gateCompleteness(days: readonly MealPlanDay[]): GateResult {
  const incomplete = days.filter((day) => {
    const types = new Set(day.meals.map((meal) => meal.mealType));
    return !(types.has("breakfast") && types.has("lunch") && types.has("dinner"));
  });
  return {
    pass: incomplete.length === 0,
    detail: incomplete.length === 0 ? "7 days x breakfast/lunch/dinner" : incomplete.map((day) => day.date).join(", "),
  };
}

function gateStapleLattice(entries: readonly MealPlanEntry[]): GateResult {
  const staples = entries.filter((entry) => entry.staple !== undefined);
  const offLattice = staples.filter((entry) => (entry.staple as { grams: number }).grams % STAPLE_HALF_UNIT_GRAMS !== 0);
  const gramsSeen = [...new Set(staples.map((entry) => (entry.staple as { grams: number }).grams))].sort((a, b) => a - b);
  return {
    pass: staples.length > 0 && offLattice.length === 0,
    detail: staples.length === 0
      ? "no staple portions emitted"
      : `staple grams seen: [${gramsSeen.join(", ")}]; off-lattice: ${offLattice.length}/${staples.length} (half-bowl = ${STAPLE_HALF_UNIT_GRAMS} g dry)`,
  };
}

function mainEntriesByDay(days: readonly MealPlanDay[]): readonly (readonly string[])[] {
  return days.map((day) => day.meals
    .filter((meal) => meal.mealType !== "breakfast")
    .map((meal) => meal.dish.slug));
}

function weeklyTotals(days: readonly MealPlanDay[]): { kcal: number; proteinGrams: number; carbsGrams: number; fatGrams: number; sodiumMg: number } {
  return days.reduce(
    (total, day) => ({
      kcal: total.kcal + day.totals.kcal,
      proteinGrams: total.proteinGrams + day.totals.proteinGrams,
      carbsGrams: total.carbsGrams + day.totals.carbsGrams,
      fatGrams: total.fatGrams + day.totals.fatGrams,
      sodiumMg: total.sodiumMg + day.totals.sodiumMg,
    }),
    { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 },
  );
}

function uniqueDishes(entries: readonly MealPlanEntry[]): RecipeDish[] {
  const seen = new Map<string, RecipeDish>();
  for (const entry of entries) {
    for (const dish of [entry.dish, entry.side]) {
      if (dish !== undefined && !seen.has(dish.slug)) seen.set(dish.slug, dish);
    }
  }
  return [...seen.values()];
}

function summarizeUnattributedFat(
  days: readonly MealPlanDay[],
  divergences: readonly DishNutritionDivergence[],
): { avgUnattributedFatGramsPerDay: number; shareOfDailyFatCeilingPercent: number; dishesOverThreeGrams: number } {
  const bySlug = new Map(divergences.map((item) => [item.slug, item]));
  let weeklyUnattributedFat = 0;
  for (const day of days) {
    for (const meal of day.meals) {
      for (const dish of [meal.dish, meal.side]) {
        if (dish === undefined) continue;
        const divergence = bySlug.get(dish.slug);
        if (divergence !== undefined && divergence.unattributed.fatGrams > 0) {
          weeklyUnattributedFat += divergence.unattributed.fatGrams;
        }
      }
    }
  }
  const perDay = weeklyUnattributedFat / 7;
  return {
    avgUnattributedFatGramsPerDay: round1(perDay),
    shareOfDailyFatCeilingPercent: round1((perDay / PERSONA.dailyFatTarget) * 100),
    dishesOverThreeGrams: divergences.filter((item) => item.unattributed.fatGrams > 3).length,
  };
}

function compactDivergence(item: DishNutritionDivergence): Record<string, unknown> {
  return {
    slug: item.slug,
    unattributedFatGrams: item.unattributed.fatGrams,
    unattributedKcal: item.unattributed.kcal,
    missingIngredients: item.missingIngredients,
  };
}

function countByType(types: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of types) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

function roundTotals(totals: { kcal: number; proteinGrams: number; carbsGrams: number; fatGrams: number; sodiumMg: number }): Record<string, number> {
  return {
    kcal: Math.round(totals.kcal),
    proteinGrams: round1(totals.proteinGrams),
    carbsGrams: round1(totals.carbsGrams),
    fatGrams: round1(totals.fatGrams),
    sodiumMg: Math.round(totals.sodiumMg),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

let cachedRealPresets: Promise<{ catalog: MealCatalog; candidates: readonly RecipeDish[] }> | undefined;

function loadRealPresets(): Promise<{ catalog: MealCatalog; candidates: readonly RecipeDish[] }> {
  cachedRealPresets ??= (async () => {
    const foods = loadFoodItemsFromCsv(await readFile(path.resolve("seed/ingredients.csv"), "utf8"));
    const catalog: MealCatalog = {
      foods: foods.map((food): FoodCatalogRecord => ({
        slug: food.slug,
        name: food.nameZh ?? food.name,
        nameZh: food.nameZh ?? null,
        aliases: [food.name, ...(food.nameZh ? [food.nameZh] : [])],
        category: food.category ?? null,
        executionBuckets: food.executionBuckets,
        roles: food.roles,
        weeklyFloor: food.weeklyFloor,
        allergenTags: food.allergenTags,
        weightType: food.weightType,
        specialHandlingTags: food.specialHandlingTags,
        defaultGrams: null,
        defaultUnit: null,
        kcalPer100g: food.caloriesKcal,
        proteinGramsPer100g: food.proteinGrams,
        carbsGramsPer100g: food.carbsGrams,
        fatGramsPer100g: food.fatGrams,
        sodiumMgPer100g: food.sodiumMg,
      })),
      naturalUnits: [],
    };
    const candidates = presetDishes.map((dish) => ({ ...dish, ...dishBucketsRoles(dish, catalog) }));
    return { catalog, candidates };
  })();
  return cachedRealPresets;
}
