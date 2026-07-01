import { describe, expect, test } from "vitest";

import {
  proposeDish,
  validateResolvedDish,
  userDishRowFromResolvedDish,
  type DishDraft,
} from "../../src/tools/add-dish.js";
import type { MealCatalog } from "../../src/tools/nutrition-estimate.js";
import type { NutritionRecord } from "../../src/engine/types.js";

const catalog: MealCatalog = {
  foods: [
    {
      slug: "beef_tenderloin",
      name: "Beef tenderloin",
      nameZh: "牛肉",
      aliases: ["beef", "牛里脊"],
      executionBuckets: ["red_meat"],
      roles: ["iron", "zinc", "b12"],
      weeklyFloor: 2,
      weightType: "raw",
      defaultGrams: null,
      defaultUnit: null,
      kcalPer100g: 107,
      proteinGramsPer100g: 22.2,
      carbsGramsPer100g: 2.4,
      fatGramsPer100g: 0.9,
      sodiumMgPer100g: 75,
    },
    {
      slug: "onion",
      name: "Onion",
      nameZh: "洋葱",
      aliases: ["洋葱"],
      executionBuckets: ["vegetable"],
      roles: [],
      weeklyFloor: 0,
      weightType: "raw",
      defaultGrams: null,
      defaultUnit: null,
      kcalPer100g: 40,
      proteinGramsPer100g: 1.1,
      carbsGramsPer100g: 9.3,
      fatGramsPer100g: 0.1,
      sodiumMgPer100g: 4,
    },
    {
      slug: "broccoli",
      name: "Broccoli",
      nameZh: "西兰花",
      aliases: ["broccoli", "西兰花"],
      executionBuckets: ["vegetable"],
      roles: [],
      weeklyFloor: 0,
      weightType: "raw",
      defaultGrams: null,
      defaultUnit: null,
      kcalPer100g: 35,
      proteinGramsPer100g: 2.4,
      carbsGramsPer100g: 7.2,
      fatGramsPer100g: 0.4,
      sodiumMgPer100g: 41,
    },
    {
      slug: "brown_rice",
      name: "Brown rice",
      aliases: ["rice"],
      executionBuckets: ["staple"],
      roles: [],
      weeklyFloor: 0,
      weightType: "dry",
      defaultGrams: null,
      defaultUnit: null,
      kcalPer100g: 348,
      proteinGramsPer100g: 7.7,
      carbsGramsPer100g: 75,
      fatGramsPer100g: 2.7,
      sodiumMgPer100g: 1,
    },
  ],
  naturalUnits: [],
};

const seasonings: NutritionRecord[] = [
  {
    slug: "light_soy_sauce",
    kcalPer100g: 50,
    proteinGramsPer100g: 5,
    carbsGramsPer100g: 5,
    fatGramsPer100g: 0,
    sodiumMgPer100g: 5757,
  },
];

const draft: DishDraft = {
  name: "洋葱炒牛肉",
  mealCategory: "main",
  ingredients: [
    { name: "beef", grams: 200 },
    { name: "洋葱", grams: 80 },
  ],
  seasonings: ["light_soy_sauce"],
  method: "stir_fry",
  source: "user_nl",
};

describe("add dish core", () => {
  test("proposeDish resolves slugs, computes nutrition, and derives buckets and roles", () => {
    const result = proposeDish({ draft }, { catalog, seasoningRecords: seasonings });

    expect(result).toMatchObject({
      slug: "洋葱炒牛肉",
      name: "洋葱炒牛肉",
      mealCategory: "main",
      ingredients: [
        { slug: "beef_tenderloin", grams: 200 },
        { slug: "onion", grams: 80 },
      ],
      seasonings: ["light_soy_sauce"],
      buckets: ["red_meat", "vegetable"],
      roles: ["b12", "iron", "zinc"],
      unresolved: [],
    });
    expect(result.nutrition.kcal).toBe(246);
    expect(result.nutrition.proteinGrams).toBe(45.3);
  });

  test("proposeDish reports unresolved ingredients without writing", () => {
    const result = proposeDish({
      draft: {
        ...draft,
        ingredients: [{ name: "mystery", grams: 100 }],
      },
    }, { catalog, seasoningRecords: seasonings });

    expect(result.unresolved).toEqual(["mystery"]);
    expect(result.ingredients).toEqual([]);
    expect(result.nutrition.kcal).toBe(0);
  });

  test("validateResolvedDish rejects unresolved ingredients, zero grams, and empty names", () => {
    const resolved = proposeDish({ draft }, { catalog, seasoningRecords: seasonings });

    expect(() => validateResolvedDish({ ...resolved, name: "" }, catalog)).toThrow(RangeError);
    expect(() => validateResolvedDish({ ...resolved, unresolved: ["mystery"] }, catalog)).toThrow(RangeError);
    expect(() =>
      validateResolvedDish({
        ...resolved,
        ingredients: [{ slug: "beef_tenderloin", grams: 0 }],
      }, catalog),
    ).toThrow(RangeError);
  });

  test("validateResolvedDish rejects main dishes that bundle staple ingredients", () => {
    const resolved = proposeDish({
      draft: {
        ...draft,
        ingredients: [
          ...draft.ingredients,
          { slug: "brown_rice", grams: 100 },
        ],
      },
    }, { catalog, seasoningRecords: seasonings });

    expect(() => validateResolvedDish(resolved, catalog)).toThrow("main dishes must not include staple ingredients");
  });

  test("side dishes resolve and persist role metadata", () => {
    const resolved = proposeDish({
      draft: {
        name: "Garlic broccoli",
        mealCategory: "main",
        role: "side",
        sideKind: "vegetable",
        ingredients: [{ slug: "broccoli", grams: 100 }],
        seasonings: ["light_soy_sauce"],
        method: "stir_fry",
        source: "user_nl",
      },
    }, { catalog, seasoningRecords: seasonings });

    expect(resolved).toMatchObject({
      slug: "garlic_broccoli",
      role: "side",
      sideKind: "vegetable",
      selfContained: false,
      nutrition: {
        kcal: 35,
        proteinGrams: 2.4,
      },
    });

    expect(userDishRowFromResolvedDish("user-id", resolved, catalog)).toMatchObject({
      role: "side",
      sideKind: "vegetable",
      selfContained: false,
    });
  });

  test("validateResolvedDish rejects protein ingredients in side dishes", () => {
    const resolved = proposeDish({
      draft: {
        name: "Beef side",
        mealCategory: "main",
        role: "side",
        sideKind: "vegetable",
        ingredients: [{ slug: "beef_tenderloin", grams: 100 }],
        seasonings: [],
        source: "user_nl",
      },
    }, { catalog, seasoningRecords: seasonings });

    expect(() => validateResolvedDish(resolved, catalog)).toThrow("side dishes must only include vegetable or soup ingredients");
  });

  test("userDishRowFromResolvedDish ignores caller supplied nutrition and uses resolved values", () => {
    const resolved = proposeDish({ draft }, { catalog, seasoningRecords: seasonings });
    const row = userDishRowFromResolvedDish("user-id", {
      ...resolved,
      nutrition: { kcal: 1, proteinGrams: 1, carbsGrams: 1, fatGrams: 1, sodiumMg: 1 },
    }, catalog);

    expect(row).toMatchObject({
      userId: "user-id",
      slug: "洋葱炒牛肉",
      mealCategory: "main",
      caloriesKcal: 246,
      proteinGrams: 45.3,
      source: "user_nl",
    });
  });
});
