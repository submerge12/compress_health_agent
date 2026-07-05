import { describe, expect, test } from "vitest";

import { dedupeRowsBySlug, loadFoodItemsFromCsv } from "../../src/db/seed.js";

describe("dedupeRowsBySlug", () => {
  test("keeps the first row per slug and unions allergen tags from duplicates", () => {
    const rows = loadFoodItemsFromCsv([
      "slug,name,name_zh,category,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg,allergen_tags",
      "mackerel,Spanish mackerel,鲅鱼,seafood,122,19.3,0,4.7,74.4,fish|seafood",
      "mackerel,Salted mackerel,鲅鱼,seafood,155,24.4,0,6.1,1560,fish|seafood|high_sodium",
      "mackerel,Mackerel variant,鲅鱼,seafood,130,20,0,5,80,",
      "oats,Rolled oats,燕麦片,grain,379,13.2,67.7,6.5,6,",
    ].join("\n"));
    expect(rows).toHaveLength(4);

    const deduped = dedupeRowsBySlug(rows);

    expect(deduped).toHaveLength(2);
    const mackerel = deduped.find((row) => row.slug === "mackerel");
    expect(mackerel?.name).toBe("Spanish mackerel");
    expect(mackerel?.caloriesKcal).toBe(122);
    expect(mackerel?.allergenTags).toEqual(["fish", "high_sodium", "seafood"]);
  });

  test("the real food library yields a slug-unique batch after dedupe", async () => {
    const { readFile } = await import("node:fs/promises");
    const rows = loadFoodItemsFromCsv(await readFile("seed/food_library.csv", "utf8"));
    const deduped = dedupeRowsBySlug(rows);

    const slugs = deduped.map((row) => row.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(deduped.length).toBeLessThan(rows.length);
  });
});
