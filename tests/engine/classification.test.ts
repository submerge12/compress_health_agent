import { describe, expect, test } from "vitest";

import { dishBucketsRoles } from "../../src/engine/classification.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import type { FoodCatalogRecord } from "../../src/tools/nutrition-estimate.js";

function food(overrides: Partial<FoodCatalogRecord> & Pick<FoodCatalogRecord, "slug">): FoodCatalogRecord {
  return {
    name: overrides.slug,
    defaultGrams: null,
    defaultUnit: null,
    kcalPer100g: 100,
    proteinGramsPer100g: 10,
    carbsGramsPer100g: 5,
    fatGramsPer100g: 2,
    sodiumMgPer100g: 20,
    ...overrides,
  };
}

function dish(ingredients: RecipeDish["ingredients"]): RecipeDish {
  return {
    slug: "scallion_beef",
    name: "Scallion beef",
    mealTypes: ["lunch", "dinner"],
    nutrition: { kcal: 680, proteinGrams: 40, carbsGrams: 60, fatGrams: 22, sodiumMg: 600 },
    ingredients,
    seasonings: [],
    source: "preset",
  };
}

describe("dishBucketsRoles", () => {
  test("derives dish buckets, roles, and weekly floors from ingredient classification", () => {
    const result = dishBucketsRoles(
      dish([
        { slug: "beef_tenderloin", grams: 150 },
        { slug: "brown_rice", grams: 100 },
      ]),
      {
        foods: [
          food({
            slug: "beef_tenderloin",
            executionBuckets: ["red_meat"],
            roles: ["iron", "zinc", "b12"],
            weeklyFloor: 2,
          }),
          food({
            slug: "brown_rice",
            executionBuckets: ["staple"],
            roles: [],
            weeklyFloor: 0,
          }),
        ],
        naturalUnits: [],
      },
    );

    expect(result).toEqual({
      buckets: ["red_meat", "staple"],
      roles: ["b12", "iron", "zinc"],
      weeklyFloors: { red_meat: 2 },
    });
  });
});
