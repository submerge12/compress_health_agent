import { describe, expect, test } from "vitest";

import {
  DEFAULT_STAPLE,
  composeMealNutrition,
  solveProteinTopUps,
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
      weightType: "raw",
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
      weightType: "raw",
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
      weightType: "dry",
      kcalPer100g: 348,
      proteinGramsPer100g: 7.7,
      carbsGramsPer100g: 75,
      fatGramsPer100g: 2.7,
      sodiumMgPer100g: 1,
    },
    {
      slug: "egg",
      name: "egg",
      aliases: [],
      defaultGrams: 50,
      defaultUnit: "piece",
      weightType: "raw",
      kcalPer100g: 144,
      proteinGramsPer100g: 13,
      carbsGramsPer100g: 1.1,
      fatGramsPer100g: 9.5,
      sodiumMgPer100g: 140,
      allergenTags: ["egg"],
    },
    {
      slug: "tofu",
      name: "tofu",
      aliases: [],
      defaultGrams: 150,
      defaultUnit: "serving",
      weightType: "raw",
      kcalPer100g: 84,
      proteinGramsPer100g: 8.1,
      carbsGramsPer100g: 2,
      fatGramsPer100g: 4.8,
      sodiumMgPer100g: 8,
      allergenTags: ["soy"],
    },
    {
      slug: "soy_milk",
      name: "soy milk",
      aliases: [],
      defaultGrams: 250,
      defaultUnit: "cup",
      weightType: "raw",
      kcalPer100g: 32,
      proteinGramsPer100g: 3,
      carbsGramsPer100g: 1.8,
      fatGramsPer100g: 1.6,
      sodiumMgPer100g: 14,
      allergenTags: ["soy"],
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

    // Half-bowl lattice (30 g dry): the 350 kcal gap solves to 90 g total,
    // split 1 碗 + 半碗 instead of scale-precise 50/50.
    expect(result.portions).toEqual([
      { slug: "brown_rice", grams: 60 },
      { slug: "brown_rice", grams: 30 },
    ]);
    expect(result.composedKcal).toBe(1763);
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

  test("solveProteinTopUps adds ordered protein portions until a low-protein day reaches the floor", () => {
    const result = solveProteinTopUps({
      proteinFloorGrams: 92,
      fixedNutrition: { kcal: 1200, proteinGrams: 70, carbsGrams: 140, fatGrams: 35, sodiumMg: 800 },
      remainingKcalBudget: 300,
      catalog,
    });

    expect(result.addOns.map((addOn) => addOn.slug)).toEqual([
      "protein_topup_egg",
      "protein_topup_tofu",
      "protein_topup_soy_milk",
    ]);
    expect(result.composedNutrition.proteinGrams).toBeGreaterThanOrEqual(92);
    expect(result.meetsProteinFloor).toBe(true);
  });

  test("solveProteinTopUps filters add-ons that violate allergen and dislike preferences", () => {
    const result = solveProteinTopUps({
      proteinFloorGrams: 82,
      fixedNutrition: { kcal: 1200, proteinGrams: 70, carbsGrams: 140, fatGrams: 35, sodiumMg: 800 },
      remainingKcalBudget: 300,
      preferences: {
        allergens: ["soy"],
        rejectedIngredients: ["egg"],
      },
      catalog,
    });

    expect(result.addOns).toEqual([]);
    expect(result.meetsProteinFloor).toBe(false);
  });

  test("solveProteinTopUps keeps add-on kcal inside the remaining staple energy budget", () => {
    const result = solveProteinTopUps({
      proteinFloorGrams: 92,
      fixedNutrition: { kcal: 1200, proteinGrams: 70, carbsGrams: 140, fatGrams: 35, sodiumMg: 800 },
      remainingKcalBudget: 200,
      catalog,
    });

    const addOnKcal = result.addOns.reduce((sum, addOn) => sum + addOn.nutrition.kcal, 0);
    expect(result.addOns.map((addOn) => addOn.slug)).toEqual([
      "protein_topup_egg",
      "protein_topup_tofu",
    ]);
    expect(addOnKcal).toBeLessThanOrEqual(200);
    expect(result.kcalWithinBudget).toBe(true);
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
