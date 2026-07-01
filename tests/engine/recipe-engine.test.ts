import { describe, expect, it } from "vitest";

import {
  recommendRecipes,
  type RecipeDish,
  type RecipeRecommendationRequest,
} from "../../src/engine/recipe-engine.js";

const candidates: readonly RecipeDish[] = [
  {
    slug: "garlic_broccoli",
    name: "Garlic broccoli",
    mealTypes: ["lunch", "dinner"],
    nutrition: { kcal: 250, proteinGrams: 10, carbsGrams: 24, fatGrams: 12, sodiumMg: 380 },
    ingredients: [{ slug: "broccoli", grams: 220 }],
    seasonings: ["garlic"],
    source: "preset",
    lastServedAt: "2026-06-14",
  },
  {
    slug: "scallion_beef",
    name: "Scallion beef",
    mealTypes: ["lunch", "dinner"],
    nutrition: { kcal: 510, proteinGrams: 32, carbsGrams: 15, fatGrams: 34, sodiumMg: 820 },
    ingredients: [{ slug: "beef", grams: 160 }],
    seasonings: ["scallion"],
    source: "preset",
    lastServedAt: "2026-06-15",
  },
  {
    slug: "chicken_rice_bowl",
    name: "Chicken rice bowl",
    mealTypes: ["lunch", "dinner"],
    nutrition: { kcal: 505, proteinGrams: 31, carbsGrams: 56, fatGrams: 14, sodiumMg: 520 },
    ingredients: [
      { slug: "chicken_breast", grams: 150 },
      { slug: "brown_rice", grams: 180 },
    ],
    seasonings: ["ginger"],
    source: "cooking_record",
    lastServedAt: null,
  },
  {
    slug: "tofu_mushroom_bowl",
    name: "Tofu mushroom bowl",
    mealTypes: ["lunch", "dinner"],
    nutrition: { kcal: 490, proteinGrams: 29, carbsGrams: 45, fatGrams: 18, sodiumMg: 460 },
    ingredients: [
      { slug: "tofu", grams: 220 },
      { slug: "mushroom", grams: 140 },
    ],
    seasonings: ["light_soy_sauce"],
    source: "preset",
  },
];

function makeRequest(overrides: Partial<RecipeRecommendationRequest> = {}): RecipeRecommendationRequest {
  return {
    candidates,
    mealType: "lunch",
    target: { kcal: 500, proteinGrams: 30 },
    recentDishSlugs: ["garlic_broccoli", "scallion_beef"],
    asOfDate: "2026-06-16",
    ...overrides,
  };
}

describe("recommendRecipes", () => {
  it("test_recommend_recipes_recent_history_penalized_prefers_fitting_alternative", () => {
    const recommendations = recommendRecipes(makeRequest());
    const top = recommendations[0];

    expect(recommendations).toHaveLength(4);
    expect(top).toBeDefined();
    if (top === undefined) throw new Error("expected at least one recommendation");
    expect(top.slug).toBe("chicken_rice_bowl");
    expect(top.slug).not.toBe("garlic_broccoli");
    expect(top.slug).not.toBe("scallion_beef");
    expect(top.nutritionPreview).toMatchObject({
      kcal: 505,
      proteinGrams: 31,
    });
  });

  it("test_recommend_recipes_rejected_seasoning_filters_candidates", () => {
    const recommendations = recommendRecipes(
      makeRequest({
        recentDishSlugs: [],
        preferences: { rejectedSeasonings: ["light_soy_sauce"] },
      }),
    );

    expect(recommendations.map((item) => item.slug)).not.toContain("tofu_mushroom_bowl");
    expect(recommendations.every((item) => !item.seasonings.includes("light_soy_sauce"))).toBe(true);
  });

  it("test_recommend_recipes_rejected_ingredient_filters_candidates", () => {
    const recommendations = recommendRecipes(
      makeRequest({
        recentDishSlugs: [],
        preferences: { rejectedIngredients: ["mushroom"] },
      }),
    );

    expect(recommendations.map((item) => item.slug)).not.toContain("tofu_mushroom_bowl");
    expect(
      recommendations.every((item) => !item.ingredients.some((ing) => ing.slug === "mushroom")),
    ).toBe(true);
  });

  it("test_recommend_recipes_exact_dislike_does_not_expand_to_allergen_group", () => {
    const recommendations = recommendRecipes(
      makeRequest({
        candidates: [
          {
            slug: "tofu_bowl",
            name: "Tofu bowl",
            mealTypes: ["lunch"],
            nutrition: { kcal: 500, proteinGrams: 32, carbsGrams: 40, fatGrams: 16, sodiumMg: 520 },
            ingredients: [{ slug: "tofu", grams: 220 }],
            seasonings: ["ginger"],
            source: "preset",
          },
          {
            slug: "soy_sauce_chicken",
            name: "Soy sauce chicken",
            mealTypes: ["lunch"],
            nutrition: { kcal: 500, proteinGrams: 32, carbsGrams: 40, fatGrams: 16, sodiumMg: 520 },
            ingredients: [{ slug: "chicken_breast", grams: 150 }],
            seasonings: ["light_soy_sauce"],
            source: "preset",
          },
        ],
        recentDishSlugs: [],
        preferences: { rejectedIngredients: ["tofu"] },
      }),
    );

    expect(recommendations.map((item) => item.slug)).toEqual(["soy_sauce_chicken"]);
  });

  it("test_recommend_recipes_allergen_group_filters_ingredient_and_hidden_seasoning_sources", () => {
    const recommendations = recommendRecipes(
      makeRequest({
        candidates: [
          {
            slug: "shrimp_salad",
            name: "Shrimp salad",
            mealTypes: ["lunch"],
            nutrition: { kcal: 500, proteinGrams: 32, carbsGrams: 40, fatGrams: 16, sodiumMg: 520 },
            ingredients: [{ slug: "shrimp_jiweixia", grams: 120 }],
            seasonings: ["aged_vinegar"],
            source: "preset",
          },
          {
            slug: "oyster_beef",
            name: "Oyster sauce beef",
            mealTypes: ["lunch"],
            nutrition: { kcal: 500, proteinGrams: 32, carbsGrams: 40, fatGrams: 16, sodiumMg: 520 },
            ingredients: [{ slug: "beef_tenderloin", grams: 150 }],
            seasonings: ["oyster_sauce"],
            source: "preset",
          },
          {
            slug: "ginger_chicken",
            name: "Ginger chicken",
            mealTypes: ["lunch"],
            nutrition: { kcal: 500, proteinGrams: 32, carbsGrams: 40, fatGrams: 16, sodiumMg: 520 },
            ingredients: [{ slug: "chicken_breast", grams: 150 }],
            seasonings: ["ginger"],
            source: "preset",
          },
        ],
        recentDishSlugs: [],
        preferences: { allergens: ["seafood"] },
      }),
    );

    expect(recommendations.map((item) => item.slug)).toEqual(["ginger_chicken"]);
  });

  it("test_recommend_recipes_preferred_seasoning_boosts_flavor_match", () => {
    const recommendations = recommendRecipes(
      makeRequest({
        preferences: { preferredSeasonings: ["light_soy_sauce"] },
      }),
    );

    expect(recommendations[0]?.slug).toBe("tofu_mushroom_bowl");
  });

  it("test_recommend_recipes_invalid_target_throws_range_error", () => {
    expect(() => recommendRecipes(makeRequest({ target: { kcal: 0, proteinGrams: 30 } }))).toThrow(
      RangeError,
    );
  });
});
