import { describe, expect, test } from "vitest";

import { selectWeeklyPool } from "../../src/engine/pool-selection.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import type { FoodCatalogRecord, MealCatalog } from "../../src/tools/nutrition-estimate.js";

describe("selectWeeklyPool fat-budget lean tilt", () => {
  test("picks the leanest weekly-floor carrier under a fat budget", () => {
    const result = selectWeeklyPool({
      candidates: [
        ...baseBreakfasts(),
        main("fatty_beef_stirfry", 25, { buckets: ["red_meat"] }),
        main("lean_beef_soup", 5, { buckets: ["red_meat"] }),
        main("chicken_a", 12),
        main("chicken_b", 14),
        main("tofu_a", 10),
        main("tofu_b", 11),
        main("fish_a", 8),
        main("fish_b", 9),
        ...baseSides(),
      ],
      weeklyFloors: { red_meat: 1 },
      fatBudget: { dailyTargetGrams: 49 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    const mainSlugs = result.pool.mains.map((dish) => dish.slug);
    expect(mainSlugs).toContain("lean_beef_soup");
    expect(mainSlugs).not.toContain("fatty_beef_stirfry");
  });

  test("fills remaining slots leanest-first when no preferences apply", () => {
    const result = selectWeeklyPool({
      candidates: [
        ...baseBreakfasts(),
        main("m_25", 25),
        main("m_5", 5),
        main("m_18", 18),
        main("m_8", 8),
        main("m_12", 12),
        main("m_15", 15),
        ...baseSides(),
      ],
      fatBudget: { dailyTargetGrams: 49 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    // Pool fills toward the 7-main rotation target; all 6 candidates enter,
    // ordered lean-first.
    expect(result.pool.mains.map((dish) => dish.slug)).toEqual([
      "m_5", "m_8", "m_12", "m_15", "m_18", "m_25",
    ]);
  });

  test("preference rank still beats leanness for fill slots", () => {
    const result = selectWeeklyPool({
      candidates: [
        ...baseBreakfasts(),
        { ...main("preferred_fatty", 22), ingredients: [{ slug: "chicken_thigh", grams: 150 }] },
        main("lean_a", 5),
        main("lean_b", 6),
        main("lean_c", 7),
        main("lean_d", 8),
        main("lean_e", 9),
        ...baseSides(),
      ],
      preferences: { preferredIngredients: ["chicken_thigh"] },
      fatBudget: { dailyTargetGrams: 49 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.mains[0]?.slug).toBe("preferred_fatty");
  });

  test("uses ingredient-computed fat (explicit oil grams) over the stored block when a catalog is given", () => {
    // Stored block claims 3 g fat, but the ingredients carry 20 g of oil.
    const oilyButStoredLean: RecipeDish = {
      ...main("oily_stored_lean", 3),
      ingredients: [
        { slug: "chicken_breast", grams: 150 },
        { slug: "olive_oil", grams: 20 },
      ],
    };
    const honest: RecipeDish = {
      ...main("honest_mid", 12),
      ingredients: [
        { slug: "chicken_breast", grams: 150 },
        { slug: "olive_oil", grams: 5 },
      ],
    };
    const result = selectWeeklyPool({
      candidates: [
        ...baseBreakfasts(),
        oilyButStoredLean,
        honest,
        oilyMain("filler_a", 30),
        oilyMain("filler_b", 31),
        oilyMain("filler_c", 32),
        oilyMain("filler_d", 33),
        ...baseSides(),
      ],
      minimumCounts: { breakfasts: 3, mains: 2, sides: 3 },
      fatBudget: { dailyTargetGrams: 49, catalog: syntheticCatalog() },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    // Computed: honest ~9.9 g < oily ~22.7 g, despite stored 12 vs 3.
    expect(result.pool.mains[0]?.slug).toBe("honest_mid");
  });

  test("attaches a pool notice (never a block) when even the leanest week exceeds the budget", () => {
    const result = selectWeeklyPool({
      candidates: [
        ...baseBreakfasts(),
        main("m_a", 30),
        main("m_b", 32),
        main("m_c", 34),
        main("m_d", 36),
        main("m_e", 38),
        ...baseSides(),
      ],
      fatBudget: { dailyTargetGrams: 20 },
    });

    // Weekly fat budgets are reporting, not a hard gate (V2-P1).
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.fatBudgetNotice).toContain("fat budget");
    expect(result.pool.fatBudgetNotice).toContain("清蒸");
  });

  test("no notice when the pool comfortably fits the budget", () => {
    const result = selectWeeklyPool({
      candidates: [
        ...baseBreakfasts(),
        main("m_5", 5),
        main("m_6", 6),
        main("m_7", 7),
        main("m_8", 8),
        main("m_9", 9),
        ...baseSides(),
      ],
      fatBudget: { dailyTargetGrams: 49 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.fatBudgetNotice).toBeUndefined();
  });

  test("without a fat budget the original selection order is preserved", () => {
    const result = selectWeeklyPool({
      candidates: [
        ...baseBreakfasts(),
        main("first", 25),
        main("second", 5),
        main("third", 18),
        main("fourth", 8),
        main("fifth", 12),
        ...baseSides(),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.mains.map((dish) => dish.slug)).toEqual([
      "first", "second", "third", "fourth", "fifth",
    ]);
  });
});

function oilyMain(slug: string, fatGrams: number): RecipeDish {
  return {
    ...main(slug, fatGrams),
    ingredients: [
      { slug: "chicken_breast", grams: 150 },
      { slug: "olive_oil", grams: 25 },
    ],
  };
}

function main(slug: string, fatGrams: number, options: Partial<RecipeDish> = {}): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes: ["lunch", "dinner"],
    role: "main",
    selfContained: true,
    nutrition: { kcal: 500, proteinGrams: 35, carbsGrams: 40, fatGrams, sodiumMg: 500 },
    ingredients: [{ slug: "chicken_breast", grams: 150 }],
    seasonings: [],
    source: "preset",
    ...options,
  };
}

function baseBreakfasts(): RecipeDish[] {
  return ["breakfast_a", "breakfast_b", "breakfast_c"].map((slug) => ({
    slug,
    name: slug,
    mealTypes: ["breakfast"] as const,
    nutrition: { kcal: 450, proteinGrams: 25, carbsGrams: 50, fatGrams: 12, sodiumMg: 200 },
    ingredients: [{ slug: "egg", grams: 100 }],
    seasonings: [],
    source: "preset" as const,
  }));
}

function baseSides(): RecipeDish[] {
  return ["side_a", "side_b", "side_c"].map((slug) => ({
    slug,
    name: slug,
    mealTypes: ["lunch", "dinner"] as const,
    role: "side" as const,
    sideKind: "vegetable" as const,
    nutrition: { kcal: 25, proteinGrams: 2, carbsGrams: 3, fatGrams: 1, sodiumMg: 50 },
    ingredients: [{ slug: "broccoli", grams: 100 }],
    seasonings: [],
    source: "preset" as const,
  }));
}

function syntheticCatalog(): MealCatalog {
  const record = (slug: string, values: Partial<FoodCatalogRecord>): FoodCatalogRecord => ({
    slug,
    weightType: "raw",
    defaultGrams: null,
    defaultUnit: null,
    kcalPer100g: 100,
    proteinGramsPer100g: 10,
    carbsGramsPer100g: 5,
    fatGramsPer100g: 5,
    sodiumMgPer100g: 50,
    ...values,
  });
  return {
    foods: [
      record("chicken_breast", { kcalPer100g: 118, proteinGramsPer100g: 19.4, fatGramsPer100g: 5, carbsGramsPer100g: 2.5, sodiumMgPer100g: 34.4 }),
      record("olive_oil", { kcalPer100g: 884, proteinGramsPer100g: 0, fatGramsPer100g: 99.9, carbsGramsPer100g: 0, sodiumMgPer100g: 2 }),
      record("egg", { kcalPer100g: 139, proteinGramsPer100g: 13.1, fatGramsPer100g: 8.6, carbsGramsPer100g: 2.4, sodiumMgPer100g: 131.5 }),
      record("broccoli", { kcalPer100g: 27, proteinGramsPer100g: 3.5, fatGramsPer100g: 0.6, carbsGramsPer100g: 3.7, sodiumMgPer100g: 46.7 }),
    ],
    naturalUnits: [],
  };
}
