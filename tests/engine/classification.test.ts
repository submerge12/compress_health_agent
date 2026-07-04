import { describe, expect, test } from "vitest";

import { dishBucketsRoles } from "../../src/engine/classification.js";
import { filterUsableCandidates } from "../../src/engine/meal-planner.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import { loadFoodItemsFromCsv } from "../../src/db/seed.js";
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
      allergenTags: [],
      specialHandlingTags: [],
      frequencyHints: {},
      cookingDifficulties: [],
      availabilityTags: [],
    });
  });

  test("derives allergen and special handling tags from ingredients and hidden seasoning sources", () => {
    const result = dishBucketsRoles(
      {
        ...dish([
          { slug: "shrimp_jiweixia", grams: 80 },
          { slug: "konjac", grams: 120 },
          { slug: "chicken_liver", grams: 60 },
        ]),
        seasonings: ["oyster_sauce", "light_soy_sauce"],
      },
      {
        foods: [
          food({
            slug: "shrimp_jiweixia",
            executionBuckets: ["shellfish"],
            allergenTags: ["seafood", "shellfish", "shrimp"],
            roles: ["b12"],
            weeklyFloor: 1,
          }),
          food({
            slug: "konjac",
            executionBuckets: ["filler"],
            specialHandlingTags: ["filler", "not_vegetable"],
            roles: [],
            weeklyFloor: 0,
          }),
          food({
            slug: "chicken_liver",
            executionBuckets: ["organ_meat"],
            roles: ["iron", "b12", "vitamin_a"],
            weeklyFloor: 0,
            frequencyHint: "weekly",
            specialHandlingTags: ["weekly_frequency"],
          }),
        ],
        naturalUnits: [],
      },
    );

    expect(result).toEqual({
      buckets: ["filler", "organ_meat", "shellfish"],
      roles: ["b12", "iron", "vitamin_a"],
      weeklyFloors: { shellfish: 1 },
      allergenTags: ["seafood", "shellfish", "shrimp", "soy"],
      specialHandlingTags: ["filler", "hidden_allergen", "not_vegetable", "weekly_frequency"],
      frequencyHints: { chicken_liver: "weekly" },
      cookingDifficulties: [],
      availabilityTags: [],
    });
  });

  test("library seafood allergen tags exclude user dishes for seafood allergy", () => {
    const [libraryShrimp] = loadFoodItemsFromCsv([
      "slug,name_zh,name_en,category_code,category_zh,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg",
      "xlsx_library_shrimp,\u57fa\u56f4\u867e,Shrimp,122,\u867e,100,18,1,1,170",
    ].join("\n"));
    if (libraryShrimp === undefined) {
      throw new Error("Expected library shrimp seed row.");
    }
    const candidate = dish([{ slug: "xlsx_library_shrimp", grams: 120 }]);
    const classification = dishBucketsRoles(candidate, {
      foods: [
        food({
          slug: libraryShrimp.slug,
          name: libraryShrimp.name,
          category: libraryShrimp.category,
          allergenTags: libraryShrimp.allergenTags,
        }),
      ],
      naturalUnits: [],
    });
    const classifiedCandidate: RecipeDish = {
      ...candidate,
      allergenTags: classification.allergenTags,
    };

    expect(classification.allergenTags).toEqual(["seafood", "shellfish", "shrimp"]);
    expect(filterUsableCandidates([classifiedCandidate], { allergens: ["seafood"] })).toEqual([]);
  });
});
