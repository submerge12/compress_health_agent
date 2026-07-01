import { getTableName, getTableUniqueName } from "drizzle-orm";
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
  "allergenTags",
  "weightType",
  "frequencyHint",
  "cookingDifficulty",
  "availability",
  "specialHandlingTags",
] as const;

describe("database schema", () => {
  test("test_schema_exports_all_required_tables_with_expected_names", () => {
    for (const [exportName, tableName] of requiredTables) {
      expect(schema[exportName]).toBeDefined();
      expect(getTableName(schema[exportName])).toBe(tableName);
      expect(getTableUniqueName(schema[exportName])).toBe(`compass_health.${tableName}`);
    }
  });

  test("test_schema_exports_compass_health_schema_namespace", () => {
    expect(schema.compass).toBeDefined();
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

  test("test_user_dishes_exposes_side_composition_columns", () => {
    expect(schema.userDishes).toHaveProperty("role");
    expect(schema.userDishes).toHaveProperty("sideKind");
    expect(schema.userDishes).toHaveProperty("selfContained");
  });

  test("test_memory_records_exposes_pg_trgm_normalized_column", () => {
    expect(schema.memoryRecords).toHaveProperty("contentNorm");
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
        weightType: "raw",
        caloriesKcal: 165,
        proteinGrams: 31,
        carbsGrams: 0,
        fatGrams: 3.6,
        sodiumMg: 74
      })
    ]);
  });

  test("test_loadFoodItemsFromCsv_normalizes_phase3_metadata_columns", () => {
    const csv = [
      "slug,name,category,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg,allergen_tags,weight_type,frequency_hint,cooking_difficulty,availability,special_handling_tags",
      "dried_shrimp,Dried shrimp,seafood,253,48,0,2,5100,seafood|shellfish|shrimp,dry,weekly,basic,specialty,seasoning|high_sodium"
    ].join("\n");

    expect(loadFoodItemsFromCsv(csv)).toEqual([
      expect.objectContaining({
        slug: "dried_shrimp",
        allergenTags: ["seafood", "shellfish", "shrimp"],
        weightType: "dry",
        frequencyHint: "weekly",
        cookingDifficulty: "basic",
        availability: "specialty",
        specialHandlingTags: ["seasoning", "high_sodium"],
      })
    ]);
  });

  test("test_loadFoodItemsFromCsv_infers_phase3_metadata_for_known_food_groups", () => {
    const csv = [
      "slug,name,category,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg",
      "brown_rice,Brown rice,grain,348,7.7,75,2.7,1",
      "shrimp_jiweixia,Shrimp,seafood,101,18.2,3.9,1.4,172",
      "konjac,Konjac,starch,7,0.1,3.3,0,2",
      "dried_shrimp,Dried shrimp,seafood,253,47.6,0,2.3,5100",
      "chicken_liver,Chicken liver,poultry,121,16.6,0.6,4.8,71",
      "red_bean,Red bean,legume,324,20,63,1,12"
    ].join("\n");
    const bySlug = new Map(loadFoodItemsFromCsv(csv).map((item) => [item.slug, item]));

    expect(bySlug.get("brown_rice")).toMatchObject({
      executionBuckets: ["staple"],
      weightType: "dry",
    });
    expect(bySlug.get("shrimp_jiweixia")).toMatchObject({
      allergenTags: ["seafood", "shellfish", "shrimp"],
      weightType: "raw",
    });
    expect(bySlug.get("konjac")).toMatchObject({
      executionBuckets: ["filler"],
      specialHandlingTags: ["filler", "not_vegetable"],
    });
    expect(bySlug.get("dried_shrimp")).toMatchObject({
      executionBuckets: ["seasoning"],
      allergenTags: ["seafood", "shellfish", "shrimp"],
      specialHandlingTags: ["seasoning", "high_sodium", "seasoning_not_main_protein"],
      weightType: "dry",
    });
    expect(bySlug.get("chicken_liver")).toMatchObject({
      executionBuckets: ["organ_meat"],
      roles: ["iron", "b12", "vitamin_a"],
      frequencyHint: "weekly",
      weightType: "raw",
    });
    expect(bySlug.get("red_bean")).toMatchObject({
      executionBuckets: ["legume"],
      weightType: "dry",
    });
    expect(bySlug.get("red_bean")?.executionBuckets).not.toContain("soy_product");
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
