import { describe, expect, test } from "vitest";

import { handleGenerateMealPlan } from "../../src/tools/handlers.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import type { FoodCatalogRecord, MealCatalog } from "../../src/tools/nutrition-estimate.js";

describe("plan regeneration supersedes stored entries", () => {
  test("deletes planned rows in the week window before inserting the new plan", async () => {
    const events: string[] = [];
    let deletedRange: { startDate: string; endDate: string } | undefined;
    const ctx: ToolContext = {
      userId: "user-id",
      locale: "en",
      catalog: CATALOG,
      seasoningRecords: [],
      repo: {
        deletePlannedMealPlanEntriesRange: async (_userId: string, startDate: string, endDate: string) => {
          events.push("delete");
          deletedRange = { startDate, endDate };
        },
        insertMealPlanEntry: async (entry: unknown) => {
          events.push("insert");
          return entry;
        },
      } as unknown as ToolContext["repo"],
      close: async () => undefined,
    };

    const result = await handleGenerateMealPlan(ctx, {
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      presetDishes: candidates(),
    });

    expect(result.status).toBe("planned");
    expect(deletedRange).toEqual({ startDate: "2026-07-06", endDate: "2026-07-12" });
    // Old planned rows are cleared before any new row lands.
    expect(events[0]).toBe("delete");
    expect(events.filter((event) => event === "insert")).toHaveLength(21);
  });

  test("does not re-insert over slots still occupied by checked-in rows", async () => {
    const inserted: { planDate: string; mealType: string }[] = [];
    const ctx: ToolContext = {
      userId: "user-id",
      locale: "en",
      catalog: CATALOG,
      seasoningRecords: [],
      repo: {
        deletePlannedMealPlanEntriesRange: async () => undefined,
        listMealPlanEntriesRange: async () => [
          // Monday lunch was already checked in as followed and survives.
          { planDate: "2026-07-06", mealType: "lunch", status: "followed" },
        ],
        insertMealPlanEntry: async (entry: { planDate: string; mealType: string }) => {
          inserted.push(entry);
          return entry;
        },
      } as unknown as ToolContext["repo"],
      close: async () => undefined,
    };

    const result = await handleGenerateMealPlan(ctx, {
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      presetDishes: candidates(),
    });

    expect(result.status).toBe("planned");
    expect(inserted).toHaveLength(20);
    expect(inserted.some((entry) => entry.planDate === "2026-07-06" && entry.mealType === "lunch")).toBe(false);
  });
});

function candidates(): RecipeDish[] {
  const breakfast: RecipeDish = {
    slug: "egg_oats_breakfast",
    name: "egg oats",
    mealTypes: ["breakfast"],
    nutrition: { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 },
    ingredients: [{ slug: "egg", grams: 150 }, { slug: "oats", grams: 80 }],
    seasonings: [],
    source: "preset",
  };
  const mains = ["main_a", "main_b"].map((slug): RecipeDish => ({
    slug,
    name: slug,
    mealTypes: ["lunch", "dinner"],
    role: "main",
    selfContained: true,
    nutrition: { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 },
    ingredients: [{ slug: "chicken_breast", grams: 200 }, { slug: "broccoli", grams: 150 }],
    seasonings: [],
    source: "preset",
  }));
  return [breakfast, ...mains];
}

const CATALOG: MealCatalog = {
  foods: [
    record("egg", 139, 13.1, 2.4, 8.6, 131.5),
    record("oats", 369, 14, 56.2, 6.8, 0),
    record("chicken_breast", 118, 19.4, 2.5, 5, 34.4),
    record("broccoli", 27, 3.5, 3.7, 0.6, 46.7),
    record("brown_rice", 348, 7.7, 75, 2.7, 5.4),
    record("tofu", 84, 6.6, 3.4, 5.3, 5.6),
    record("soy_milk", 33, 3, 1.8, 1.6, 3),
    record("yogurt_high_protein", 63, 11, 4.5, 0, 38),
  ],
  naturalUnits: [],
};

function record(
  slug: string,
  kcalPer100g: number,
  proteinGramsPer100g: number,
  carbsGramsPer100g: number,
  fatGramsPer100g: number,
  sodiumMgPer100g: number,
): FoodCatalogRecord {
  return {
    slug,
    weightType: "raw",
    defaultGrams: null,
    defaultUnit: null,
    kcalPer100g,
    proteinGramsPer100g,
    carbsGramsPer100g,
    fatGramsPer100g,
    sodiumMgPer100g,
  };
}
