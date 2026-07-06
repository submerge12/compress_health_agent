import { describe, expect, test } from "vitest";

import { selectWeeklyPool } from "../../src/engine/pool-selection.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";

describe("selectWeeklyPool", () => {
  test("excludes seafood-allergy fixtures at pool selection time", () => {
    const result = selectWeeklyPool({
      candidates: [
        dish("oat_egg_plate", ["breakfast"], 430, 24, "egg"),
        dish("chicken_bowl", ["lunch", "dinner"], 620, 42, "chicken_breast"),
        dish("shrimp_bowl", ["lunch", "dinner"], 610, 46, "shrimp_jiweixia"),
        {
          ...dish("oyster_sauce_beef", ["lunch", "dinner"], 650, 40, "beef_tenderloin"),
          seasonings: ["oyster_sauce"],
        },
      ],
      preferences: { allergens: ["seafood"] },
      minimumCounts: { breakfasts: 1, mains: 1, sides: 0 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.all.map((item) => item.slug)).toEqual(["oat_egg_plate", "chicken_bowl"]);
  });

  test("meets weekly-floor quotas in the selected main pool", () => {
    const result = selectWeeklyPool({
      candidates: [
        dish("oat_egg_plate", ["breakfast"], 430, 24, "egg"),
        dish("chicken_bowl", ["lunch", "dinner"], 620, 42, "chicken_breast"),
        dish("tofu_bowl", ["lunch", "dinner"], 590, 34, "tofu"),
        dish("pork_bowl", ["lunch", "dinner"], 640, 35, "pork"),
        dish("beef_bowl_a", ["lunch", "dinner"], 650, 41, "beef", { buckets: ["red_meat"] }),
        dish("beef_bowl_b", ["lunch", "dinner"], 635, 39, "beef", { buckets: ["red_meat"] }),
        dish("cod_plate_a", ["lunch", "dinner"], 610, 38, "cod", { buckets: ["deep_sea_fish"] }),
        dish("cod_plate_b", ["lunch", "dinner"], 625, 40, "cod", { buckets: ["deep_sea_fish"] }),
      ],
      minimumCounts: { breakfasts: 1, mains: 5, sides: 0 },
      weeklyFloors: { red_meat: 2, deep_sea_fish: 2 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(countBucket(result.pool.mains, "red_meat")).toBeGreaterThanOrEqual(2);
    expect(countBucket(result.pool.mains, "deep_sea_fish")).toBeGreaterThanOrEqual(2);
  });

  test("fails fast when the candidate set genuinely cannot meet weekly-floor quotas", () => {
    // No candidate carries the shellfish bucket at all (true pool thinness,
    // not a safety exclusion) - this must still block.
    const result = selectWeeklyPool({
      candidates: [
        dish("oat_egg_plate", ["breakfast"], 430, 24, "egg"),
        dish("beef_bowl", ["lunch", "dinner"], 650, 41, "beef", { buckets: ["red_meat"] }),
        dish("chicken_bowl", ["lunch", "dinner"], 620, 42, "chicken_breast"),
      ],
      minimumCounts: { breakfasts: 1, mains: 2, sides: 0 },
      weeklyFloors: { shellfish: 1 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("quota-deficient pool unexpectedly selected");
    expect(result.cannotSatisfy.reason).toContain("weekly floor");
    expect(result.cannotSatisfy.reason).toContain("shellfish");
    expect(result.cannotSatisfy.suggestions.join(" ")).toContain("safe");
  });

  test("waives weekly floors whose entire bucket is excluded by safety filters", () => {
    // The only shellfish carrier is removed by the seafood allergy: the floor
    // must be waived (never blocking an allergic user), not reported as a deficit.
    const result = selectWeeklyPool({
      candidates: [
        dish("oat_egg_plate", ["breakfast"], 430, 24, "egg"),
        dish("beef_bowl", ["lunch", "dinner"], 650, 41, "beef", { buckets: ["red_meat"] }),
        dish("chicken_bowl", ["lunch", "dinner"], 620, 42, "chicken_breast"),
        dish("shrimp_bowl", ["lunch", "dinner"], 610, 46, "shrimp_jiweixia", {
          buckets: ["shellfish"],
        }),
      ],
      preferences: { allergens: ["seafood"] },
      minimumCounts: { breakfasts: 1, mains: 2, sides: 0 },
      weeklyFloors: { shellfish: 1, red_meat: 1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.mains.map((item) => item.slug)).not.toContain("shrimp_bowl");
    expect(result.pool.waivedFloors).toEqual([
      expect.objectContaining({ bucket: "shellfish", floor: 1 }),
    ]);
    expect(countBucket(result.pool.mains, "red_meat")).toBeGreaterThanOrEqual(1);
  });

  test("credits staple and top-up levers before declaring protein infeasible", () => {
    // Dish-only strongest day is 111g vs a 112g floor - exactly the regression
    // case. With lever credits the pool must NOT block.
    const candidates = [
      dish("strong_breakfast", ["breakfast"], 450, 28, "egg"),
      dish("strong_main_a", ["lunch", "dinner"], 660, 42, "chicken_breast"),
      dish("strong_main_b", ["lunch", "dinner"], 655, 41, "beef"),
    ];
    const withoutCredits = selectWeeklyPool({
      candidates,
      minimumCounts: { breakfasts: 1, mains: 2, sides: 0 },
      proteinFloor: { dailyTargetGrams: 140 },
    });
    expect(withoutCredits.ok).toBe(false);

    const withStapleCredit = selectWeeklyPool({
      candidates,
      minimumCounts: { breakfasts: 1, mains: 2, sides: 0 },
      proteinFloor: { dailyTargetGrams: 140, stapleProteinHeadroomGrams: 2 },
    });
    expect(withStapleCredit.ok).toBe(true);

    const withTopUpCredit = selectWeeklyPool({
      candidates,
      minimumCounts: { breakfasts: 1, mains: 2, sides: 0 },
      proteinFloor: {
        dailyTargetGrams: 140,
        catalog: {
          foods: [
            { slug: "egg", name: "egg", weightType: "raw", kcalPer100g: 144, proteinGramsPer100g: 13, carbsGramsPer100g: 1.4, fatGramsPer100g: 9.5, sodiumMgPer100g: 130 },
            { slug: "tofu", name: "tofu", weightType: "raw", kcalPer100g: 84, proteinGramsPer100g: 8.1, carbsGramsPer100g: 3.8, fatGramsPer100g: 4.6, sodiumMgPer100g: 7 },
            { slug: "soy_milk", name: "soy milk", weightType: "raw", kcalPer100g: 31, proteinGramsPer100g: 3, carbsGramsPer100g: 1.2, fatGramsPer100g: 1.6, sodiumMgPer100g: 3 },
          ],
          naturalUnits: [],
        },
      },
    });
    expect(withTopUpCredit.ok).toBe(true);
  });

  test("fails fast when allergen filtering leaves fewer role candidates than minimum counts", () => {
    const result = selectWeeklyPool({
      candidates: [
        dish("shrimp_breakfast", ["breakfast"], 430, 24, "shrimp_jiweixia"),
        dish("chicken_bowl", ["lunch", "dinner"], 620, 42, "chicken_breast"),
      ],
      preferences: { allergens: ["seafood"] },
      minimumCounts: { breakfasts: 1, mains: 2, sides: 0 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("undersized pool unexpectedly selected");
    expect(result.cannotSatisfy.reason).toContain("minimum");
    expect(result.cannotSatisfy.reason).toContain("breakfast");
    expect(result.cannotSatisfy.reason).toContain("main");
    expect(result.cannotSatisfy.suggestions.join(" ")).toContain("safe");
  });

  test("fails fast with cannotSatisfy when protein-thin candidates cannot satisfy targets", () => {
    const result = selectWeeklyPool({
      candidates: [
        dish("plain_congee", ["breakfast"], 420, 8, "rice"),
        dish("noodle_bowl", ["lunch", "dinner"], 610, 16, "noodles"),
        dish("vegetable_rice", ["lunch", "dinner"], 590, 14, "bok_choy"),
      ],
      minimumCounts: { breakfasts: 1, mains: 2, sides: 0 },
      proteinFloor: { dailyTargetGrams: 140 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("protein-thin pool unexpectedly selected");
    expect(result.cannotSatisfy.reason).toContain("protein");
    expect(result.cannotSatisfy.suggestions.join(" ")).toContain("lean protein");
  });

  test("pulls preferred mains into a limited pool before neutral filler", () => {
    const result = selectWeeklyPool({
      candidates: [
        dish("oat_egg_plate", ["breakfast"], 430, 24, "egg"),
        dish("neutral_noodle", ["lunch", "dinner"], 610, 32, "noodles"),
        dish("neutral_rice", ["lunch", "dinner"], 590, 31, "rice"),
        dish("preferred_chicken", ["lunch", "dinner"], 620, 42, "chicken_breast"),
      ],
      preferences: { preferredIngredients: ["chicken_breast"] },
      minimumCounts: { breakfasts: 1, mains: 2, sides: 0 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.mains.map((item) => item.slug)).toContain("preferred_chicken");
  });
});

function dish(
  slug: string,
  mealTypes: RecipeDish["mealTypes"],
  kcal: number,
  proteinGrams: number,
  ingredientSlug = slug,
  options: Partial<RecipeDish> = {},
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
    },
    ingredients: [{ slug: ingredientSlug, grams: 120 }],
    seasonings: [],
    source: "preset",
    ...options,
  };
}

function countBucket(dishes: readonly RecipeDish[], bucket: string): number {
  return dishes.filter((item) => item.buckets?.includes(bucket)).length;
}
