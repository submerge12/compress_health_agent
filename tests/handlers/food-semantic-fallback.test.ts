import { describe, expect, test, vi } from "vitest";

import type { DietLogRow } from "../../src/db/repository.js";
import { handleLogMeal, handleNutritionEstimate } from "../../src/tools/handlers.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { FoodCatalogRecord } from "../../src/tools/nutrition-estimate.js";

function food(record: Partial<FoodCatalogRecord> & Pick<FoodCatalogRecord, "slug" | "name">): FoodCatalogRecord {
  return {
    defaultGrams: 100,
    defaultUnit: "serving",
    kcalPer100g: 100,
    proteinGramsPer100g: 10,
    carbsGramsPer100g: 5,
    fatGramsPer100g: 2,
    sodiumMgPer100g: 20,
    weightType: "raw",
    ...record,
  };
}

function dietLog(overrides: Partial<DietLogRow>): DietLogRow {
  return {
    id: "diet-log-id",
    userId: "user-id",
    logDate: "2026-07-01",
    mealType: "breakfast",
    description: "100g morning protein plate",
    source: "agent",
    ingredientsJson: [],
    seasoningsJson: [],
    caloriesKcal: 0,
    proteinGrams: 0,
    carbsGrams: 0,
    fatGrams: 0,
    sodiumMg: 0,
    ...overrides,
  };
}

function makeContext(): ToolContext {
  const embeddingClient = {
    embed: vi.fn(async () => [[1, 0, 0]]),
  };
  const repo = {
    findFoodCandidatesByEmbedding: vi.fn(async () => [
      { slug: "tomato_scrambled_eggs", score: 0.91 },
    ]),
    insertDietLog: vi.fn(async (input) => dietLog({
      ingredientsJson: input.ingredientsJson,
      caloriesKcal: input.caloriesKcal,
      proteinGrams: input.proteinGrams,
      carbsGrams: input.carbsGrams,
      fatGrams: input.fatGrams,
      sodiumMg: input.sodiumMg,
    })),
  };

  return {
    userId: "user-id",
    locale: "zh",
    repo: repo as unknown as ToolContext["repo"],
    embeddingClient,
    catalog: {
      foods: [
        food({
          slug: "tomato_scrambled_eggs",
          name: "番茄炒蛋",
          nameZh: "番茄炒蛋",
          aliases: [],
        }),
      ],
      naturalUnits: [],
    },
    seasoningRecords: [],
    close: async () => undefined,
  };
}

describe("handler semantic food fallback", () => {
  test("handleNutritionEstimate resolves zero-overlap food through injected embedding fallback", async () => {
    const ctx = makeContext();

    const result = await handleNutritionEstimate(ctx, {
      description: "100g morning protein plate",
    });

    expect(result.items).toEqual([
      expect.objectContaining({ slug: "tomato_scrambled_eggs", grams: 100 }),
    ]);
    expect(ctx.embeddingClient?.embed).toHaveBeenCalledTimes(1);
    expect(ctx.repo.findFoodCandidatesByEmbedding).toHaveBeenCalledWith([1, 0, 0], 3);
  });

  test("handleLogMeal writes the semantically resolved food item", async () => {
    const ctx = makeContext();

    const result = await handleLogMeal(ctx, {
      date: "2026-07-01",
      mealType: "breakfast",
      description: "100g morning protein plate",
    });

    expect(ctx.repo.insertDietLog).toHaveBeenCalledWith(expect.objectContaining({
      ingredientsJson: [{ slug: "tomato_scrambled_eggs", grams: 100 }],
      caloriesKcal: 100,
      proteinGrams: 10,
    }));
    expect(result.ingredientsJson).toEqual([
      { slug: "tomato_scrambled_eggs", grams: 100 },
    ]);
  });

  test("handleLogMeal writes a low-confidence fallback estimate when no food resolves", async () => {
    const ctx = makeContext();
    ctx.embeddingClient = undefined;

    const result = await handleLogMeal(ctx, {
      date: "2026-07-01",
      mealType: "breakfast",
      description: "mystery food 200g",
    });

    expect(ctx.repo.insertDietLog).toHaveBeenCalledWith(expect.objectContaining({
      ingredientsJson: [
        expect.objectContaining({
          slug: "unknown_food",
          segment: "mystery food 200g",
          grams: 200,
          estimateSource: "fallback",
          confidence: "low",
        }),
      ],
      caloriesKcal: expect.any(Number),
    }));
    expect(result.uncertain).toBe(true);
    expect(result.fallbackEstimates).toEqual([
      expect.objectContaining({
        segment: "mystery food 200g",
        grams: 200,
      }),
    ]);
  });
});
