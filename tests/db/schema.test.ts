import { getTableName } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import * as schema from "../../src/db/schema.js";
import {
  loadFoodItemsFromCsv,
  loadNaturalUnitsFromCsv,
  loadSeasoningsFromCsv,
  parseCsv
} from "../../src/db/seed.js";

const requiredTables = [
  ["users", "users"],
  ["bmrProfiles", "bmr_profiles"],
  ["dailyActivityPlans", "daily_activity_plans"],
  ["dietLogs", "diet_logs"],
  ["waterLogs", "water_logs"],
  ["exerciseLogs", "exercise_logs"],
  ["physicalConditions", "physical_conditions"],
  ["mealPlanEntries", "meal_plan_entries"],
  ["foodItems", "food_items"],
  ["foodAliases", "food_aliases"],
  ["seasonings", "seasonings"],
  ["naturalUnits", "natural_units"],
  ["cookingRecords", "cooking_records"],
  ["userDishes", "user_dishes"],
  ["mealCompositions", "meal_compositions"],
  ["userSeasoningPreferences", "user_seasoning_preferences"],
  ["memoryRecords", "memory_records"]
] as const;

const nutritionColumns = [
  "caloriesKcal",
  "proteinGrams",
  "carbsGrams",
  "fatGrams",
  "fiberGrams",
  "sodiumMg",
  "potassiumMg",
  "calciumMg",
  "ironMg",
  "vitaminCMg"
] as const;

const classificationColumns = [
  "executionBuckets",
  "roles",
  "weeklyFloor",
] as const;

describe("database schema", () => {
  test("test_schema_exports_all_required_tables_with_expected_names", () => {
    for (const [exportName, tableName] of requiredTables) {
      expect(schema[exportName]).toBeDefined();
      expect(getTableName(schema[exportName])).toBe(tableName);
    }
  });

  test("test_schema_exposes_nutrition_columns_for_downstream_engines", () => {
    for (const table of [
      schema.foodItems,
      schema.dietLogs,
      schema.mealPlanEntries,
      schema.cookingRecords,
      schema.mealCompositions
    ]) {
      for (const column of nutritionColumns) {
        expect(table).toHaveProperty(column);
      }
    }
  });

  test("test_food_items_exposes_classification_columns_for_planner", () => {
    for (const column of classificationColumns) {
      expect(schema.foodItems).toHaveProperty(column);
    }
  });

  test("test_connection_module_imports_without_requiring_a_live_query", async () => {
    const connection = await import("../../src/db/connection.js");

    expect(connection.db).toBeDefined();
    expect(typeof connection.closeDb).toBe("function");
    await connection.closeDb();
  });
});

describe("seed csv helpers", () => {
  test("test_parseCsv_handles_quotes_commas_crlf_and_blank_lines", () => {
    const rows = parseCsv("slug,name,grams\r\nrice,\"Brown, cooked\",150\r\n\r\n");

    expect(rows).toEqual([{ slug: "rice", name: "Brown, cooked", grams: "150" }]);
  });

  test("test_loadFoodItemsFromCsv_normalizes_numeric_nutrition_columns", () => {
    const csv = [
      "slug,name,name_zh,category,calories_kcal,protein_g,carbs_g,fat_g,fiber_g,sodium_mg,source",
      "chicken_breast,Chicken breast,chicken breast,protein,165,31,0,3.6,0,74,test"
    ].join("\n");

    expect(loadFoodItemsFromCsv(csv)).toEqual([
      expect.objectContaining({
        slug: "chicken_breast",
        name: "Chicken breast",
        category: "protein",
        executionBuckets: ["lean_white_meat"],
        roles: ["b12"],
        weeklyFloor: 0,
        caloriesKcal: 165,
        proteinGrams: 31,
        carbsGrams: 0,
        fatGrams: 3.6,
        sodiumMg: 74
      })
    ]);
  });

  test("test_loadSeasoningsFromCsv_normalizes_servings_and_sodium", () => {
    const csv = [
      "slug,name,serving_unit,serving_grams,sodium_mg_per_serving,sodium_mg_per_100g",
      "light_soy_sauce,Light soy sauce,tbsp,18,1036,5755.6"
    ].join("\n");

    expect(loadSeasoningsFromCsv(csv)).toEqual([
      expect.objectContaining({
        slug: "light_soy_sauce",
        servingUnit: "tbsp",
        servingGrams: 18,
        sodiumMgPerServing: 1036,
        sodiumMgPer100g: 5755.6
      })
    ]);
  });

  test("test_loadNaturalUnitsFromCsv_normalizes_default_portions", () => {
    const csv = [
      "food_slug,unit_name,unit_name_zh,grams,is_default",
      "brown_rice,bowl,bowl,150,true"
    ].join("\n");

    expect(loadNaturalUnitsFromCsv(csv)).toEqual([
      expect.objectContaining({
        foodSlug: "brown_rice",
        unitName: "bowl",
        grams: 150,
        isDefault: true
      })
    ]);
  });
});
