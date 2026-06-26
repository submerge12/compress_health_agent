import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";
import type { FoodCatalogRecord, MealCatalog } from "../tools/nutrition-estimate.js";
import type { NaturalUnitRecord } from "../engine/types.js";

type Db = PostgresJsDatabase<typeof schema>;

export async function loadMealCatalog(db: Db): Promise<MealCatalog> {
  const [foodRows, aliasRows, unitRows] = await Promise.all([
    db.select().from(schema.foodItems),
    db.select().from(schema.foodAliases),
    db.select().from(schema.naturalUnits),
  ]);

  const aliasesBySlug = new Map<string, string[]>();
  for (const row of aliasRows) {
    const aliases = aliasesBySlug.get(row.slug) ?? [];
    aliases.push(row.alias);
    aliasesBySlug.set(row.slug, aliases);
  }

  const foods: FoodCatalogRecord[] = foodRows.map((row) => ({
    slug: row.slug,
    name: row.nameZh ?? row.name,
    nameZh: row.nameZh,
    executionBuckets: row.executionBuckets,
    roles: row.roles,
    weeklyFloor: row.weeklyFloor,
    aliases: uniqueLabels([
      row.name,
      row.nameZh,
      ...(aliasesBySlug.get(row.slug) ?? []),
    ]),
    category: row.category,
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

function uniqueLabels(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
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
