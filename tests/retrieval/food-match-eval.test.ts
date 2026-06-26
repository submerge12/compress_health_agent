import { describe, expect, test } from "vitest";

import {
  matchFood,
  normalize,
  rankFoodCandidates,
} from "../../src/tools/food-matcher.js";
import {
  nutritionEstimate,
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
    ...record,
  };
}

const catalog: MealCatalog = {
  foods: [
    food({
      slug: "tomato_scrambled_eggs",
      name: "tomato egg scramble",
      aliases: ["tomato scrambled eggs", "tomato eggs", "番茄炒蛋", "西红柿炒蛋"],
    }),
    food({
      slug: "chicken_breast",
      name: "chicken breast",
      aliases: ["chicken breast fillet", "鸡胸肉"],
    }),
    food({
      slug: "broccoli",
      name: "broccoli",
      aliases: ["西兰花"],
    }),
    food({
      slug: "brown_rice",
      name: "brown rice",
      aliases: ["rice", "糙米"],
    }),
    food({
      slug: "white_rice",
      name: "white rice",
      aliases: ["rice", "米饭"],
    }),
  ],
  naturalUnits: [],
};

function substringBaseline(description: string): string | undefined {
  const lowered = description.toLocaleLowerCase();
  for (const item of catalog.foods) {
    const labels = [
      item.name,
      item.slug.replace(/_/g, " "),
      item.slug,
      ...(item.aliases ?? []),
    ].filter((label): label is string => Boolean(label?.trim()));
    if (labels.some((label) => lowered.includes(label.toLocaleLowerCase()))) {
      return item.slug;
    }
  }
  return undefined;
}

describe("food matcher L2 retrieval", () => {
  test("normalizes full-width characters, punctuation, emoji, and common traditional Chinese", () => {
    expect(normalize("Ｔｏｍａｔｏ 🍅 炒！雞蛋")).toBe("tomato炒蛋");
  });

  test.each([
    ["200g tomato scrambled eggs", "tomato_scrambled_eggs"],
    ["200g 西红柿炒鸡蛋", "tomato_scrambled_eggs"],
    ["200g 蕃茄炒雞蛋", "tomato_scrambled_eggs"],
    ["120g chiken brest", "chicken_breast"],
    ["1 serving brocoli", "broccoli"],
  ])("matchFood resolves paraphrases and typos: %s", (description, expectedSlug) => {
    expect(matchFood(description, catalog)?.food.slug).toBe(expectedSlug);
  });

  test("rankFoodCandidates exposes tied aliases for clarification", () => {
    const candidates = rankFoodCandidates("150g rice", catalog, 3);

    expect(candidates.slice(0, 2).map((candidate) => candidate.food.slug).sort()).toEqual([
      "brown_rice",
      "white_rice",
    ]);
    const [first, second] = candidates;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.score).toBe(second!.score);
  });

  test("nutritionEstimate returns needsConfirmation instead of silently choosing ambiguous food", () => {
    const result = nutritionEstimate({ description: "150g rice" }, catalog);

    expect(result.items).toEqual([]);
    expect(result.needsConfirmation).toEqual([
      {
        segment: "150g rice",
        candidates: expect.arrayContaining([
          expect.objectContaining({ slug: "brown_rice", score: expect.any(Number) }),
          expect.objectContaining({ slug: "white_rice", score: expect.any(Number) }),
        ]),
      },
    ]);
  });

  test("nutritionEstimate returns unmatched segments instead of throwing for unknown food", () => {
    const result = nutritionEstimate({ description: "mystery food" }, catalog);

    expect(result.items).toEqual([]);
    expect(result.kcal).toBe(0);
    expect(result.unmatched).toEqual([
      {
        segment: "mystery food",
        candidates: expect.any(Array),
      },
    ]);
  });

  test("hybrid matcher improves coverage over the old substring baseline", () => {
    const evalCases = [
      ["200g tomato scrambled eggs", "tomato_scrambled_eggs"],
      ["200g 西红柿炒鸡蛋", "tomato_scrambled_eggs"],
      ["200g 蕃茄炒雞蛋", "tomato_scrambled_eggs"],
      ["120g chiken brest", "chicken_breast"],
      ["1 serving brocoli", "broccoli"],
    ] as const;

    const baselineHits = evalCases.filter(([description, expected]) => substringBaseline(description) === expected);
    const matcherHits = evalCases.filter(([description, expected]) => matchFood(description, catalog)?.food.slug === expected);

    expect(matcherHits.length).toBe(evalCases.length);
    expect(matcherHits.length).toBeGreaterThan(baselineHits.length);
  });
});
