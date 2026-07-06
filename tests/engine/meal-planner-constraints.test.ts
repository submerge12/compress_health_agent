import { describe, expect, test } from "vitest";

import {
  generateWeeklyMealPlan,
  MealPlanInfeasibleError,
  validateWeeklyMealPlan,
} from "../../src/engine/meal-planner.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";

function dish(
  slug: string,
  mealTypes: RecipeDish["mealTypes"],
  kcal: number,
  proteinGrams: number,
  ingredientSlug = slug,
  macros: Partial<RecipeDish["nutrition"]> = {},
): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes,
    nutrition: {
      kcal,
      proteinGrams,
      carbsGrams: Math.round(kcal / 8),
      fatGrams: Math.round(kcal / 30),
      sodiumMg: 300,
      ...macros,
    },
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

    expect(validateWeeklyMealPlan(okPlan, { dailyKcalTarget: 1800, dailyProteinTarget: 100 }).ok).toBe(true);
    expect(() =>
      generateWeeklyMealPlan({
        startDate: "2026-06-16",
        dailyKcalTarget: 1800,
        dailyProteinTarget: 100,
        presetDishes: [dish("breakfast_low", ["breakfast"], 450, 19), dish("main_low", ["lunch", "dinner"], 675, 30)],
      })
    ).toThrow(MealPlanInfeasibleError);
  });

  test("blocks with a structured explanation when protein is infeasible", () => {
    expect(() =>
      generateWeeklyMealPlan({
        startDate: "2026-06-16",
        dailyKcalTarget: 1800,
        dailyProteinTarget: 160,
        presetDishes: [dish("low_breakfast", ["breakfast"], 450, 10), dish("low_main", ["lunch", "dinner"], 675, 20)],
      })
    ).toThrow(MealPlanInfeasibleError);

    try {
      generateWeeklyMealPlan({
        startDate: "2026-06-16",
        dailyKcalTarget: 1800,
        dailyProteinTarget: 160,
        presetDishes: [dish("low_breakfast", ["breakfast"], 450, 10), dish("low_main", ["lunch", "dinner"], 675, 20)],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MealPlanInfeasibleError);
      expect((error as MealPlanInfeasibleError).result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "protein_floor", date: "2026-06-16" }),
        ]),
      );
      expect((error as MealPlanInfeasibleError).result.suggestions.join(" ")).toContain("lean protein");
    }
  });

  test("treats the personalized fat ceiling as soft: still generates a plan, surfaces it as weekly budget", () => {
    const request = {
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      dailyFatTarget: 35,
      presetDishes: [
        dish("fatty_breakfast", ["breakfast"], 450, 30, "egg", { fatGrams: 28 }),
        dish("fatty_main", ["lunch", "dinner"], 675, 45, "pork", { fatGrams: 32 }),
      ],
    };

    // Fat over the ceiling must NOT block generation.
    const plan = generateWeeklyMealPlan(request);
    expect(plan.entries.length).toBeGreaterThan(0);
    expect(plan.hardViolations).toEqual([]);

    // ...but it is surfaced as a weekly budget, not a per-day advisory.
    const validation = validateWeeklyMealPlan(plan, { dailyKcalTarget: 1800, dailyFatTarget: 35 });
    expect(validation.ok).toBe(true);
    expect(validation.violations.join(" ")).not.toContain("ceiling");
    expect(plan.weeklyBudgets.fat.status).toBe("over");
  });

  test("does not let the soft fat ceiling outrank hard energy feasibility", () => {
    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 90,
      dailyFatTarget: 30,
      presetDishes: [
        dish("balanced_breakfast", ["breakfast"], 450, 30, "egg", { fatGrams: 5 }),
        dish("low_fat_under_energy_main", ["lunch", "dinner"], 500, 35, "chicken", { fatGrams: 5 }),
        dish("high_fat_energy_fitting_main", ["lunch", "dinner"], 675, 35, "pork", { fatGrams: 40 }),
      ],
    });

    expect(plan.hardViolations).toEqual([]);
    expect(validateWeeklyMealPlan(plan, { dailyKcalTarget: 1800, dailyFatTarget: 30 }).violations.join(" "))
      .not.toContain("fat");
    expect(plan.weeklyBudgets.fat.status).toBe("over");
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

  test("filters dishes with allergen group tags and hidden allergen seasonings before planning", () => {
    const safeMain = dish("safe_main", ["lunch", "dinner"], 675, 45, "chicken_breast");
    const shrimpMain = dish("shrimp_main", ["lunch", "dinner"], 675, 60, "shrimp_jiweixia");
    const oysterSauceMain = {
      ...dish("oyster_sauce_main", ["lunch", "dinner"], 675, 45, "beef_tenderloin"),
      seasonings: ["oyster_sauce"],
    };

    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      presetDishes: [breakfast, safeMain, shrimpMain, oysterSauceMain],
      preferences: { allergens: ["seafood"] },
    });

    expect(plan.entries.map((entry) => entry.dish.slug)).not.toContain("shrimp_main");
    expect(plan.entries.map((entry) => entry.dish.slug)).not.toContain("oyster_sauce_main");
    expect(plan.entries.some((entry) => entry.dish.slug === "safe_main")).toBe(true);
  });
});
