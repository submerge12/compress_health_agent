import { describe, expect, test } from "vitest";

import { buildProcurementList } from "../../src/engine/procurement.js";
import type { MealPlanEntry, WeeklyMealPlan } from "../../src/engine/meal-planner.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import type { MealCatalog } from "../../src/tools/nutrition-estimate.js";

const catalog: MealCatalog = {
  foods: [
    {
      slug: "beef_tenderloin",
      name: "beef tenderloin",
      aliases: [],
      defaultGrams: 150,
      defaultUnit: "serving",
      kcalPer100g: 180,
      proteinGramsPer100g: 22,
      carbsGramsPer100g: 0,
      fatGramsPer100g: 9,
      sodiumMgPer100g: 60,
      executionBuckets: ["red_meat"],
      roles: ["iron", "b12"],
      weeklyFloor: 2,
    },
    {
      slug: "broccoli",
      name: "broccoli",
      aliases: [],
      defaultGrams: 100,
      defaultUnit: "serving",
      kcalPer100g: 35,
      proteinGramsPer100g: 2.4,
      carbsGramsPer100g: 7.2,
      fatGramsPer100g: 0.4,
      sodiumMgPer100g: 41,
      executionBuckets: ["vegetable"],
      roles: [],
      weeklyFloor: 0,
    },
  ],
  naturalUnits: [],
};

describe("buildProcurementList", () => {
  test("aggregates grams with buffer, rounds to 10g, and flags key foods", () => {
    const plan = planWith([
      entry(0, dish("beef_bowl", [
        { slug: "beef_tenderloin", grams: 101 },
        { slug: "broccoli", grams: 100 },
      ])),
      entry(1, dish("beef_plate", [
        { slug: "beef_tenderloin", grams: 50 },
      ])),
    ]);

    const procurement = buildProcurementList(plan, catalog);

    expect(procurement.items).toEqual([
      {
        slug: "beef_tenderloin",
        totalGrams: 151,
        bufferedGrams: 180,
        buckets: ["red_meat"],
        roles: ["b12", "iron"],
        keyFood: true,
        dishCount: 2,
      },
      {
        slug: "broccoli",
        totalGrams: 100,
        bufferedGrams: 120,
        buckets: ["vegetable"],
        roles: [],
        keyFood: false,
        dishCount: 1,
      },
    ]);
  });
});

function dish(slug: string, ingredients: RecipeDish["ingredients"]): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes: ["lunch", "dinner"],
    nutrition: { kcal: 600, proteinGrams: 35, carbsGrams: 60, fatGrams: 20, sodiumMg: 400 },
    ingredients,
    seasonings: [],
    source: "preset",
    buckets: ["red_meat"],
    weeklyFloors: { red_meat: 2 },
  };
}

function entry(dayIndex: number, dish: RecipeDish): MealPlanEntry {
  return {
    id: `${dayIndex}-lunch`,
    date: `2026-06-${16 + dayIndex}`,
    dayIndex,
    mealType: "lunch",
    targetKcal: dish.nutrition.kcal,
    dish,
    nutrition: dish.nutrition,
    status: "planned",
  };
}

function planWith(entries: readonly MealPlanEntry[]): WeeklyMealPlan {
  return {
    startDate: "2026-06-16",
    days: [],
    entries,
    distinctDishCount: new Set(entries.map((item) => item.dish.slug)).size,
    hardViolations: [],
  };
}
