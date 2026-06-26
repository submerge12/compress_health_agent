import { describe, expect, test } from "vitest";

import {
  DEFAULT_STAPLE,
  composeMealNutrition,
  solveStaplePortionsForDay,
  stapleNutrition,
} from "../../src/engine/meal-composition.js";
import type { RecipeDish, RecipeNutrition } from "../../src/engine/recipe-engine.js";
import type { MealCatalog } from "../../src/tools/nutrition-estimate.js";

const catalog: MealCatalog = {
  foods: [
    {
      slug: "beef_tenderloin",
      name: "beef",
      aliases: [],
      defaultGrams: 150,
      defaultUnit: "serving",
      kcalPer100g: 180,
      proteinGramsPer100g: 22,
      carbsGramsPer100g: 0,
      fatGramsPer100g: 9,
      sodiumMgPer100g: 60,
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
    },
    {
      slug: "brown_rice",
      name: "brown rice",
      aliases: [],
      defaultGrams: 100,
      defaultUnit: "serving",
      kcalPer100g: 348,
      proteinGramsPer100g: 7.7,
      carbsGramsPer100g: 75,
      fatGramsPer100g: 2.7,
      sodiumMgPer100g: 1,
    },
  ],
  naturalUnits: [],
};

describe("meal composition", () => {
  test("stapleNutrition computes a staple portion from catalog nutrition", () => {
    expect(stapleNutrition({ slug: "brown_rice", grams: 50 }, catalog)).toEqual({
      kcal: 174,
      proteinGrams: 3.9,
      carbsGrams: 37.5,
      fatGrams: 1.4,
      sodiumMg: 1,
    });
  });

  test("composeMealNutrition sums main-only dish ingredients and staple nutrition", () => {
    expect(composeMealNutrition({ dish: beefDish, staple: { slug: "brown_rice", grams: 50 } }, catalog))
      .toEqual({
        kcal: 479,
        proteinGrams: 39.3,
        carbsGrams: 44.7,
        fatGrams: 15.3,
        sodiumMg: 132,
      });
  });

  test("composeMealNutrition includes an optional side component", () => {
    expect(composeMealNutrition({
      dish: beefOnlyDish,
      side: broccoliSide,
      staple: { slug: "brown_rice", grams: 50 },
    }, catalog)).toEqual({
      kcal: 479,
      proteinGrams: 39.3,
      carbsGrams: 44.7,
      fatGrams: 15.3,
      sodiumMg: 132,
    });
  });

  test("solveStaplePortionsForDay uses staple grams as the kcal-closing lever", () => {
    const result = solveStaplePortionsForDay({
      dailyKcalTarget: 1800,
      fixedNutrition: nutrition(1450),
      mainMealCount: 2,
      staple: DEFAULT_STAPLE,
      catalog,
    });

    expect(result.portions).toEqual([
      { slug: "brown_rice", grams: 50 },
      { slug: "brown_rice", grams: 50 },
    ]);
    expect(result.composedKcal).toBe(1798);
    expect(result.withinEnergyBand).toBe(true);
    expect(result.clamped).toBe(false);
  });

  test("solveStaplePortionsForDay clamps portions and reports infeasible energy closure", () => {
    const result = solveStaplePortionsForDay({
      dailyKcalTarget: 3200,
      fixedNutrition: nutrition(1450),
      mainMealCount: 2,
      staple: DEFAULT_STAPLE,
      catalog,
    });

    expect(result.portions).toEqual([
      { slug: "brown_rice", grams: 180 },
      { slug: "brown_rice", grams: 180 },
    ]);
    expect(result.clamped).toBe(true);
    expect(result.withinEnergyBand).toBe(false);
  });
});

const beefDish: RecipeDish = {
  slug: "beef_broccoli",
  name: "beef broccoli",
  mealTypes: ["lunch", "dinner"],
  nutrition: nutrition(0),
  ingredients: [
    { slug: "beef_tenderloin", grams: 150 },
    { slug: "broccoli", grams: 100 },
  ],
  seasonings: [],
  source: "preset",
};

const beefOnlyDish: RecipeDish = {
  slug: "beef_only",
  name: "beef only",
  mealTypes: ["lunch", "dinner"],
  role: "main",
  selfContained: false,
  nutrition: nutrition(0),
  ingredients: [
    { slug: "beef_tenderloin", grams: 150 },
  ],
  seasonings: [],
  source: "preset",
};

const broccoliSide: RecipeDish = {
  slug: "broccoli_side",
  name: "broccoli side",
  mealTypes: ["lunch", "dinner"],
  role: "side",
  sideKind: "vegetable",
  nutrition: nutrition(0),
  ingredients: [
    { slug: "broccoli", grams: 100 },
  ],
  seasonings: [],
  source: "preset",
};

function nutrition(kcal: number): RecipeNutrition {
  return {
    kcal,
    proteinGrams: 0,
    carbsGrams: 0,
    fatGrams: 0,
    sodiumMg: 0,
  };
}
