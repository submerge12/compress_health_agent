import { describe, expect, test } from "vitest";

import { scorePlan } from "../../src/engine/meal-plan-scoring.js";
import type { MealPlanEntry, WeeklyMealPlan } from "../../src/engine/meal-planner.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";

function dish(slug: string, kcal: number, proteinGrams: number, buckets: string[] = []): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes: ["lunch", "dinner"],
    nutrition: { kcal, proteinGrams, carbsGrams: 60, fatGrams: 20, sodiumMg: 400 },
    ingredients: [{ slug, grams: 100 }],
    seasonings: [],
    source: "preset",
    buckets,
    weeklyFloors: Object.fromEntries(buckets.map((bucket) => [bucket, 2])),
  };
}

function entry(dayIndex: number, mealType: "breakfast" | "lunch" | "dinner", dish: RecipeDish): MealPlanEntry {
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

function plan(entries: readonly MealPlanEntry[]): WeeklyMealPlan {
  const days = Array.from({ length: 7 }, (_, dayIndex) => {
    const meals = entries.filter((item) => item.dayIndex === dayIndex);
    return {
      date: `2026-06-${16 + dayIndex}`,
      meals,
      totals: {
        kcal: meals.reduce((sum, item) => sum + item.nutrition.kcal, 0),
        proteinGrams: meals.reduce((sum, item) => sum + item.nutrition.proteinGrams, 0),
        carbsGrams: meals.reduce((sum, item) => sum + item.nutrition.carbsGrams, 0),
        fatGrams: meals.reduce((sum, item) => sum + item.nutrition.fatGrams, 0),
        sodiumMg: meals.reduce((sum, item) => sum + item.nutrition.sodiumMg, 0),
      },
    };
  });
  return {
    startDate: "2026-06-16",
    days,
    entries,
    distinctDishCount: new Set(entries.map((item) => item.dish.slug)).size,
    hardViolations: [],
  };
}

describe("scorePlan", () => {
  test("penalizes lower protein more than variety loss", () => {
    const highProteinRepeat = dish("protein", 600, 45);
    const lowProteinVariety = [dish("variety_a", 600, 15), dish("variety_b", 600, 15), dish("variety_c", 600, 15)];

    const highProteinPlan = plan(Array.from({ length: 21 }, (_, index) =>
      entry(Math.floor(index / 3), ["breakfast", "lunch", "dinner"][index % 3] as "breakfast" | "lunch" | "dinner", highProteinRepeat),
    ));
    const lowProteinPlan = plan(Array.from({ length: 21 }, (_, index) =>
      entry(Math.floor(index / 3), ["breakfast", "lunch", "dinner"][index % 3] as "breakfast" | "lunch" | "dinner", lowProteinVariety[index % 3]!),
    ));

    expect(scorePlan(highProteinPlan, { dailyProteinTarget: 120 }).penalty)
      .toBeLessThan(scorePlan(lowProteinPlan, { dailyProteinTarget: 120 }).penalty);
  });

  test("adds weekly floor penalty when classified bucket servings are below target", () => {
    const redMeat = dish("beef", 600, 40, ["red_meat"]);
    const plain = dish("plain", 600, 40);
    const floorMet = plan([
      entry(0, "lunch", redMeat),
      entry(1, "lunch", redMeat),
    ]);
    const floorMissed = plan([
      entry(0, "lunch", plain),
      entry(1, "lunch", redMeat),
    ]);

    // Isolate red_meat so the default config's fish/shellfish floors don't interfere.
    expect(scorePlan(floorMet, { dailyProteinTarget: 80, weeklyFloors: { red_meat: 2 } }).breakdown.weeklyFloor).toBe(0);
    expect(scorePlan(floorMissed, { dailyProteinTarget: 80, weeklyFloors: { red_meat: 2 } }).breakdown.weeklyFloor).toBeGreaterThan(0);
  });

  test("penalizes a configured floor bucket that is entirely absent from the plan (regression)", () => {
    // Plan has only deep-sea fish; red_meat (config floor 2) never appears. The
    // floor must still be enforced — the old code harvested floors only from
    // selected dishes, so an absent bucket silently incurred no penalty.
    const fish = dish("fish", 600, 40, ["deep_sea_fish"]);
    const fishOnly = plan([entry(0, "lunch", fish), entry(1, "lunch", fish)]);

    expect(scorePlan(fishOnly, { dailyProteinTarget: 80, weeklyFloors: { red_meat: 2 } }).breakdown.weeklyFloor)
      .toBeGreaterThan(0);
    // Default config also flags it (red_meat + shellfish absent).
    expect(scorePlan(fishOnly, { dailyProteinTarget: 80 }).breakdown.weeklyFloor).toBeGreaterThan(0);
  });
});
