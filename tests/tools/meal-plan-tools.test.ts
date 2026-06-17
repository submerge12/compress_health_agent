import { describe, expect, it } from "vitest";

import { generateMealPlan } from "../../src/tools/generate-meal-plan.js";
import { mealCheckin, rebalanceRemainingMealTargets } from "../../src/tools/meal-checkin.js";
import { recipeRecommend } from "../../src/tools/recipe-recommend.js";
import { updateCookingRecord, type CookingRecord } from "../../src/tools/update-cooking-record.js";
import type { MealPlanEntry } from "../../src/engine/meal-planner.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import type { DietLog, MealPlanEntryUpdate } from "../../src/tools/meal-checkin.js";

function makeDish(
  slug: string,
  mealType: "breakfast" | "lunch" | "dinner",
  kcal: number,
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
      proteinGrams: Math.round(kcal / 18),
      carbsGrams: Math.round(kcal / 7),
      fatGrams: Math.round(kcal / 32),
      sodiumMg: 280,
    },
    ingredients: [{ slug: ingredientSlug, grams: 150 }],
    seasonings: slug.includes("soy") ? ["light_soy_sauce"] : ["ginger"],
    source: "preset",
  };
}

const toolDishes: readonly RecipeDish[] = [
  makeDish("oat_egg_plate", "breakfast", 450, "oats"),
  makeDish("yogurt_fruit_bowl", "breakfast", 430, "yogurt"),
  makeDish("tofu_breakfast_hash", "breakfast", 470, "tofu"),
  makeDish("chicken_congee", "breakfast", 440, "chicken"),
  makeDish("turkey_rice_bowl", "lunch", 680, "turkey"),
  makeDish("salmon_potato_plate", "lunch", 660, "salmon"),
  makeDish("lentil_chicken_soup", "lunch", 640, "lentils"),
  makeDish("beef_barley_bowl", "lunch", 700, "beef"),
  makeDish("soy_tofu_noodle", "lunch", 650, "noodles"),
  makeDish("shrimp_quinoa_plate", "dinner", 650, "shrimp"),
  makeDish("cod_veg_rice", "dinner", 670, "cod"),
  makeDish("pork_squash_plate", "dinner", 620, "pork"),
  makeDish("bean_veg_chili", "dinner", 690, "beans"),
  makeDish("eggplant_chicken", "dinner", 640, "eggplant"),
];

describe("meal plan tools", () => {
  it("test_update_cooking_record_structures_note_and_inserts_when_store_provided", () => {
    const inserted: unknown[] = [];
    const result = updateCookingRecord({
      note: "garlic broccoli stir fry 180g with light soy sauce",
      recordedAt: "2026-06-16T12:00:00.000Z",
      store: {
        insertCookingRecord(record: CookingRecord) {
          inserted.push(record);
          return record;
        },
      },
    });

    expect(result.stored).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(result.record).toMatchObject({
      ingredientSlug: "broccoli",
      method: "stir_fry",
      seasonings: ["garlic", "light_soy_sauce"],
      portionG: 180,
      notes: "garlic broccoli stir fry 180g with light soy sauce",
    });
  });

  it("test_update_cooking_record_parses_chinese_gram_portion", () => {
    const result = updateCookingRecord({ note: "蒜 西兰花 炒 180克 生抽" });

    expect(result.record).toMatchObject({
      ingredientSlug: "broccoli",
      method: "stir_fry",
      seasonings: ["garlic", "light_soy_sauce"],
      portionG: 180,
    });
  });

  it("test_update_cooking_record_unknown_ingredient_throws_range_error", () => {
    expect(() => updateCookingRecord({ note: "mystery food grilled 120g" })).toThrow(RangeError);
  });

  it("test_recipe_recommend_returns_three_ranked_options_under_max_kcal_without_rejected_seasoning", () => {
    const result = recipeRecommend({
      mealType: "lunch",
      maxKcal: 700,
      candidates: toolDishes,
      preferences: { rejectedSeasonings: ["light_soy_sauce"] },
    });

    expect(result.options).toHaveLength(3);
    expect(result.options.every((option) => option.nutritionPreview.kcal <= 700)).toBe(true);
    expect(result.options.flatMap((option) => option.seasonings)).not.toContain("light_soy_sauce");
    expect(result.summary).toContain("Turkey Rice Bowl");
  });

  it("test_generate_meal_plan_stores_entries_and_returns_seven_day_overview", () => {
    const storedEntries: unknown[] = [];
    const result = generateMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      presetDishes: toolDishes,
      preferences: { rejectedSeasonings: ["light_soy_sauce"] },
      store: {
        insertMealPlanEntries(entries: readonly MealPlanEntry[]) {
          storedEntries.push(...entries);
          return entries;
        },
      },
    });

    expect(result.plan.entries).toHaveLength(21);
    expect(result.storedCount).toBe(21);
    expect(storedEntries).toHaveLength(21);
    expect(result.overview).toContain("Day 1 - 2026-06-16");
    expect(result.overview).toContain("breakfast:");
    expect(result.overview).toContain("kcal");
  });

  it("test_meal_checkin_followed_substituted_and_skipped_apply_expected_logs", () => {
    const planResult = generateMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      presetDishes: toolDishes,
    });
    const dietLogs: unknown[] = [];
    const planUpdates: unknown[] = [];
    const store = {
      insertDietLog(log: DietLog) {
        dietLogs.push(log);
        return log;
      },
      updateMealPlanEntry(update: MealPlanEntryUpdate) {
        planUpdates.push(update);
        return update;
      },
    };

    const followed = mealCheckin({
      plan: planResult.plan,
      date: "2026-06-16",
      mealType: "breakfast",
      status: "followed",
      store,
    });
    const substituted = mealCheckin({
      plan: planResult.plan,
      date: "2026-06-16",
      mealType: "lunch",
      status: "substituted",
      actualDescription: "restaurant chicken bowl",
      actualNutrition: { kcal: 800, proteinGrams: 45, carbsGrams: 82, fatGrams: 28, sodiumMg: 1200 },
      store,
    });
    const skipped = mealCheckin({
      plan: planResult.plan,
      date: "2026-06-16",
      mealType: "dinner",
      status: "skipped",
      store,
    });

    expect(followed.dietLog?.nutrition).toEqual(followed.entry.nutrition);
    expect(substituted.dietLog).toMatchObject({
      description: "restaurant chicken bowl",
      nutrition: { kcal: 800 },
    });
    expect(skipped.dietLog).toBeUndefined();
    expect(dietLogs).toHaveLength(2);
    expect(planUpdates).toHaveLength(3);
  });

  it("test_rebalance_remaining_meal_targets_spreads_deviation_across_remaining_meals", () => {
    const targets = rebalanceRemainingMealTargets({
      plannedConsumedKcal: 500,
      actualConsumedKcal: 800,
      remainingMeals: [{ mealType: "dinner", plannedKcal: 700 }],
    });

    expect(targets).toEqual([{ mealType: "dinner", targetKcal: 400 }]);
  });
});

function toTitleCase(part: string): string {
  return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}
