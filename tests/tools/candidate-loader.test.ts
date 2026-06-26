import { describe, expect, test } from "vitest";

import { presetDishes } from "../../src/data/preset-dishes.js";
import type { UserDishRow } from "../../src/db/repository.js";
import type { ToolContext } from "../../src/tools/context.js";
import { loadCandidateDishes } from "../../src/tools/candidate-loader.js";

function userDish(overrides: Partial<UserDishRow>): UserDishRow {
  return {
    id: "dish-id",
    userId: "user-id",
    slug: "user_beef_bowl",
    name: "User beef bowl",
    mealCategory: "main",
    ingredientsJson: [{ slug: "beef_tenderloin", grams: 150 }],
    seasoningsJson: [{ slug: "light_soy_sauce" }],
    method: "stir_fry",
    caloriesKcal: 680,
    proteinGrams: 42,
    carbsGrams: 62,
    fatGrams: 20,
    sodiumMg: 640,
    source: "user",
    ...overrides,
  };
}

function makeContext(userDishes: UserDishRow[]): ToolContext {
  return {
    userId: "user-id",
    locale: "zh",
    catalog: { foods: [], naturalUnits: [] },
    seasoningRecords: [],
    repo: {
      listUserDishes: async (userId: string) => {
        expect(userId).toBe("user-id");
        return userDishes;
      },
      listCookingRecords: async () => {
        throw new Error("loadCandidateDishes must not read cooking_records");
      },
    } as unknown as ToolContext["repo"],
    close: async () => undefined,
  };
}

describe("loadCandidateDishes", () => {
  test("returns exactly the 14 curated presets when user_dishes is empty", async () => {
    const candidates = await loadCandidateDishes(makeContext([]));

    expect(candidates).toHaveLength(14);
    expect(candidates.map((dish) => dish.slug)).toEqual(presetDishes.map((dish) => dish.slug));
    expect(candidates[0]).toMatchObject(presetDishes[0]!);
    expect(candidates[0]).toMatchObject({ buckets: [], roles: [], weeklyFloors: {} });
  });

  test("maps user_dishes meal_category to planner mealTypes", async () => {
    const candidates = await loadCandidateDishes(makeContext([
      userDish({ mealCategory: "main" }),
      userDish({
        id: "breakfast-id",
        slug: "user_oat_bowl",
        name: "User oat bowl",
        mealCategory: "breakfast",
        caloriesKcal: 430,
        proteinGrams: 24,
      }),
    ]));

    expect(candidates.find((dish) => dish.slug === "user_beef_bowl")).toMatchObject({
      mealTypes: ["lunch", "dinner"],
      source: "user",
    });
    expect(candidates.find((dish) => dish.slug === "user_oat_bowl")).toMatchObject({
      mealTypes: ["breakfast"],
      source: "user",
    });
  });

  test("dedupes user_dishes by preset slug and filters invalid nutrition", async () => {
    const candidates = await loadCandidateDishes(makeContext([
      userDish({ slug: presetDishes[0]!.slug, name: "Duplicate preset" }),
      userDish({ slug: "zero_kcal", name: "Zero kcal", caloriesKcal: 0 }),
      userDish({ slug: "valid_extra", name: "Valid extra" }),
    ]));

    expect(candidates.map((dish) => dish.slug)).not.toContain("zero_kcal");
    expect(candidates.filter((dish) => dish.slug === presetDishes[0]!.slug)).toHaveLength(1);
    expect(candidates.map((dish) => dish.slug)).toContain("valid_extra");
  });
});
