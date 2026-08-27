import { describe, expect, test } from "vitest";

import { resolveConfirmedFoodCandidates } from "../../src/domain/diet-log-service.js";
import type { ToolContext } from "../../src/tools/context.js";
import {
  nutritionEstimate,
  type FoodCatalogRecord,
  type MealCatalog,
} from "../../src/tools/nutrition-estimate.js";

function food(
  record: Partial<FoodCatalogRecord> & Pick<FoodCatalogRecord, "slug" | "name">,
): FoodCatalogRecord {
  return {
    defaultGrams: null,
    defaultUnit: null,
    kcalPer100g: 100,
    proteinGramsPer100g: 10,
    carbsGramsPer100g: 5,
    fatGramsPer100g: 2,
    sodiumMgPer100g: 20,
    weightType: "raw",
    ...record,
  };
}

const formalCatalogShape: MealCatalog = {
  foods: [
    food({
      slug: "egg",
      name: "鸡蛋（代表值）",
      nameZh: "鸡蛋（代表值）",
      aliases: ["Egg (representative)", "鸡蛋", "蛋", "鸡蛋（煮）"],
    }),
    food({
      slug: "鸡蛋",
      name: "鸡蛋（代表值）",
      nameZh: "鸡蛋（代表值）",
      aliases: ["鸡蛋"],
    }),
    food({
      slug: "soy_milk",
      name: "豆浆",
      nameZh: "豆浆",
      aliases: ["Soy milk", "豆浆（甜）"],
      gramsPerMilliliter: 1,
    }),
    food({
      slug: "豆浆",
      name: "豆浆",
      nameZh: "豆浆",
      aliases: ["豆浆"],
    }),
  ],
  naturalUnits: [
    { foodSlug: "egg", unit: "piece", aliases: ["个"], grams: 50 },
  ],
};

const canonicalCatalog: MealCatalog = {
  foods: formalCatalogShape.foods.filter((entry) => entry.slug === "egg" || entry.slug === "soy_milk"),
  naturalUnits: formalCatalogShape.naturalUnits,
};

describe("Chinese meal input", () => {
  test("parses a Chinese count against a natural unit", () => {
    const result = nutritionEstimate({ description: "两个水煮鸡蛋" }, canonicalCatalog);

    expect(result.needsConfirmation ?? []).toEqual([]);
    expect(result.unmatched ?? []).toEqual([]);
    expect(result.items).toEqual([{ slug: "egg", grams: 100 }]);
  });

  test("converts an explicit milliliter amount for a drink", () => {
    const result = nutritionEstimate({ description: "600毫升无糖原味豆浆" }, canonicalCatalog);

    expect(result.needsConfirmation ?? []).toEqual([]);
    expect(result.unmatched ?? []).toEqual([]);
    expect(result.items).toEqual([{ slug: "soy_milk", grams: 600 }]);
  });

  test("resolves the real voice breakfast without MRTR or duplicate catalog slugs", () => {
    const result = nutritionEstimate({
      description: "两个水煮鸡蛋，600毫升无糖原味豆浆",
    }, formalCatalogShape);

    expect(result.needsConfirmation ?? []).toEqual([]);
    expect(result.unmatched ?? []).toEqual([]);
    expect(result.items).toEqual([
      { slug: "egg", grams: 100 },
      { slug: "soy_milk", grams: 600 },
    ]);
  });

  test("preserves the original counted portion when an unmatched food is confirmed", async () => {
    const estimate = nutritionEstimate({ description: "神秘食物2个" }, formalCatalogShape);
    expect(estimate.unmatched).toEqual([
      expect.objectContaining({ segment: "神秘食物2个" }),
    ]);

    const resolved = await resolveConfirmedFoodCandidates(
      { catalog: formalCatalogShape } as ToolContext,
      estimate,
      { unmatched_0: "egg" },
    );

    expect(resolved.items).toEqual([{ slug: "egg", grams: 100 }]);
  });
});
