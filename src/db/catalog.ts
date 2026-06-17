import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";
import type { FoodCatalogRecord, MealCatalog } from "../tools/nutrition-estimate.js";
import type { NaturalUnitRecord } from "../engine/types.js";

type Db = PostgresJsDatabase<typeof schema>;

export async function loadMealCatalog(db: Db): Promise<MealCatalog> {
  const [foodRows, unitRows] = await Promise.all([
    db.select().from(schema.foodItems),
    db.select().from(schema.naturalUnits),
  ]);

  const foods: FoodCatalogRecord[] = foodRows.map((row) => ({
    slug: row.slug,
    name: row.nameZh ?? row.name,
    aliases: [row.name, row.nameZh].filter((v): v is string => v !== null && v !== undefined),
    defaultGrams: null,
    defaultUnit: null,
    kcalPer100g: row.caloriesKcal,
    proteinGramsPer100g: row.proteinGrams,
    carbsGramsPer100g: row.carbsGrams,
    fatGramsPer100g: row.fatGrams,
    sodiumMgPer100g: row.sodiumMg,
  }));

  const naturalUnits: NaturalUnitRecord[] = unitRows.map((row) => ({
    foodSlug: row.foodSlug,
    unit: row.unitName,
    grams: row.grams,
    aliases: row.unitNameZh ? [row.unitNameZh] : [],
  }));

  return { foods, naturalUnits };
}

export async function loadSeasoningRecords(db: Db) {
  const rows = await db.select().from(schema.seasonings);
  return rows.map((row) => ({
    slug: row.slug,
    name: row.nameZh ?? row.name,
    kcalPer100g: row.caloriesKcalPer100g,
    proteinGramsPer100g: 0,
    carbsGramsPer100g: 0,
    fatGramsPer100g: 0,
    sodiumMgPer100g: row.sodiumMgPer100g,
    servingGrams: row.servingGrams,
    servingUnit: row.servingUnit,
  }));
}
