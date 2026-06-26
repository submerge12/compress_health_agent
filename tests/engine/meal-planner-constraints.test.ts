import { describe, expect, test } from "vitest";

import {
  generateWeeklyMealPlan,
  validateWeeklyMealPlan,
} from "../../src/engine/meal-planner.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";

function dish(
  slug: string,
  mealTypes: RecipeDish["mealTypes"],
  kcal: number,
  proteinGrams: number,
  ingredientSlug = slug,
): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes,
    nutrition: { kcal, proteinGrams, carbsGrams: Math.round(kcal / 8), fatGrams: Math.round(kcal / 30), sodiumMg: 300 },
    ingredients: [{ slug: ingredientSlug, grams: 100 }],
    seasonings: [],
    source: "preset",
  };
}

const breakfast = dish("breakfast", ["breakfast"], 450, 30);
const mainA = dish("main_a", ["lunch", "dinner"], 675, 45);
const mainB = dish("main_b", ["lunch", "dinner"], 675, 45);

describe("meal planner hard constraints", () => {
  test("treats main dishes as eligible for both lunch and dinner", () => {
    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      presetDishes: [breakfast, mainA, mainB],
    });

    expect(plan.entries).toHaveLength(21);
    expect(plan.days.every((day) => day.meals.map((meal) => meal.mealType).join(",") === "breakfast,lunch,dinner")).toBe(true);
    expect(plan.days.every((day) => day.totals.kcal === 1800)).toBe(true);
    expect(plan.hardViolations).toEqual([]);
  });

  test("validates protein floor boundary at 80 percent of target", () => {
    const okPlan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      presetDishes: [dish("breakfast_ok", ["breakfast"], 450, 20), dish("main_ok", ["lunch", "dinner"], 675, 30)],
    });
    const lowPlan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      presetDishes: [dish("breakfast_low", ["breakfast"], 450, 19), dish("main_low", ["lunch", "dinner"], 675, 30)],
    });

    expect(validateWeeklyMealPlan(okPlan, { dailyKcalTarget: 1800, dailyProteinTarget: 100 }).ok).toBe(true);
    expect(validateWeeklyMealPlan(lowPlan, { dailyKcalTarget: 1800, dailyProteinTarget: 100 }).violations)
      .toContain("2026-06-16 protein 79g below 80g floor");
  });

  test("returns best-effort plan with hard violation report instead of throwing when protein is infeasible", () => {
    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 160,
      presetDishes: [dish("low_breakfast", ["breakfast"], 450, 10), dish("low_main", ["lunch", "dinner"], 675, 20)],
    });

    expect(plan.entries).toHaveLength(21);
    expect(plan.hardViolations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "protein_floor", date: "2026-06-16" }),
      ]),
    );
  });

  test("filters dishes with rejected ingredients before planning", () => {
    const safeMain = dish("safe_main", ["lunch", "dinner"], 675, 45, "chicken");
    const excludedMain = dish("excluded_main", ["lunch", "dinner"], 675, 60, "shrimp");

    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      presetDishes: [breakfast, safeMain, excludedMain],
      preferences: { rejectedIngredients: ["shrimp"] },
    });

    expect(plan.entries.map((entry) => entry.dish.slug)).not.toContain("excluded_main");
  });
});
