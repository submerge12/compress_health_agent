import { readFile } from "node:fs/promises";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as dbSchema from "./schema.js";
import { foodItems, naturalUnits, seasonings } from "./schema.js";

export type CsvRow = Record<string, string>;

export interface NutritionSeed {
  caloriesKcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  fiberGrams: number;
  sugarGrams: number;
  sodiumMg: number;
  potassiumMg: number;
  calciumMg: number;
  ironMg: number;
  magnesiumMg: number;
  zincMg: number;
  vitaminAMcg: number;
  vitaminCMg: number;
  vitaminDMcg: number;
  vitaminB12Mcg: number;
  folateMcg: number;
  cholesterolMg: number;
}

export interface FoodItemSeed extends NutritionSeed {
  slug: string;
  name: string;
  nameZh?: string;
  category?: string;
  executionBuckets: string[];
  roles: string[];
  weeklyFloor: number;
  source: string;
}

export interface SeasoningSeed {
  slug: string;
  name: string;
  nameZh?: string;
  servingUnit: string;
  servingGrams: number;
  sodiumMgPerServing: number;
  sodiumMgPer100g: number;
  caloriesKcalPer100g: number;
  sugarGramsPer100g: number;
  notes?: string;
}

export interface NaturalUnitSeed {
  foodSlug: string;
  unitName: string;
  unitNameZh?: string;
  grams: number;
  isDefault: boolean;
}

export interface SeedCsvBundle {
  foodItems?: string;
  seasonings?: string;
  naturalUnits?: string;
}

export interface SeedCsvPaths {
  foodItemsPath?: string;
  seasoningsPath?: string;
  naturalUnitsPath?: string;
}

export interface SeedCounts {
  foodItems: number;
  seasonings: number;
  naturalUnits: number;
}

export type SeedDatabase = PostgresJsDatabase<typeof dbSchema>;

export function parseCsv(input: string): CsvRow[] {
  const rawRows = tokenizeCsv(input);
  if (rawRows.length === 0) {
    return [];
  }

  const headerRow = rawRows[0];
  if (headerRow === undefined) {
    return [];
  }

  const dataRows = rawRows.slice(1);
  const headers = headerRow.map((header: string) => header.trim().replace(/^\uFEFF/, ""));
  if (headers.every((header: string) => header === "")) {
    return [];
  }

  return dataRows
    .filter((row: string[]) => row.some((cell: string) => cell.trim() !== ""))
    .map((row: string[]) => rowToObject(headers, row));
}

function tokenizeCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);
    const nextChar = input.charAt(index + 1);

    if (char === "\"" && inQuotes && nextChar === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
      inQuotes = !inQuotes;
    } else if (!inQuotes && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!inQuotes && (char === "\n" || char === "\r")) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function rowToObject(headers: string[], row: string[]): CsvRow {
  return headers.reduce<CsvRow>((result: CsvRow, header: string, index: number) => {
    result[header] = row[index]?.trim() ?? "";
    return result;
  }, {});
}

function optionalText(row: CsvRow, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }

  return undefined;
}

function requiredText(row: CsvRow, aliases: string[], label: string): string {
  const value = optionalText(row, aliases);
  if (value === undefined) {
    throw new Error(`CSV row is missing required ${label}`);
  }

  return value;
}

function optionalNumber(row: CsvRow, aliases: string[]): number | undefined {
  const value = optionalText(row, aliases);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(parsed)) {
    throw new Error(`CSV value for ${aliases[0] ?? "value"} must be numeric`);
  }

  return parsed;
}

function numberValue(row: CsvRow, aliases: string[], fallback: number): number {
  return optionalNumber(row, aliases) ?? fallback;
}

function booleanValue(row: CsvRow, aliases: string[], fallback: boolean): boolean {
  const value = optionalText(row, aliases);
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function listValue(row: CsvRow, aliases: string[]): string[] | undefined {
  const value = optionalText(row, aliases);
  if (value === undefined) return undefined;
  return value
    .split(/[|;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function nutritionFromRow(row: CsvRow): NutritionSeed {
  return {
    caloriesKcal: numberValue(row, ["energy_kcal", "calories_kcal", "kcal"], 0),
    proteinGrams: numberValue(row, ["protein_g", "protein_grams", "protein"], 0),
    carbsGrams: numberValue(row, ["carbohydrate_g", "carbs_grams", "carbs_g"], 0),
    fatGrams: numberValue(row, ["fat_g", "fat_grams", "fat"], 0),
    fiberGrams: numberValue(row, ["dietary_fiber_g", "fiber_grams", "fiber_g"], 0),
    sugarGrams: numberValue(row, ["sugar_grams", "sugar_g", "sugar"], 0),
    sodiumMg: numberValue(row, ["sodium_mg", "sodium"], 0),
    potassiumMg: numberValue(row, ["potassium_mg", "potassium"], 0),
    calciumMg: numberValue(row, ["calcium_mg", "calcium"], 0),
    ironMg: numberValue(row, ["iron_mg", "iron"], 0),
    magnesiumMg: numberValue(row, ["magnesium_mg", "magnesium"], 0),
    zincMg: numberValue(row, ["zinc_mg", "zinc"], 0),
    vitaminAMcg: numberValue(row, ["vitamin_a_ug_re", "vitamin_a_mcg", "vitamin_a"], 0),
    vitaminCMg: numberValue(row, ["vitamin_c_mg", "vitamin_c"], 0),
    vitaminDMcg: numberValue(row, ["vitamin_d_mcg", "vitamin_d"], 0),
    vitaminB12Mcg: numberValue(row, ["vitamin_b12_mcg", "vitamin_b12"], 0),
    folateMcg: numberValue(row, ["folate_mcg", "folate"], 0),
    cholesterolMg: numberValue(row, ["cholesterol_mg", "cholesterol"], 0)
  };
}

function toFoodItemSeed(row: CsvRow): FoodItemSeed {
  const slug = requiredText(row, ["slug", "food_slug"], "food slug");
  const category = optionalText(row, ["category_en", "category", "group"]);
  const defaults = defaultFoodClassification(slug, category);

  return {
    slug,
    name: optionalText(row, ["name_en", "name", "food_name"]) ?? slug,
    nameZh: optionalText(row, ["name_zh", "zh_name"]),
    category,
    executionBuckets: listValue(row, ["execution_buckets", "buckets"]) ?? defaults.executionBuckets,
    roles: listValue(row, ["roles", "execution_roles"]) ?? defaults.roles,
    weeklyFloor: numberValue(row, ["weekly_floor"], defaults.weeklyFloor),
    source: optionalText(row, ["source", "basis"]) ?? "csv",
    ...nutritionFromRow(row)
  };
}

function defaultFoodClassification(
  slug: string,
  category: string | undefined,
): Pick<FoodItemSeed, "executionBuckets" | "roles" | "weeklyFloor"> {
  if (["beef_tenderloin", "pork_lean"].includes(slug)) {
    return { executionBuckets: ["red_meat"], roles: ["iron", "zinc", "b12"], weeklyFloor: 2 };
  }
  if (["chicken_breast", "chicken_thigh"].includes(slug)) {
    return { executionBuckets: ["lean_white_meat"], roles: ["b12"], weeklyFloor: 0 };
  }
  if (["salmon", "cod", "mackerel", "sardine", "hairtail", "sea_bream"].includes(slug)) {
    return { executionBuckets: ["deep_sea_fish"], roles: ["omega3", "vitamin_d"], weeklyFloor: 2 };
  }
  if (["shrimp_jiweixia"].includes(slug)) {
    return { executionBuckets: ["shellfish"], roles: ["zinc", "b12"], weeklyFloor: 1 };
  }
  if (slug === "tofu" || category === "legume") {
    return { executionBuckets: ["soy_product"], roles: [], weeklyFloor: 0 };
  }
  if (slug === "egg" || category === "egg") {
    return { executionBuckets: ["egg"], roles: ["b12"], weeklyFloor: 0 };
  }
  if (category === "dairy") {
    return { executionBuckets: ["dairy"], roles: [], weeklyFloor: 0 };
  }
  if (category === "vegetable" || category === "mushroom" || category === "seaweed") {
    return { executionBuckets: ["vegetable"], roles: [], weeklyFloor: 0 };
  }
  if (category === "grain" || category === "bread" || category === "tuber") {
    return { executionBuckets: ["staple"], roles: [], weeklyFloor: 0 };
  }
  return { executionBuckets: [], roles: [], weeklyFloor: 0 };
}

function toSeasoningSeed(row: CsvRow): SeasoningSeed {
  const slug = requiredText(row, ["slug", "seasoning_slug"], "seasoning slug");
  const servingGrams = numberValue(row, ["typical_serving_g", "serving_grams", "grams_per_serving"], 1);
  const sodiumPerServing = optionalNumber(row, ["sodium_mg_per_serving"]);
  const sodiumPer100g = optionalNumber(row, ["sodium_mg", "sodium_mg_per_100g"]);

  return {
    slug,
    name: optionalText(row, ["name_en", "name", "seasoning_name"]) ?? slug,
    nameZh: optionalText(row, ["name_zh", "zh_name"]),
    servingUnit: optionalText(row, ["typical_serving_unit_en", "serving_unit", "unit"]) ?? "g",
    servingGrams,
    sodiumMgPerServing: sodiumPerServing ?? sodiumFromPer100g(sodiumPer100g, servingGrams),
    sodiumMgPer100g: sodiumPer100g ?? sodiumFromServing(sodiumPerServing, servingGrams),
    caloriesKcalPer100g: numberValue(row, ["energy_kcal", "calories_kcal_per_100g", "kcal_per_100g"], 0),
    sugarGramsPer100g: numberValue(row, ["sugar_grams_per_100g", "sugar_g_per_100g"], 0),
    notes: optionalText(row, ["notes"])
  };
}

function toNaturalUnitSeed(row: CsvRow): NaturalUnitSeed {
  return {
    foodSlug: requiredText(row, ["ingredient_slug", "food_slug", "slug"], "food slug"),
    unitName: requiredText(row, ["unit_en", "unit_name", "unit"], "unit name"),
    unitNameZh: optionalText(row, ["unit_zh", "unit_name_zh", "zh_unit"]),
    grams: numberValue(row, ["grams_per_unit", "grams", "gram_weight"], 0),
    isDefault: booleanValue(row, ["is_default", "default"], false)
  };
}

function sodiumFromPer100g(sodiumPer100g: number | undefined, servingGrams: number): number {
  return sodiumPer100g === undefined ? 0 : (sodiumPer100g * servingGrams) / 100;
}

function sodiumFromServing(sodiumPerServing: number | undefined, servingGrams: number): number {
  if (sodiumPerServing === undefined || servingGrams <= 0) {
    return 0;
  }

  return (sodiumPerServing / servingGrams) * 100;
}

export function loadFoodItemsFromCsv(csv: string): FoodItemSeed[] {
  return parseCsv(csv)
    .map(toFoodItemSeed)
    .sort((left: FoodItemSeed, right: FoodItemSeed) => left.slug.localeCompare(right.slug));
}

export function loadSeasoningsFromCsv(csv: string): SeasoningSeed[] {
  return parseCsv(csv)
    .map(toSeasoningSeed)
    .sort((left: SeasoningSeed, right: SeasoningSeed) => left.slug.localeCompare(right.slug));
}

export function loadNaturalUnitsFromCsv(csv: string): NaturalUnitSeed[] {
  return parseCsv(csv)
    .map(toNaturalUnitSeed)
    .sort((left: NaturalUnitSeed, right: NaturalUnitSeed) => {
      const foodOrder = left.foodSlug.localeCompare(right.foodSlug);
      return foodOrder === 0 ? left.unitName.localeCompare(right.unitName) : foodOrder;
    });
}

export async function readCsvFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function seedReferenceData(database: SeedDatabase, csv: SeedCsvBundle): Promise<SeedCounts> {
  const foodRows = csv.foodItems === undefined ? [] : loadFoodItemsFromCsv(csv.foodItems);
  const seasoningRows = csv.seasonings === undefined ? [] : loadSeasoningsFromCsv(csv.seasonings);
  const unitRows = csv.naturalUnits === undefined ? [] : loadNaturalUnitsFromCsv(csv.naturalUnits);

  await insertFoodItems(database, foodRows);
  await insertSeasonings(database, seasoningRows);
  await insertNaturalUnits(database, unitRows);

  return {
    foodItems: foodRows.length,
    seasonings: seasoningRows.length,
    naturalUnits: unitRows.length
  };
}

export async function seedReferenceDataFromFiles(database: SeedDatabase, paths: SeedCsvPaths): Promise<SeedCounts> {
  return seedReferenceData(database, {
    foodItems: paths.foodItemsPath === undefined ? undefined : await readCsvFile(paths.foodItemsPath),
    seasonings: paths.seasoningsPath === undefined ? undefined : await readCsvFile(paths.seasoningsPath),
    naturalUnits: paths.naturalUnitsPath === undefined ? undefined : await readCsvFile(paths.naturalUnitsPath)
  });
}

async function insertFoodItems(database: SeedDatabase, rows: FoodItemSeed[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await database.insert(foodItems).values(rows).onConflictDoNothing();
}

async function insertSeasonings(database: SeedDatabase, rows: SeasoningSeed[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await database.insert(seasonings).values(rows).onConflictDoNothing();
}

async function insertNaturalUnits(database: SeedDatabase, rows: NaturalUnitSeed[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await database.insert(naturalUnits).values(rows).onConflictDoNothing();
}
