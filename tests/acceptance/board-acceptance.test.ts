import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { presetDishes } from "../../src/data/preset-dishes.js";
import { loadFoodItemsFromCsv } from "../../src/db/seed.js";
import { dishBucketsRoles } from "../../src/engine/classification.js";
import {
  buildDayEntries,
  type MealPlanRequest,
  type WeeklyMealPlan,
} from "../../src/engine/meal-planner.js";
import { MAX_ENERGY_TOLERANCE_RATIO, PROTEIN_FLOOR_RATIO } from "../../src/engine/scoring-weights.js";
import type { WeeklyPoolPreferences } from "../../src/engine/pool-selection.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import {
  generateMealPlan,
  type GenerateMealPlanPlannedResult,
} from "../../src/tools/generate-meal-plan.js";
import type { FoodCatalogRecord, MealCatalog } from "../../src/tools/nutrition-estimate.js";

/**
 * CHA-MPV2-10: board acceptance for the v2 rotation planner.
 *
 * Full-journey scenarios drive the planner through its PUBLIC API
 * (generateMealPlan) with the repo's dish library and a SYNTHETIC profile —
 * no production source is touched, no user data appears in fixtures or
 * committed evidence. A failing scenario here is a board FINDING, not
 * something this suite works around.
 *
 * Synthetic acceptance profile (not a real user's): 23-30y male fat-loss
 * shape, 1800 kcal / 130 g protein / 50 g fat / 200 g carbs.
 */
const PROFILE = {
  dailyKcalTarget: 1800,
  dailyProteinTarget: 130,
  dailyFatTarget: 50,
  dailyCarbsTarget: 200,
} as const;
const START_DATE = "2026-07-13";
const EVIDENCE_DIR = "evidence/CHA-MPV2-10";

describe("CHA-MPV2-10 board acceptance (v2 planner full journey)", () => {
  test("seafood-allergic fat-loss profile: plan generates, kcal within 5% mean, zero daily advisories, alternates lever-valid, rotation rules hold", async () => {
    const { catalog, candidates } = await realClassifiedPresets();
    const request = {
      startDate: START_DATE,
      ...PROFILE,
      presetDishes: candidates,
      catalog,
      preferences: { allergens: ["seafood"] },
    };
    const result = generateMealPlan(request);

    // (1) the seafood-allergic profile GENERATES a plan
    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw new Error(result.cannotSatisfy.reason);
    expect(result.plan.entries.length).toBe(21);
    const plannedDishes = result.plan.entries.flatMap((entry) =>
      [entry.dish, entry.side].filter((dish): dish is RecipeDish => dish !== undefined));
    expect(plannedDishes.every((dish) => !containsSeafood(dish))).toBe(true);

    // (2) mean |day kcal - target| <= 5%, computed not eyeballed
    const meanAbsDeviationRatio = mean(result.plan.days.map((day) =>
      Math.abs(day.totals.kcal - PROFILE.dailyKcalTarget) / PROFILE.dailyKcalTarget));
    expect(meanAbsDeviationRatio).toBeLessThanOrEqual(0.05);

    // (3) zero per-day fat/sodium/carb advisories; weekly budget report present
    expect(result.plan.hardViolations).toEqual([]);
    // Coverage speaks only in weekly terms — the per-day advisory channel was
    // deleted structurally in v2, so no unmet item can be a daily advisory.
    const coverageTypes = new Set(result.coverage.unmet.map((item) => item.type));
    for (const type of coverageTypes) {
      expect(["weekly_floor", "protein_average", "weekly_budget", "diversity"]).toContain(type);
    }
    expect(result.overview).not.toMatch(/advisory/i);
    for (const budget of [result.plan.weeklyBudgets.fat, result.plan.weeklyBudgets.sodium, result.plan.weeklyBudgets.carbs]) {
      expect(budget.status).toMatch(/^(over|under|on_target|no_target)$/);
      expect(Number.isFinite(budget.actual)).toBe(true);
    }
    expect(result.overview).toContain("Weekly budgets:");

    // (4) every entry's alternates are lever-valid and rotation rules hold
    assertAlternatesLeverValid(result, request);
    assertRotationRules(result.plan);

    await writeScenarioEvidence("scenario-1-seafood-fatloss.json", {
      scenario: "seafood-allergic synthetic fat-loss profile",
      profile: PROFILE,
      startDate: START_DATE,
      status: result.status,
      meanAbsKcalDeviationRatio: round4(meanAbsDeviationRatio),
      dayTotals: result.plan.days.map((day) => ({ date: day.date, ...day.totals })),
      weeklyBudgets: result.plan.weeklyBudgets,
      waivedFloors: result.waivedFloors ?? [],
      entries: result.plan.entries.map((entry) => ({
        date: entry.date,
        mealType: entry.mealType,
        dish: entry.dish.slug,
        kcal: entry.nutrition.kcal,
        proteinGrams: entry.nutrition.proteinGrams,
        alternates: (entry.alternates ?? []).map((alternate) => alternate.slug),
      })),
    });
  }, 30_000);

  test("preference behaviors in-journey: a liked main appears >=2x, a skipped>=2 dish is absent", async () => {
    const { catalog, candidates } = await realClassifiedPresets();
    const base = {
      startDate: START_DATE,
      ...PROFILE,
      presetDishes: candidates,
      catalog,
    };

    // Control run picks the fixture slugs dynamically so the scenario stays
    // valid as the dish library evolves.
    const control = generateMealPlan({ ...base, preferences: {} });
    expect(control.status).toBe("planned");
    if (control.status !== "planned") throw new Error(control.cannotSatisfy.reason);
    const controlMains = [...new Set(control.plan.entries
      .filter((entry) => entry.mealType !== "breakfast")
      .map((entry) => entry.dish.slug))];
    const avoidedSlug = controlMains[0];
    if (avoidedSlug === undefined) throw new Error("control plan has no mains");
    const likedSlug = candidates.find((dish) =>
      dish.role !== "side" &&
      dish.slug !== avoidedSlug &&
      (dish.mealTypes?.includes("lunch") ?? false) &&
      !controlMains.includes(dish.slug))?.slug ?? controlMains[1];
    if (likedSlug === undefined) throw new Error("no liked-fixture main available");

    const preferences: WeeklyPoolPreferences = {
      likedDishSlugs: [likedSlug],
      avoidedDishSlugs: [avoidedSlug],
    };
    const result = generateMealPlan({ ...base, preferences });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw new Error(result.cannotSatisfy.reason);

    const mainUses = new Map<string, number>();
    for (const entry of result.plan.entries.filter((item) => item.mealType !== "breakfast")) {
      mainUses.set(entry.dish.slug, (mainUses.get(entry.dish.slug) ?? 0) + 1);
    }
    // (5a) liked main receives >= 2 slots in the generated week
    expect(mainUses.get(likedSlug) ?? 0).toBeGreaterThanOrEqual(2);
    // (5b) the skipped>=2 dish is absent from the whole week
    expect(mainUses.has(avoidedSlug)).toBe(false);
    expect(result.plan.entries.some((entry) => entry.dish.slug === avoidedSlug)).toBe(false);

    await writeScenarioEvidence("scenario-2-preferences.json", {
      scenario: "W2 preference signals in the full journey",
      profile: PROFILE,
      startDate: START_DATE,
      likedSlug,
      avoidedSlug,
      likedUses: mainUses.get(likedSlug) ?? 0,
      avoidedPresent: mainUses.has(avoidedSlug),
      mains: [...mainUses.entries()].map(([slug, uses]) => ({ slug, uses })),
      poolNotices: result.pool.poolNotices ?? [],
    });
  }, 30_000);
});

function assertAlternatesLeverValid(
  result: GenerateMealPlanPlannedResult,
  request: Omit<MealPlanRequest, "pools"> & { presetDishes: readonly RecipeDish[] },
): void {
  const poolMainSlugs = new Set(result.pool.mains.map((item) => item.slug));
  const dishBySlug = new Map(request.presetDishes.map((dish) => [dish.slug, dish]));
  const proteinFloor = Math.round(PROFILE.dailyProteinTarget * PROTEIN_FLOOR_RATIO);
  let vetted = 0;

  result.plan.days.forEach((day, dayIndex) => {
    const byType = new Map(day.meals.map((meal) => [meal.mealType, meal]));
    const breakfast = byType.get("breakfast");
    const lunch = byType.get("lunch");
    const dinner = byType.get("dinner");
    if (breakfast === undefined || lunch === undefined || dinner === undefined) {
      throw new Error(`${day.date} is structurally incomplete`);
    }
    for (const entry of [lunch, dinner]) {
      const alternates = entry.alternates ?? [];
      expect(alternates.length).toBeGreaterThanOrEqual(1);
      expect(alternates.length).toBeLessThanOrEqual(2);
      for (const alternate of alternates) {
        expect(poolMainSlugs.has(alternate.slug)).toBe(true);
        const substitute = dishBySlug.get(alternate.slug);
        if (substitute === undefined) throw new Error(`alternate ${alternate.slug} not in candidate set`);
        const trial = buildDayEntries(
          request,
          day.date,
          dayIndex,
          breakfast.dish,
          entry.mealType === "lunch" ? substitute : lunch.dish,
          entry.mealType === "dinner" ? substitute : dinner.dish,
          entry.mealType === "lunch" ? undefined : lunch.side,
          entry.mealType === "dinner" ? undefined : dinner.side,
        );
        const kcal = trial.reduce((sum, item) => sum + item.nutrition.kcal, 0);
        const protein = trial.reduce((sum, item) => sum + item.nutrition.proteinGrams, 0);
        expect(Math.abs(kcal - PROFILE.dailyKcalTarget))
          .toBeLessThanOrEqual(PROFILE.dailyKcalTarget * MAX_ENERGY_TOLERANCE_RATIO);
        expect(protein).toBeGreaterThanOrEqual(proteinFloor);
        vetted += 1;
      }
    }
  });
  expect(vetted).toBeGreaterThanOrEqual(14);
}

function assertRotationRules(plan: WeeklyMealPlan): void {
  const mainsByDay = plan.days.map((day) =>
    day.meals.filter((meal) => meal.mealType !== "breakfast").map((meal) => meal.dish.slug));
  const counts = new Map<string, number>();
  mainsByDay.forEach((slugs, dayIndex) => {
    for (const slug of slugs) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
      if (dayIndex > 0) expect(mainsByDay[dayIndex - 1]).not.toContain(slug);
    }
  });
  for (const [slug, count] of counts) {
    expect(count, `${slug} rotates ${count}x`).toBeLessThanOrEqual(2);
  }
}

async function writeScenarioEvidence(fileName: string, payload: unknown): Promise<void> {
  const dir = path.resolve(EVIDENCE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

let cachedPresets: Promise<{ catalog: MealCatalog; candidates: readonly RecipeDish[] }> | undefined;

function realClassifiedPresets(): Promise<{ catalog: MealCatalog; candidates: readonly RecipeDish[] }> {
  cachedPresets ??= (async () => {
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
  return cachedPresets;
}

function containsSeafood(dish: RecipeDish): boolean {
  return dish.ingredients.some((ingredient) => /shrimp|fish|bream|cod|hairtail|sea/i.test(ingredient.slug)) ||
    dish.seasonings.some((seasoning) => /oyster|fish|shrimp/i.test(seasoning)) ||
    (dish.allergenTags ?? []).some((tag) => ["seafood", "fish", "shellfish", "shrimp"].includes(tag));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
