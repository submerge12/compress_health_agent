import { describe, expect, it } from "vitest";
import { aggregateNutrition } from "../../src/engine/nutrition.js";
import type { NutritionRecord } from "../../src/engine/types.js";

const foodRecords: NutritionRecord[] = [
  {
    slug: "chicken_breast",
    kcalPer100g: 165,
    proteinGramsPer100g: 31,
    carbsGramsPer100g: 0,
    fatGramsPer100g: 3.6,
    sodiumMgPer100g: 74,
  },
  {
    slug: "brown_rice",
    kcalPer100g: 111,
    proteinGramsPer100g: 2.6,
    carbsGramsPer100g: 23,
    fatGramsPer100g: 0.9,
    sodiumMgPer100g: 5,
    micronutrientsPer100g: {
      fiberGrams: 1.8,
      calciumMg: 10,
    },
  },
];

const seasoningRecords: NutritionRecord[] = [
  {
    slug: "light_soy_sauce",
    kcalPer100g: 53,
    proteinGramsPer100g: 8,
    carbsGramsPer100g: 4.9,
    fatGramsPer100g: 0,
    sodiumMgPer100g: 5755.555555555556,
  },
  {
    slug: "oyster_sauce",
    kcalPer100g: 114,
    proteinGramsPer100g: 2,
    carbsGramsPer100g: 26,
    fatGramsPer100g: 0.3,
    sodiumMgPer100g: 4366.666666666667,
  },
  {
    slug: "salt",
    kcalPer100g: 0,
    proteinGramsPer100g: 0,
    carbsGramsPer100g: 0,
    fatGramsPer100g: 0,
    sodiumMgPer100g: 39300,
  },
];

describe("nutrition aggregation", () => {
  it("test_aggregateNutrition_foodsAndSeasonings_returnsMacroAndSodiumTotals", () => {
    const result = aggregateNutrition({
      foods: [
        { slug: "chicken_breast", grams: 200 },
        { slug: "brown_rice", grams: 150 },
      ],
      seasonings: [{ slug: "light_soy_sauce", grams: 18 }],
      foodRecords,
      seasoningRecords,
    });

    expect(result.foods).toMatchObject({
      kcal: 497,
      proteinGrams: 65.9,
      carbsGrams: 34.5,
      fatGrams: 8.6,
      sodiumMg: 156,
    });
    expect(result.seasonings.sodiumMg).toBe(1036);
    expect(result.total.sodiumMg).toBe(1192);
    expect(result.total.micronutrients).toMatchObject({
      fiberGrams: 2.7,
      calciumMg: 15,
    });
  });

  it("test_aggregateNutrition_requiredSeasoningSodiumCase_returnsCombinedSeasoningSodium", () => {
    const result = aggregateNutrition({
      foods: [],
      seasonings: [
        { slug: "light_soy_sauce", grams: 18 },
        { slug: "oyster_sauce", grams: 18 },
        { slug: "salt", grams: 1 },
      ],
      foodRecords,
      seasoningRecords,
    });

    expect(result.seasonings.sodiumMg).toBe(2215);
    expect(result.seasoningSodiumMg).toBe(2215);
  });

  it("test_aggregateNutrition_emptyInputs_returnsZeroTotals", () => {
    const result = aggregateNutrition({
      foods: [],
      foodRecords,
    });

    expect(result.total).toEqual({
      kcal: 0,
      proteinGrams: 0,
      carbsGrams: 0,
      fatGrams: 0,
      sodiumMg: 0,
      micronutrients: {},
    });
  });

  it("test_aggregateNutrition_unknownFood_throwsRangeError", () => {
    expect(() =>
      aggregateNutrition({
        foods: [{ slug: "missing_food", grams: 100 }],
        foodRecords,
      }),
    ).toThrow(RangeError);
  });

  it("test_aggregateNutrition_negativeGrams_throwsRangeError", () => {
    expect(() =>
      aggregateNutrition({
        foods: [{ slug: "brown_rice", grams: -1 }],
        foodRecords,
      }),
    ).toThrow(RangeError);
  });
});
