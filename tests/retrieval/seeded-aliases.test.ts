import { describe, expect, test } from "vitest";

import {
  dedupeFoodLibraryRows,
  loadFoodAliasesFromCsv,
  loadFoodItemsFromCsv,
  type FoodAliasSeed,
  type FoodItemSeed,
} from "../../src/db/seed.js";
import { matchFood } from "../../src/tools/food-matcher.js";
import {
  nutritionEstimate,
  type FoodCatalogRecord,
  type MealCatalog,
} from "../../src/tools/nutrition-estimate.js";

describe("seeded food aliases", () => {
  test("resolve common Chinese chicken aliases without the duplicate library row", () => {
    const curatedCsv = [
      "slug,name,name_zh,category,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg,aliases",
      "chicken_breast,Chicken breast,鸡胸脯肉,poultry,118,19.4,2.5,5,34.4,鸡胸肉|鸡胸",
      "brown_rice,Brown rice,糙米,grain,348,7.7,75,2.7,5.4,糙米饭"
    ].join("\n");
    const curatedRows = loadFoodItemsFromCsv(curatedCsv);
    const curatedAliases = loadFoodAliasesFromCsv(curatedCsv);
    const libraryRows = loadFoodItemsFromCsv([
      "slug,name_zh,name_en,category_zh,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg",
      "xlsx_1025,鸡胸脯肉,鸡胸脯肉,鸡,118,19.4,2.5,5,34.4"
    ].join("\n"));
    const deduped = dedupeFoodLibraryRows(curatedRows, curatedAliases, libraryRows);
    const catalog = mealCatalog([...curatedRows, ...deduped.foodItems], [
      ...curatedAliases,
      ...deduped.aliases,
    ]);

    expect(matchFood("鸡胸肉", catalog)?.food.slug).toBe("chicken_breast");
    expect(matchFood("鸡胸脯肉", catalog)?.food.slug).toBe("chicken_breast");
    expect(catalog.foods.map((food) => food.slug)).not.toContain("xlsx_1025");

    const result = nutritionEstimate({ description: "鸡胸肉200克 + 糙米80克" }, catalog);

    expect(result.needsConfirmation ?? []).toEqual([]);
    expect(result.unmatched ?? []).toEqual([]);
    expect(result.items.map((item) => item.slug)).toEqual(["chicken_breast", "brown_rice"]);
  });
});

function mealCatalog(
  rows: readonly FoodItemSeed[],
  aliases: readonly FoodAliasSeed[],
): MealCatalog {
  return {
    foods: rows.map((row) => toFoodRecord(row, aliases.filter((alias) => alias.slug === row.slug))),
    naturalUnits: [],
  };
}

function toFoodRecord(row: FoodItemSeed, aliases: readonly FoodAliasSeed[]): FoodCatalogRecord {
  return {
    slug: row.slug,
    name: row.nameZh ?? row.name,
    nameZh: row.nameZh,
    aliases: [
      row.name,
      row.nameZh,
      ...aliases.map((alias) => alias.alias),
    ].filter((value): value is string => Boolean(value?.trim())),
    defaultGrams: 100,
    defaultUnit: "serving",
    kcalPer100g: row.caloriesKcal,
    proteinGramsPer100g: row.proteinGrams,
    carbsGramsPer100g: row.carbsGrams,
    fatGramsPer100g: row.fatGrams,
    sodiumMgPer100g: row.sodiumMg,
    weightType: row.weightType,
  };
}
