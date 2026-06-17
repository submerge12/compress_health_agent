import type {
  NutrientTotals,
  NutritionAggregate,
  NutritionAggregateInput,
  NutritionEntry,
  NutritionRecord,
} from "./types.js";

export function aggregateNutrition(input: NutritionAggregateInput): NutritionAggregate {
  const foodTotals = aggregateEntries(input.foods, input.foodRecords, "food");
  const seasoningTotals = aggregateEntries(
    input.seasonings ?? [],
    input.seasoningRecords ?? [],
    "seasoning",
  );
  const roundedSeasonings = roundTotals(seasoningTotals);
  return {
    foods: roundTotals(foodTotals),
    seasonings: roundedSeasonings,
    total: roundTotals(addTotals(foodTotals, seasoningTotals)),
    seasoningSodiumMg: roundedSeasonings.sodiumMg,
  };
}

function aggregateEntries(
  entries: readonly NutritionEntry[],
  records: readonly NutritionRecord[],
  label: string,
): NutrientTotals {
  const totals = emptyTotals();
  for (const entry of entries) {
    validateEntry(entry);
    addScaledNutrition(totals, findRecord(entry.slug, records, label), entry.grams);
  }
  return totals;
}

function addScaledNutrition(totals: NutrientTotals, record: NutritionRecord, grams: number): void {
  const scale = grams / 100;
  totals.kcal += record.kcalPer100g * scale;
  totals.proteinGrams += record.proteinGramsPer100g * scale;
  totals.carbsGrams += record.carbsGramsPer100g * scale;
  totals.fatGrams += record.fatGramsPer100g * scale;
  totals.sodiumMg += record.sodiumMgPer100g * scale;
  addMicronutrients(totals.micronutrients, record.micronutrientsPer100g, scale);
}

function addMicronutrients(
  totals: Record<string, number>,
  micronutrients: Readonly<Record<string, number>> | undefined,
  scale: number,
): void {
  for (const [name, value] of Object.entries(micronutrients ?? {})) {
    assertNonNegativeFinite(value, `micronutrient ${name}`);
    totals[name] = (totals[name] ?? 0) + value * scale;
  }
}

function addTotals(left: NutrientTotals, right: NutrientTotals): NutrientTotals {
  const totals = emptyTotals();
  totals.kcal = left.kcal + right.kcal;
  totals.proteinGrams = left.proteinGrams + right.proteinGrams;
  totals.carbsGrams = left.carbsGrams + right.carbsGrams;
  totals.fatGrams = left.fatGrams + right.fatGrams;
  totals.sodiumMg = left.sodiumMg + right.sodiumMg;
  mergeMicronutrients(totals.micronutrients, left.micronutrients, right.micronutrients);
  return totals;
}

function mergeMicronutrients(
  target: Record<string, number>,
  left: Record<string, number>,
  right: Record<string, number>,
): void {
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    target[key] = (left[key] ?? 0) + (right[key] ?? 0);
  }
}

function roundTotals(totals: NutrientTotals): NutrientTotals {
  return {
    kcal: Math.round(totals.kcal),
    proteinGrams: roundTo(totals.proteinGrams, 1),
    carbsGrams: roundTo(totals.carbsGrams, 1),
    fatGrams: roundTo(totals.fatGrams, 1),
    sodiumMg: Math.round(totals.sodiumMg),
    micronutrients: roundMicronutrients(totals.micronutrients),
  };
}

function roundMicronutrients(micronutrients: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(micronutrients).map(([name, value]) => [name, roundTo(value, 2)]),
  );
}

function findRecord(
  slug: string,
  records: readonly NutritionRecord[],
  label: string,
): NutritionRecord {
  const record = records.find((item) => item.slug === slug);
  if (record === undefined) {
    throw new RangeError(`Unknown ${label} nutrition record: ${slug}`);
  }
  validateRecord(record, label);
  return record;
}

function validateEntry(entry: NutritionEntry): void {
  if (!entry.slug) {
    throw new RangeError("Nutrition entry slug is required");
  }
  assertNonNegativeFinite(entry.grams, "grams");
}

function validateRecord(record: NutritionRecord, label: string): void {
  assertNonNegativeFinite(record.kcalPer100g, `${label} kcalPer100g`);
  assertNonNegativeFinite(record.proteinGramsPer100g, `${label} proteinGramsPer100g`);
  assertNonNegativeFinite(record.carbsGramsPer100g, `${label} carbsGramsPer100g`);
  assertNonNegativeFinite(record.fatGramsPer100g, `${label} fatGramsPer100g`);
  assertNonNegativeFinite(record.sodiumMgPer100g, `${label} sodiumMgPer100g`);
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function emptyTotals(): NutrientTotals {
  return {
    kcal: 0,
    proteinGrams: 0,
    carbsGrams: 0,
    fatGrams: 0,
    sodiumMg: 0,
    micronutrients: {},
  };
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
