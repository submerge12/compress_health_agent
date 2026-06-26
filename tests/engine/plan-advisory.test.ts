import { describe, expect, test } from "vitest";

import { buildCoverageReport } from "../../src/engine/plan-advisory.js";
import type { MealPlanEntry, WeeklyMealPlan } from "../../src/engine/meal-planner.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";

describe("buildCoverageReport", () => {
  test("enumerates unmet weekly floors, protein average, sodium, and diversity terms", () => {
    const beef = dish("beef", 600, 40, 900, ["red_meat"], { red_meat: 2 });
    const plain = dish("plain", 600, 20, 2600);
    const entries = [
      entry(0, "breakfast", plain),
      entry(0, "lunch", beef),
      entry(0, "dinner", plain),
      entry(1, "breakfast", plain),
      entry(1, "lunch", plain),
      entry(1, "dinner", plain),
    ];
    const plan = planWith(entries);

    const report = buildCoverageReport(plan, {
      dailyProteinTarget: 100,
      weeklyFloors: { red_meat: 2, deep_sea_fish: 2 },
    });

    expect(report.unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "weekly_floor", key: "deep_sea_fish", actual: 0, target: 2 }),
        expect.objectContaining({ type: "weekly_floor", key: "red_meat", actual: 1, target: 2 }),
        expect.objectContaining({ type: "protein_average", actual: 70, target: 100 }),
        expect.objectContaining({ type: "sodium", key: "days_over_cap", actual: 2, target: 0 }),
        expect.objectContaining({ type: "diversity", actual: 2, target: 10 }),
      ]),
    );
  });
});

function dish(
  slug: string,
  kcal: number,
  proteinGrams: number,
  sodiumMg: number,
  buckets: string[] = [],
  weeklyFloors: Record<string, number> = {},
): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes: ["breakfast", "lunch", "dinner"],
    nutrition: { kcal, proteinGrams, carbsGrams: 60, fatGrams: 20, sodiumMg },
    ingredients: [{ slug, grams: 100 }],
    seasonings: [],
    source: "preset",
    buckets,
    weeklyFloors,
  };
}

function entry(dayIndex: number, mealType: MealPlanEntry["mealType"], dish: RecipeDish): MealPlanEntry {
  return {
    id: `${dayIndex}-${mealType}`,
    date: `2026-06-${16 + dayIndex}`,
    dayIndex,
    mealType,
    targetKcal: dish.nutrition.kcal,
    dish,
    nutrition: dish.nutrition,
    status: "planned",
  };
}

function planWith(entries: readonly MealPlanEntry[]): WeeklyMealPlan {
  return {
    startDate: "2026-06-16",
    days: [
      day("2026-06-16", entries.filter((entry) => entry.dayIndex === 0)),
      day("2026-06-17", entries.filter((entry) => entry.dayIndex === 1)),
    ],
    entries,
    distinctDishCount: new Set(entries.map((entry) => entry.dish.slug)).size,
    hardViolations: [],
  };
}

function day(date: string, meals: readonly MealPlanEntry[]): WeeklyMealPlan["days"][number] {
  return {
    date,
    meals,
    totals: {
      kcal: meals.reduce((sum, meal) => sum + meal.nutrition.kcal, 0),
      proteinGrams: meals.reduce((sum, meal) => sum + meal.nutrition.proteinGrams, 0),
      carbsGrams: meals.reduce((sum, meal) => sum + meal.nutrition.carbsGrams, 0),
      fatGrams: meals.reduce((sum, meal) => sum + meal.nutrition.fatGrams, 0),
      sodiumMg: meals.reduce((sum, meal) => sum + meal.nutrition.sodiumMg, 0),
    },
  };
}
