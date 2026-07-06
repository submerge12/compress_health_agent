import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  generateWeeklyMealPlan,
  MealPlanInfeasibleError,
  validateWeeklyMealPlan,
  type MealType,
} from "../../src/engine/meal-planner.js";
import { presetDishes } from "../../src/data/preset-dishes.js";
import { loadFoodItemsFromCsv } from "../../src/db/seed.js";
import {
  allergenTagsForFood,
  allergenTagsForSeasoning,
} from "../../src/engine/food-taxonomy.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import type { FoodCatalogRecord, MealCatalog } from "../../src/tools/nutrition-estimate.js";

let cachedCatalog: Promise<MealCatalog> | undefined;

function realCatalog(): Promise<MealCatalog> {
  cachedCatalog ??= (async () => {
    const foods = loadFoodItemsFromCsv(await readFile(path.resolve("seed/ingredients.csv"), "utf8"));
    return {
      foods: foods.map((food): FoodCatalogRecord => ({
        slug: food.slug,
        name: food.nameZh ?? food.name,
        weightType: food.weightType,
        defaultGrams: null,
        defaultUnit: null,
        kcalPer100g: food.caloriesKcal,
        proteinGramsPer100g: food.proteinGrams,
        carbsGramsPer100g: food.carbsGrams,
        fatGramsPer100g: food.fatGrams,
        sodiumMgPer100g: food.sodiumMg,
      })),
      naturalUnits: [],
    };
  })();
  return cachedCatalog;
}

const mealTypes: readonly MealType[] = ["breakfast", "lunch", "dinner"];

function dish(
  slug: string,
  mealType: MealType,
  kcal: number,
  proteinGrams: number,
  ingredientSlug: string,
): RecipeDish {
  return {
    slug,
    name: slug
      .split("_")
      .map(toTitleCase)
      .join(" "),
    mealTypes: [mealType],
    nutrition: {
      kcal,
      proteinGrams,
      carbsGrams: Math.round(kcal / 8),
      fatGrams: Math.round(kcal / 30),
      sodiumMg: 300,
    },
    ingredients: [{ slug: ingredientSlug, grams: 150 }],
    seasonings: slug.includes("soy") ? ["light_soy_sauce"] : ["ginger"],
    source: "preset",
  };
}

const planCandidates: readonly RecipeDish[] = [
  dish("oat_egg_plate", "breakfast", 450, 24, "oats"),
  dish("yogurt_fruit_bowl", "breakfast", 430, 22, "yogurt"),
  dish("tofu_breakfast_hash", "breakfast", 470, 26, "tofu"),
  dish("chicken_congee", "breakfast", 440, 28, "chicken"),
  dish("turkey_rice_bowl", "lunch", 680, 42, "turkey"),
  dish("salmon_potato_plate", "lunch", 660, 39, "salmon"),
  dish("lentil_chicken_soup", "lunch", 640, 37, "lentils"),
  dish("beef_barley_bowl", "lunch", 700, 41, "beef"),
  dish("soy_tofu_noodle", "lunch", 650, 31, "noodles"),
  dish("shrimp_quinoa_plate", "dinner", 650, 40, "shrimp"),
  dish("cod_veg_rice", "dinner", 670, 38, "cod"),
  dish("pork_squash_plate", "dinner", 620, 36, "pork"),
  dish("bean_veg_chili", "dinner", 690, 34, "beans"),
  dish("eggplant_chicken", "dinner", 640, 37, "eggplant"),
];

describe("generateWeeklyMealPlan", () => {
  it("test_generate_weekly_meal_plan_enough_candidates_satisfies_constraints", () => {
    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      presetDishes: planCandidates,
      preferences: { rejectedSeasonings: ["light_soy_sauce"] },
    });
    const validation = validateWeeklyMealPlan(plan, {
      dailyKcalTarget: 1800,
      minimumDistinctDishes: 12,
    });

    expect(plan.entries).toHaveLength(21);
    expect(plan.days).toHaveLength(7);
    expect(plan.distinctDishCount).toBeGreaterThanOrEqual(12);
    expect(validation.ok).toBe(true);
    expect(validation.violations).toEqual([]);
    expect(plan.entries.every((entry) => !entry.dish.seasonings.includes("light_soy_sauce"))).toBe(
      true,
    );
  });

  it("test_generate_weekly_meal_plan_limited_candidates_allows_lower_variety", () => {
    const limitedCandidates = mealTypes.map((mealType, index) =>
      dish(`${mealType}_staple`, mealType, index === 0 ? 450 : 675, 25 + index, `${mealType}_base`),
    );

    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      presetDishes: limitedCandidates,
    });
    const validation = validateWeeklyMealPlan(plan, { dailyKcalTarget: 1800 });

    expect(plan.entries).toHaveLength(21);
    expect(plan.distinctDishCount).toBe(3);
    expect(validation.ok).toBe(true);
  });

  it("test_generate_weekly_meal_plan_rotation_blocks_kcal_infeasible_pools_instead_of_gaming_variety", () => {
    // v2 semantics: rotation uses the whole pool by rule. A pool whose members
    // cannot compose in-band days (no catalog, so no staple lever) must
    // block-and-explain rather than silently repeat the few feasible dishes —
    // pool quality is pool-selection's job, not the fill's.
    const kcalSensitiveCandidates: readonly RecipeDish[] = [
      dish("steady_oat_plate", "breakfast", 450, 24, "steady_oats"),
      dish("steady_lunch_bowl", "lunch", 675, 40, "steady_lunch"),
      dish("low_lunch_variety", "lunch", 200, 10, "low_lunch"),
      dish("steady_dinner_plate", "dinner", 675, 40, "steady_dinner"),
      dish("low_dinner_variety", "dinner", 200, 10, "low_dinner"),
    ];

    expect(() =>
      generateWeeklyMealPlan({
        startDate: "2026-06-16",
        dailyKcalTarget: 1800,
        presetDishes: kcalSensitiveCandidates,
      })
    ).toThrow(MealPlanInfeasibleError);

    // The same request with a kcal-coherent pool plans exact days by rule.
    const plan = generateWeeklyMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      presetDishes: [
        dish("steady_oat_plate", "breakfast", 450, 24, "steady_oats"),
        dish("steady_lunch_bowl", "lunch", 675, 40, "steady_lunch"),
        dish("steady_dinner_plate", "dinner", 675, 40, "steady_dinner"),
      ],
    });
    expect(plan.days.map((day) => day.totals.kcal)).toEqual([1800, 1800, 1800, 1800, 1800, 1800, 1800]);
  });

  it("test_generate_weekly_meal_plan_no_usable_candidates_blocks_with_explanation", () => {
    expect(() =>
      generateWeeklyMealPlan({
        startDate: "2026-06-16",
        dailyKcalTarget: 1800,
        presetDishes: [dish("soy_only_bowl", "lunch", 600, 30, "tofu")],
        preferences: { rejectedSeasonings: ["light_soy_sauce"] },
      }),
    ).toThrow(MealPlanInfeasibleError);

    try {
      generateWeeklyMealPlan({
        startDate: "2026-06-16",
        dailyKcalTarget: 1800,
        presetDishes: [dish("soy_only_bowl", "lunch", 600, 30, "tofu")],
        preferences: { rejectedSeasonings: ["light_soy_sauce"] },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MealPlanInfeasibleError);
      expect((error as MealPlanInfeasibleError).result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "safety_filter", target: 1 }),
        ]),
      );
    }
  });

  it("test_generate_weekly_meal_plan_seafood_allergy_meets_high_protein_floor_with_real_presets", async () => {
    // v2: the protein floor is met by levers (top-ups + staple), which need
    // the real catalog; without one there is nothing to lever with.
    const plan = generateWeeklyMealPlan({
      startDate: "2026-07-06",
      dailyKcalTarget: 1771,
      dailyProteinTarget: 140,
      presetDishes,
      catalog: await realCatalog(),
      preferences: { allergens: ["seafood"] },
    });
    const validation = validateWeeklyMealPlan(plan, {
      dailyKcalTarget: 1771,
      dailyProteinTarget: 140,
    });

    expect(validation.ok).toBe(true);
    expect(validation.violations).toEqual([]);
    expect(plan.days.every((day) => day.totals.proteinGrams >= 112)).toBe(true);
    expect(plan.entries.flatMap((entry) => [entry.dish, entry.side].filter(isDish)).every((dish) =>
      !containsSeafood(dish)
    )).toBe(true);
  });
});

function toTitleCase(part: string): string {
  return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}

function isDish(value: RecipeDish | undefined): value is RecipeDish {
  return value !== undefined;
}

function containsSeafood(dish: RecipeDish): boolean {
  return dish.ingredients.some((ingredient) =>
    allergenTagsForFood(ingredient.slug, undefined).some(isSeafoodTag)
  ) || dish.seasonings.some((seasoning) =>
    allergenTagsForSeasoning(seasoning).some(isSeafoodTag)
  ) || (dish.allergenTags ?? []).some(isSeafoodTag);
}

function isSeafoodTag(tag: string): boolean {
  return tag === "seafood" || tag === "fish" || tag === "shellfish" || tag === "shrimp";
}
