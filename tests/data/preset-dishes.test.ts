import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { presetDishes } from "../../src/data/preset-dishes.js";
import { loadFoodItemsFromCsv } from "../../src/db/seed.js";

describe("preset dishes", () => {
  test("main dishes are main-only and do not bundle brown rice staples", () => {
    const mainDishes = presetDishes.filter((dish) =>
      dish.role !== "side" && (dish.mealTypes?.includes("lunch") || dish.mealTypes?.includes("dinner")),
    );

    expect(mainDishes.length).toBeGreaterThan(0);
    expect(mainDishes.flatMap((dish) => dish.ingredients.map((ingredient) => ingredient.slug)))
      .not.toContain("brown_rice");
  });

  test("side components are split from paired main presets", () => {
    const sideDishes = presetDishes.filter((dish) => dish.role === "side");

    expect(sideDishes.map((dish) => [dish.slug, dish.sideKind]).sort()).toEqual([
      ["bok_choy_side", "vegetable"],
      ["garlic_broccoli_side", "vegetable"],
      ["nori_soup_side", "soup"],
      ["shiitake_bok_choy_side", "vegetable"],
      ["spinach_soup_side", "soup"],
    ]);
  });

  test("main presets carry explicit self-contained side policy", () => {
    const mainDishes = presetDishes.filter((dish) =>
      dish.role !== "side" && (dish.mealTypes?.includes("lunch") || dish.mealTypes?.includes("dinner")),
    );

    expect(mainDishes.every((dish) => typeof dish.selfContained === "boolean")).toBe(true);
    expect(mainDishes.filter((dish) => dish.selfContained === false).map((dish) => dish.slug).sort()).toEqual([
      "braised_hairtail_rice",
      "braised_tofu_rice",
      "chicken_carrot_rice",
      "chicken_shrimp_salad_soup",
      "onion_beef_rice",
      "pan_seared_bream_rice",
      "scallion_beef_rice",
      "steamed_bream_rice",
    ]);
  });

  test("split main presets no longer include their side ingredients", () => {
    expect(ingredientSlugs("scallion_beef_rice")).not.toContain("broccoli");
    expect(ingredientSlugs("braised_hairtail_rice")).not.toEqual(expect.arrayContaining(["bok_choy", "shiitake_fresh"]));
    expect(ingredientSlugs("onion_beef_rice")).not.toContain("spinach");
    expect(ingredientSlugs("braised_tofu_rice")).not.toContain("bok_choy");
  });

  test("all preset ingredient slugs exist in the seed food catalog", () => {
    const csv = readFileSync(join(process.cwd(), "seed", "ingredients.csv"), "utf8");
    const catalogSlugs = new Set(loadFoodItemsFromCsv(csv).map((food) => food.slug));
    const missing = presetDishes
      .flatMap((dish) => dish.ingredients.map((ingredient) => ingredient.slug))
      .filter((slug, index, array) => !catalogSlugs.has(slug) && array.indexOf(slug) === index);

    expect(missing).toEqual([]);
  });
});

function ingredientSlugs(slug: string): readonly string[] {
  const dish = presetDishes.find((candidate) => candidate.slug === slug);
  expect(dish).toBeDefined();
  return dish!.ingredients.map((ingredient) => ingredient.slug);
}
