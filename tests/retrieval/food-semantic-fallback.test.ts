import { describe, expect, test, vi } from "vitest";

import {
  nutritionEstimate,
  nutritionEstimateWithSemanticFallback,
  type FoodCatalogRecord,
  type MealCatalog,
} from "../../src/tools/nutrition-estimate.js";

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

const catalog: MealCatalog = {
  foods: [
    food({
      slug: "tomato_scrambled_eggs",
      name: "番茄炒蛋",
      nameZh: "番茄炒蛋",
      aliases: [],
    }),
    food({
      slug: "beef_stew",
      name: "红烧牛腩",
      nameZh: "红烧牛腩",
      aliases: [],
    }),
    food({
      slug: "broccoli",
      name: "broccoli",
      aliases: ["西兰花"],
    }),
  ],
  naturalUnits: [],
};

describe("food semantic embedding fallback", () => {
  test("zero-overlap English to Chinese food names resolve only through semantic fallback", async () => {
    const description = "100g morning protein plate";
    const lexicalOnly = nutritionEstimate({ description }, catalog);
    expect(lexicalOnly.items).toEqual([]);
    expect(lexicalOnly.unmatched?.[0]?.segment).toBe(description);

    const embeddingClient = {
      embed: vi.fn(async () => [[1, 0, 0]]),
    };
    const semanticSearch = {
      findFoodCandidatesByEmbedding: vi.fn(async () => [
        { slug: "tomato_scrambled_eggs", score: 0.91 },
      ]),
    };

    const result = await nutritionEstimateWithSemanticFallback(
      { description },
      catalog,
      { embeddingClient, semanticSearch },
    );

    expect(embeddingClient.embed).toHaveBeenCalledTimes(1);
    expect(semanticSearch.findFoodCandidatesByEmbedding).toHaveBeenCalledWith([1, 0, 0], 3);
    expect(result.items).toEqual([
      expect.objectContaining({ slug: "tomato_scrambled_eggs", grams: 100 }),
    ]);
    expect(result.unmatched).toBeUndefined();
    expect(result.needsConfirmation).toBeUndefined();
  });

  test("weak semantic matches reuse the existing needsConfirmation confidence gate", async () => {
    const embeddingClient = {
      embed: vi.fn(async () => [[0, 1, 0]]),
    };
    const semanticSearch = {
      findFoodCandidatesByEmbedding: vi.fn(async () => [
        { slug: "beef_stew", score: 0.4 },
      ]),
    };

    const result = await nutritionEstimateWithSemanticFallback(
      { description: "80g cozy dinner protein" },
      catalog,
      { embeddingClient, semanticSearch },
    );

    expect(result.items).toEqual([]);
    expect(result.needsConfirmation).toEqual([
      {
        segment: "80g cozy dinner protein",
        candidates: [
          { slug: "beef_stew", label: "红烧牛腩", score: 0.4 },
        ],
      },
    ]);
  });

  test("lexical hits never call the embedding fallback", async () => {
    const embeddingClient = {
      embed: vi.fn(async () => [[1, 0, 0]]),
    };
    const semanticSearch = {
      findFoodCandidatesByEmbedding: vi.fn(async () => [
        { slug: "broccoli", score: 0.99 },
      ]),
    };

    const result = await nutritionEstimateWithSemanticFallback(
      { description: "120g broccoli" },
      catalog,
      { embeddingClient, semanticSearch },
    );

    expect(result.items).toEqual([
      expect.objectContaining({ slug: "broccoli", grams: 120 }),
    ]);
    expect(embeddingClient.embed).not.toHaveBeenCalled();
    expect(semanticSearch.findFoodCandidatesByEmbedding).not.toHaveBeenCalled();
  });
});
