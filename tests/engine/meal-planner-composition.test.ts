import { describe, expect, test } from "vitest";

import {
  generateWeeklyMealPlan,
  MealPlanInfeasibleError,
  validateWeeklyMealPlan,
} from "../../src/engine/meal-planner.js";
import type { RecipeDish, RecipeNutrition } from "../../src/engine/recipe-engine.js";
import type { MealCatalog } from "../../src/tools/nutrition-estimate.js";

const catalog: MealCatalog = {
  foods: [
    food("egg", 150, 13, 1, 10, 120),
    food("oats", 380, 13, 68, 7, 5),
    food("chicken_breast", 165, 31, 0, 3.6, 74),
    food("beef_tenderloin", 180, 22, 0, 9, 60),
    food("broccoli", 35, 2.4, 7.2, 0.4, 41),
    food("brown_rice", 348, 7.7, 75, 2.7, 1),
  ],
  naturalUnits: [],
};

const breakfast = dish("egg_oats", ["breakfast"], [
  { slug: "egg", grams: 100 },
  { slug: "oats", grams: 80 },
]);
const chicken = dish("chicken_broccoli", ["lunch", "dinner"], [
  { slug: "chicken_breast", grams: 180 },
  { slug: "broccoli", grams: 150 },
]);
const beef = dish("beef_broccoli", ["lunch", "dinner"], [
  { slug: "beef_tenderloin", grams: 160 },
  { slug: "broccoli", grams: 150 },
]);
const beefOnly = mainDish("beef_only", false, [
  { slug: "beef_tenderloin", grams: 160 },
]);
const selfContainedChicken = mainDish("self_contained_chicken", true, [
  { slug: "chicken_breast", grams: 180 },
  { slug: "broccoli", grams: 150 },
]);
const broccoliSide = sideDish("broccoli_side", "vegetable", [
  { slug: "broccoli", grams: 100 },
]);

describe("meal planner composition", () => {
  test("adds adjustable brown rice staples to main meals when a catalog is available", () => {
    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1500,
      dailyProteinTarget: 100,
      presetDishes: [breakfast, chicken, beef],
      catalog,
    });

    expect(plan.entries).toHaveLength(21);
    expect(plan.entries.filter((entry) => entry.mealType !== "breakfast").every((entry) =>
      entry.staple?.slug === "brown_rice" && entry.staple.grams >= 40,
    )).toBe(true);
    expect(plan.entries.filter((entry) => entry.mealType === "breakfast").every((entry) =>
      entry.staple === undefined,
    )).toBe(true);
    expect(validateWeeklyMealPlan(plan, { dailyKcalTarget: 1500, dailyProteinTarget: 100 }).ok).toBe(true);
  });

  test("blocks when staple bounds cannot close the energy band", () => {
    expect(() =>
      generateWeeklyMealPlan({
        startDate: "2026-06-16",
        dailyKcalTarget: 3000,
        dailyProteinTarget: 100,
        presetDishes: [breakfast, chicken, beef],
        catalog,
      })
    ).toThrow(MealPlanInfeasibleError);
  });

  test("catalog mode fails instead of falling back to stale dish nutrition for unknown ingredients", () => {
    expect(() =>
      generateWeeklyMealPlan({
        startDate: "2026-06-16",
        dailyKcalTarget: 1500,
        presetDishes: [
          breakfast,
          dish("missing_main", ["lunch", "dinner"], [{ slug: "missing_food", grams: 100 }]),
        ],
        catalog,
      }),
    ).toThrow("Unknown food nutrition record: missing_food");
  });

  test("adds one side to non-self-contained mains when a side candidate is available", () => {
    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1500,
      dailyProteinTarget: 90,
      presetDishes: [breakfast, beefOnly, broccoliSide],
      catalog,
    });

    expect(plan.entries.filter((entry) => entry.mealType !== "breakfast").every((entry) =>
      entry.dish.slug === "beef_only" &&
      entry.side?.slug === "broccoli_side" &&
      entry.nutrition.kcal > entry.dish.nutrition.kcal,
    )).toBe(true);
  });

  test("does not add sides to self-contained mains", () => {
    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1500,
      dailyProteinTarget: 90,
      presetDishes: [breakfast, selfContainedChicken, broccoliSide],
      catalog,
    });

    expect(plan.entries.filter((entry) => entry.mealType !== "breakfast").every((entry) =>
      entry.dish.slug === "self_contained_chicken" && entry.side === undefined,
    )).toBe(true);
  });
});

function dish(slug: string, mealTypes: RecipeDish["mealTypes"], ingredients: RecipeDish["ingredients"]): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes,
    nutrition: zeroNutrition(),
    ingredients,
    seasonings: [],
    source: "preset",
  };
}

function mainDish(
  slug: string,
  selfContained: boolean,
  ingredients: RecipeDish["ingredients"],
): RecipeDish {
  return {
    ...dish(slug, ["lunch", "dinner"], ingredients),
    role: "main",
    selfContained,
  };
}

function sideDish(
  slug: string,
  sideKind: "vegetable" | "soup",
  ingredients: RecipeDish["ingredients"],
): RecipeDish {
  return {
    ...dish(slug, ["lunch", "dinner"], ingredients),
    role: "side",
    sideKind,
  };
}

function food(
  slug: string,
  kcalPer100g: number,
  proteinGramsPer100g: number,
  carbsGramsPer100g: number,
  fatGramsPer100g: number,
  sodiumMgPer100g: number,
): MealCatalog["foods"][number] {
  return {
    slug,
    name: slug,
    aliases: [],
    defaultGrams: 100,
    defaultUnit: "serving",
    weightType: "raw",
    kcalPer100g,
    proteinGramsPer100g,
    carbsGramsPer100g,
    fatGramsPer100g,
    sodiumMgPer100g,
  };
}

function zeroNutrition(): RecipeNutrition {
  return {
    kcal: 0,
    proteinGrams: 0,
    carbsGrams: 0,
    fatGrams: 0,
    sodiumMg: 0,
  };
}
