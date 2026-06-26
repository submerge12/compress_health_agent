import { describe, expect, test } from "vitest";

import type { MealPlanEntryRow } from "../../src/db/repository.js";
import type { ToolContext } from "../../src/tools/context.js";
import { handleProactiveCheck } from "../../src/tools/handlers.js";

const chineseCharacters = /[\u3400-\u9fff]/;

function mealPlanEntry(overrides: Partial<MealPlanEntryRow>): MealPlanEntryRow {
  return {
    id: "entry-id",
    userId: "user-id",
    planDate: "2026-06-25",
    mealType: "lunch",
    dishName: "test dish",
    recipeSlug: null,
    status: "planned",
    ingredientsJson: [],
    seasoningsJson: [],
    caloriesKcal: 500,
    proteinGrams: 30,
    carbsGrams: 50,
    fatGrams: 12,
    sodiumMg: 400,
    ...overrides,
  };
}

function makeContext(entriesByDate: Record<string, MealPlanEntryRow[]>, locale: "zh" | "en" = "en"): ToolContext {
  return {
    userId: "user-id",
    locale,
    catalog: {
      foods: [
        food("future_meat", "Future meat", "meat"),
        food("chicken_breast", "Chicken breast", "poultry"),
        food("shrimp_jiweixia", "Shrimp", "seafood"),
        food("broccoli", "Broccoli", "vegetable"),
      ],
      naturalUnits: [],
    },
    seasoningRecords: [],
    repo: {
      listMealPlanEntries: async (_userId: string, date?: string) => entriesByDate[date ?? ""] ?? [],
      listDietLogs: async () => [
        {
          id: "diet-log-id",
          userId: "user-id",
          logDate: "2026-06-24",
          mealType: "dinner",
          description: "dinner",
          source: "agent",
          ingredientsJson: [],
          seasoningsJson: [],
          caloriesKcal: 700,
          proteinGrams: 45,
          carbsGrams: 70,
          fatGrams: 20,
          sodiumMg: 500,
        },
      ],
      listWaterLogs: async () => [{ id: "water-log-id", userId: "user-id", logDate: "2026-06-24", amountMl: 1200 }],
      listExerciseLogs: async () => [
        {
          id: "exercise-log-id",
          userId: "user-id",
          logDate: "2026-06-24",
          activityType: "walking",
          durationMinutes: 30,
          caloriesBurnedKcal: 120,
          intensity: null,
          notes: null,
        },
      ],
      getLatestBmrProfile: async () => ({
        id: "profile-id",
        userId: "user-id",
        sex: "female",
        ageYears: 30,
        heightCm: 165,
        weightKg: 60,
        activityLevel: "lightly_active",
        goal: "maintain",
        bmrKcal: 1300,
        tdeeKcal: 1800,
        targetKcal: 1700,
        proteinTargetGrams: 100,
        carbsTargetGrams: 190,
        fatTargetGrams: 55,
      }),
    } as unknown as ToolContext["repo"],
    close: async () => undefined,
  };
}

function food(slug: string, name: string, category: string) {
  return {
    slug,
    name,
    category,
    aliases: [name],
    defaultGrams: null,
    defaultUnit: null,
    kcalPer100g: 100,
    proteinGramsPer100g: 10,
    carbsGramsPer100g: 5,
    fatGramsPer100g: 2,
    sodiumMgPer100g: 30,
  };
}

describe("handleProactiveCheck", () => {
  test("returns an English meal check-in and derives thaw items from food categories", async () => {
    const ctx = makeContext({
      "2026-06-25": [
        mealPlanEntry({
          id: "breakfast-entry",
          mealType: "breakfast",
          dishName: "Past breakfast",
          ingredientsJson: [{ slug: "future_meat", grams: 90 }],
        }),
        mealPlanEntry({
          id: "lunch-entry",
          mealType: "lunch",
          dishName: "Lunch bowl",
          ingredientsJson: [{ slug: "broccoli", grams: 120 }],
        }),
        mealPlanEntry({
          id: "dinner-entry",
          mealType: "dinner",
          dishName: "Future stew",
          ingredientsJson: [{ slug: "future_meat", grams: 140 }],
        }),
      ],
    });

    const result = await handleProactiveCheck(ctx, {
      now: new Date(2026, 5, 25, 12, 30),
      locale: "en",
    });

    expect(result.kind).toBe("meal_checkin");
    expect(result.mealType).toBe("lunch");
    expect(result.plannedMeal).toMatchObject({
      entryId: "lunch-entry",
      dishName: "Lunch bowl",
      kcal: 500,
      proteinGrams: 30,
    });
    expect(result.thawItems).toHaveLength(1);
    expect(result.thawItems[0]).toMatchObject({
      entryId: "dinner-entry",
      dishName: "Future stew",
      ingredients: [{ slug: "future_meat", grams: 140, category: "meat", name: "Future meat" }],
    });
    expect(result.message).toContain("Meal check-in");
    expect(result.message).toContain("🧊 Thaw reminder");
    expect(result.message).not.toContain("Past breakfast");
  });

  test("returns Chinese missing-plan output from i18n templates", async () => {
    const ctx = makeContext({ "2026-06-25": [] }, "zh");

    const result = await handleProactiveCheck(ctx, {
      now: new Date(2026, 5, 25, 8, 30),
    });

    expect(result.kind).toBe("missing_plan");
    expect(result.locale).toBe("zh");
    expect(result.message).toMatch(chineseCharacters);
    expect(result.message).not.toContain("No planned");
    expect(result.thawItems).toEqual([]);
  });

  test("dinner check-in includes tomorrow thaw items", async () => {
    const ctx = makeContext({
      "2026-06-25": [
        mealPlanEntry({
          id: "dinner-entry",
          mealType: "dinner",
          dishName: "Dinner",
        }),
      ],
      "2026-06-26": [
        mealPlanEntry({
          id: "tomorrow-lunch",
          planDate: "2026-06-26",
          mealType: "lunch",
          dishName: "Tomorrow shrimp",
          ingredientsJson: [{ slug: "shrimp_jiweixia", grams: 160 }],
        }),
      ],
    });

    const result = await handleProactiveCheck(ctx, {
      now: new Date(2026, 5, 25, 18, 30),
      locale: "en",
    });

    expect(result.kind).toBe("meal_checkin");
    expect(result.thawItems).toHaveLength(1);
    expect(result.thawItems[0]?.entryId).toBe("tomorrow-lunch");
    expect(result.message).toContain("Tomorrow shrimp");
  });

  test("late-night check returns localized daily summary for yesterday", async () => {
    const ctx = makeContext({}, "en");

    const result = await handleProactiveCheck(ctx, {
      now: new Date(2026, 5, 25, 23, 15),
    });

    expect(result.kind).toBe("daily_summary");
    expect(result.date).toBe("2026-06-24");
    expect(result.message).toContain("Daily summary for 2026-06-24");
    expect(result.message).toContain("700 kcal eaten");
    expect(result.thawItems).toEqual([]);
  });
});
