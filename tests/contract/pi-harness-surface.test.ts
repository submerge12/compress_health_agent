import { describe, expect, test } from "vitest";

import type { MealPlanEntryRow } from "../../src/db/repository.js";
import { compassHealthProfileSpec, createToolContextFromEnv } from "../../src/index.js";
import { initToolContext, type ToolContext } from "../../src/tools/context.js";
import * as handlers from "../../src/tools/handlers.js";

const piHarnessHandlers = [
  "handleSetProfile",
  "handleGetProfile",
  "handleLogMeal",
  "handleLogWater",
  "handleLogExercise",
  "handleLogWeight",
  "handleMealCheckin",
  "handleUpdateCookingRecord",
  "handleSmartGenerateMealPlan",
  "handleNutritionEstimate",
  "handleDailySummary",
  "handleSmartRecipeRecommend",
  "handleWeeklyReport",
  "handleRemember",
  "handleRecall",
  "handleProposeDish",
  "handleSaveDish",
] as const satisfies readonly (keyof typeof handlers)[];

type ImportedToolContext = ToolContext;

const mealPlanEntryRowGuard = {
  id: "entry-id",
  userId: "user-id",
  planDate: "2026-06-25",
  mealType: "lunch",
  dishName: "test dish",
  recipeSlug: null,
  status: "planned",
  ingredientsJson: [{ slug: "chicken_breast", grams: 120 }],
  seasoningsJson: [{ slug: "salt" }],
  caloriesKcal: 520,
  proteinGrams: 35,
  carbsGrams: 48,
  fatGrams: 16,
  sodiumMg: 480,
} satisfies MealPlanEntryRow;

describe("pi-harness import surface", () => {
  test("root export exposes the single-source profile spec and env context factory", () => {
    expect(typeof createToolContextFromEnv).toBe("function");
    expect(createToolContextFromEnv.length).toBe(0);
    expect(compassHealthProfileSpec).toMatchObject({
      name: "compass-health",
      model: { provider: "deepseek", modelId: "deepseek-v4-pro" },
      thinkingLevel: "medium",
      policy: {
        defaults: {
          destructive: "deny",
          network: "deny",
        },
      },
    });
    expect(compassHealthProfileSpec.scheduledTasks).toHaveLength(4);
    expect(compassHealthProfileSpec.scheduledTasks.every((task) => task.taskType === "proactive_check")).toBe(true);
  });

  test("context export used by pi-harness is present", () => {
    expect(typeof initToolContext).toBe("function");
    expect(initToolContext.length).toBe(1);
  });

  test("ToolContext type exposes the repo method pi-harness proactive checks use", () => {
    const repo = {} as ImportedToolContext["repo"];
    expect<keyof typeof repo>("listMealPlanEntries").toBe("listMealPlanEntries");
  });

  test("handler exports used by pi-harness are present with ctx/input arity", () => {
    for (const name of piHarnessHandlers) {
      const handler = handlers[name];
      expect(typeof handler).toBe("function");
      expect(handler.length).toBe(2);
    }
  });

  test("save_dish input type accepts legacy schema-shaped main payloads", () => {
    const legacyMainPayload = {
      name: "Onion beef",
      mealCategory: "main",
      ingredients: [{ slug: "beef_tenderloin", grams: 200 }],
      seasonings: [],
      source: "user_nl",
      slug: "onion_beef",
      nutrition: {
        kcal: 214,
        proteinGrams: 44.4,
        carbsGrams: 4.8,
        fatGrams: 1.8,
        sodiumMg: 150,
      },
      buckets: ["red_meat"],
      roles: ["b12", "iron", "zinc"],
      unresolved: [],
    } satisfies Parameters<typeof handlers.handleSaveDish>[1];

    expect(legacyMainPayload).not.toHaveProperty("role");
    expect(legacyMainPayload).not.toHaveProperty("selfContained");
    expect(legacyMainPayload).not.toHaveProperty("sideKind");
  });

  test("MealPlanEntryRow exposes fields pi-harness proactive checks read", () => {
    expect(mealPlanEntryRowGuard).toMatchObject({
      mealType: expect.any(String),
      status: expect.any(String),
      dishName: expect.any(String),
      caloriesKcal: expect.any(Number),
      proteinGrams: expect.any(Number),
      ingredientsJson: expect.any(Array),
    });
  });
});
