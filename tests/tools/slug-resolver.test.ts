import { describe, expect, test } from "vitest";

import {
  resolveFoodSlug,
  resolveSeasoningSlug,
  slugifyDishName,
} from "../../src/tools/slug-resolver.js";
import type { MealCatalog } from "../../src/tools/nutrition-estimate.js";

const catalog: MealCatalog = {
  foods: [
    {
      slug: "beef_tenderloin",
      name: "Beef tenderloin",
      nameZh: "牛肉",
      aliases: ["beef", "牛里脊"],
      defaultGrams: null,
      defaultUnit: null,
      kcalPer100g: 107,
      proteinGramsPer100g: 22.2,
      carbsGramsPer100g: 2.4,
      fatGramsPer100g: 0.9,
      sodiumMgPer100g: 75,
    },
  ],
  naturalUnits: [],
};

const seasonings = [
  { slug: "light_soy_sauce", name: "Light soy sauce", aliases: ["生抽"] },
  { slug: "olive_oil", name: "Olive oil", aliases: ["橄榄油"] },
];

describe("slug resolver", () => {
  test("resolves food by slug, English alias, and Chinese alias", () => {
    expect(resolveFoodSlug("beef_tenderloin", catalog)).toEqual({ slug: "beef_tenderloin" });
    expect(resolveFoodSlug("beef", catalog)).toEqual({ slug: "beef_tenderloin" });
    expect(resolveFoodSlug("牛里脊", catalog)).toEqual({ slug: "beef_tenderloin" });
  });

  test("returns unresolved food when no confident match exists", () => {
    expect(resolveFoodSlug("mystery", catalog)).toEqual({ unresolved: "mystery" });
  });

  test("resolves seasoning aliases", () => {
    expect(resolveSeasoningSlug("生抽", seasonings)).toEqual({ slug: "light_soy_sauce" });
    expect(resolveSeasoningSlug("unknown", seasonings)).toEqual({ unresolved: "unknown" });
  });

  test("slugifies dish names deterministically", () => {
    expect(slugifyDishName("洋葱炒牛肉")).toBe("洋葱炒牛肉");
    expect(slugifyDishName("Onion Beef Bowl!")).toBe("onion_beef_bowl");
  });
});
