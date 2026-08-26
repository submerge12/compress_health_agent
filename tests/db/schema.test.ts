import { getTableName, getTableUniqueName } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import * as schema from "../../src/db/schema.js";
import {
  dedupeFoodLibraryRows,
  loadFoodAliasesFromCsv,
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

  test("test_food_items_exposes_semantic_embedding_column", () => {
    expect(schema.foodItems).toHaveProperty("embedding");
  });

  test("test_user_dishes_exposes_side_composition_columns", () => {
    expect(schema.userDishes).toHaveProperty("role");
    expect(schema.userDishes).toHaveProperty("sideKind");
    expect(schema.userDishes).toHaveProperty("selfContained");
  });

  test("test_memory_records_exposes_pg_trgm_normalized_column", () => {
    expect(schema.memoryRecords).toHaveProperty("contentNorm");
  });

  test("test_memory_records_exposes_semantic_embedding_column", () => {
    expect(schema.memoryRecords).toHaveProperty("embedding");
  });

  test("test_daily_state_projection_persists_its_public_schema_version", () => {
    expect(schema.dailyHealthStateProjection).toHaveProperty("schemaVersion");
  });

  test("test_agent_evidence_uses_encrypted_sensitive_payload_references", () => {
    expect(schema.sensitivePayloads).toHaveProperty("ciphertext");
    expect(schema.sensitivePayloads).toHaveProperty("retentionUntil");
    expect(schema.sensitivePayloadAccessGrants).toHaveProperty("reviewerActorId");
    expect(schema.agentRuns).toHaveProperty("objectivePayloadId");
    expect(schema.agentRuns).toHaveProperty("responseSummaryPayloadId");
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

  test("test_loadFoodAliasesFromCsv_expands_alias_column_into_food_alias_rows", () => {
    const csv = [
      "slug,name,name_zh,aliases",
      "chicken_breast,Chicken breast,鸡胸脯肉,鸡胸肉|鸡胸",
      "brown_rice,Brown rice,糙米,"
    ].join("\n");

    expect(loadFoodAliasesFromCsv(csv)).toEqual([
      { slug: "chicken_breast", alias: "鸡胸肉", locale: "zh" },
      { slug: "chicken_breast", alias: "鸡胸", locale: "zh" },
    ]);
  });

  test("test_dedupeFoodLibraryRows_skips_rows_matching_curated_labels_or_aliases", () => {
    const curatedRows = loadFoodItemsFromCsv([
      "slug,name,name_zh,category,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg",
      "chicken_breast,Chicken breast,鸡胸脯肉,poultry,118,19.4,2.5,5,34.4"
    ].join("\n"));
    const curatedAliases = loadFoodAliasesFromCsv([
      "slug,name,name_zh,aliases",
      "chicken_breast,Chicken breast,鸡胸脯肉,鸡胸肉|鸡胸"
    ].join("\n"));
    const libraryRows = loadFoodItemsFromCsv([
      "slug,name_zh,name_en,category_zh,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg",
      "xlsx_1025,鸡胸脯肉,鸡胸脯肉,鸡,118,19.4,2.5,5,34.4",
      "xlsx_0545,蘑菇,蘑菇（鲜蘑）,菌类,24,2.7,4.1,0.1,8.3"
    ].join("\n"));

    const result = dedupeFoodLibraryRows(curatedRows, curatedAliases, libraryRows);

    expect(result.foodItems.map((row) => row.slug)).toEqual(["xlsx_0545"]);
    expect(result.skippedCount).toBe(1);
    expect(result.aliases).toEqual([]);
  });

  test("test_dedupeFoodLibraryRows_preserves_skipped_duplicate_allergen_tags_for_stale_refresh", () => {
    const curatedRows = loadFoodItemsFromCsv([
      "slug,name,name_zh,category,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg,allergen_tags",
      "shrimp_jiweixia,Shrimp,\u57fa\u56f4\u867e,seafood,101,18.2,3.9,1.4,172,seafood|shellfish|shrimp",
    ].join("\n"));
    const libraryRows = loadFoodItemsFromCsv([
      "slug,name_zh,name_en,category_code,category_zh,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg",
      "\u57fa\u56f4\u867e,\u57fa\u56f4\u867e,Shrimp,122,\u867e,100,18,1,1,170",
    ].join("\n"));

    const result = dedupeFoodLibraryRows(curatedRows, [], libraryRows);

    expect(result.foodItems).toEqual([]);
    expect(result).toHaveProperty("skippedFoodItems");
    expect(result.skippedFoodItems.map((row) => row.slug)).toEqual(["\u57fa\u56f4\u867e"]);
    expect(result.skippedFoodItems[0]?.allergenTags).toEqual(["seafood", "shellfish", "shrimp"]);
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

  test("test_loadFoodItemsFromCsv_infers_allergen_tags_from_chinese_library_fields", () => {
    const csv = [
      "slug,name_zh,name_en,category_code,category_zh,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg",
      "xlsx_fish,\u9c88\u9c7c,Sea bream,121,\u9c7c,100,20,0,2,60",
      "xlsx_shrimp,\u57fa\u56f4\u867e,Shrimp,122,\u867e,100,18,1,1,170",
      "xlsx_crab,\u68ad\u5b50\u87f9,Crab,123,\u87f9,100,17,1,1,240",
      "xlsx_milk,\u725b\u5976,Milk,101,\u6db2\u6001\u4e73,60,3,5,3,40",
      "xlsx_tofu,\u8c46\u8150,Tofu,031,\u5927\u8c46,80,8,3,4,10",
      "xlsx_red_bean,\u8d64\u8c46,Red bean,033,\u8d64\u8c46,324,20,63,1,12",
      "xlsx_almond,\u674f\u4ec1,Almond,071,\u6811\u575a\u679c,580,21,22,50,1",
    ].join("\n");
    const bySlug = new Map(loadFoodItemsFromCsv(csv).map((item) => [item.slug, item]));

    expect(bySlug.get("xlsx_fish")?.allergenTags).toEqual(["fish", "seafood"]);
    expect(bySlug.get("xlsx_shrimp")?.allergenTags).toEqual(["seafood", "shellfish", "shrimp"]);
    expect(bySlug.get("xlsx_crab")?.allergenTags).toEqual(["seafood", "shellfish"]);
    expect(bySlug.get("xlsx_milk")?.allergenTags).toEqual(["dairy"]);
    expect(bySlug.get("xlsx_tofu")?.allergenTags).toEqual(["soy"]);
    expect(bySlug.get("xlsx_red_bean")?.allergenTags).toEqual([]);
    expect(bySlug.get("xlsx_almond")?.allergenTags).toEqual(["nuts"]);
  });

  test("test_loadFoodItemsFromCsv_infers_shellfish_for_true_clam_names_without_category_signal", () => {
    const csv = [
      "slug,name_zh,name_en,calories_kcal,protein_g,carbs_g,fat_g,sodium_mg",
      "cfct6_124312,\u725b\u89d2\u6c5f\u73e7\u86e4,Long razor clam,59,7.1,0.5,4,5",
      "cfct6_124313,\u6587\u86e4,Orient clam,56,9.2,0.7,3.2,18",
      "cfct6_124314,\u8840\u86e4,Blood clam,51,8.2,0.5,3.3,29",
      "cfct6_124601,\u6587\u86e4\u4e38,Clam ball,211,16.2,9.2,15.8,65",
      "cfct6_219035,\u86e4\u86a7,Gecko,382,70.8,0,11,14.6",
      "cfct6_219038,\u86e4\u87c6\u6cb9,Oviductus ranae,241,31.4,24.6,1.9,3.1",
    ].join("\n");
    const bySlug = new Map(loadFoodItemsFromCsv(csv).map((item) => [item.slug, item]));

    for (const slug of ["cfct6_124312", "cfct6_124313", "cfct6_124314", "cfct6_124601"]) {
      expect(bySlug.get(slug)?.allergenTags).toEqual(["seafood", "shellfish"]);
    }
    expect(bySlug.get("cfct6_219035")?.allergenTags).toEqual([]);
    expect(bySlug.get("cfct6_219038")?.allergenTags).toEqual([]);
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
