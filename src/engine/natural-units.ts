import type { FoodPortionRecord, NaturalUnitRecord, ResolvedPortion } from "./types.js";

const GRAMS_PATTERN = /^(\d+(?:\.\d+)?)\s*(?:g|克)$/i;
const COUNT_UNIT_PATTERN = /^(\d+(?:\.\d+)?)\s*(.+)$/;

export function resolveNaturalPortion(
  portion: string | null | undefined,
  food: FoodPortionRecord,
  unitRecords: readonly NaturalUnitRecord[],
): ResolvedPortion {
  const normalized = portion?.trim();
  if (!normalized) {
    return resolveDefaultPortion(food);
  }

  const gramsMatch = normalized.match(GRAMS_PATTERN);
  if (gramsMatch) {
    const [, gramsText] = gramsMatch;
    if (gramsText === undefined) {
      throw new RangeError(`Could not parse portion: ${normalized}`);
    }
    const grams = parsePositiveNumber(gramsText, "grams");
    return { grams, quantity: grams, unit: "g", source: "grams" };
  }

  const unitMatch = normalized.match(COUNT_UNIT_PATTERN);
  if (!unitMatch) {
    throw new RangeError(`Could not parse portion: ${normalized}`);
  }
  const [, quantityText, unitText] = unitMatch;
  if (quantityText === undefined || unitText === undefined) {
    throw new RangeError(`Could not parse portion: ${normalized}`);
  }
  return resolveCountedUnit(quantityText, unitText.trim(), food, unitRecords);
}

function resolveDefaultPortion(food: FoodPortionRecord): ResolvedPortion {
  if (food.defaultGrams === undefined || food.defaultGrams === null) {
    throw new RangeError(`Food has no default portion: ${food.slug}`);
  }
  const grams = assertPositiveNumber(food.defaultGrams, "defaultGrams");
  return {
    grams,
    quantity: 1,
    unit: food.defaultUnit ?? "portion",
    source: "default_portion",
  };
}

function resolveCountedUnit(
  quantityText: string,
  unit: string,
  food: FoodPortionRecord,
  unitRecords: readonly NaturalUnitRecord[],
): ResolvedPortion {
  const quantity = parsePositiveNumber(quantityText, "quantity");
  const record = findUnitRecord(food.slug, unit, unitRecords);
  if (record === undefined) {
    throw new RangeError(`Unknown unit "${unit}" for food: ${food.slug}`);
  }
  return {
    grams: roundTo(quantity * record.grams, 3),
    quantity,
    unit: record.unit,
    source: "natural_unit",
  };
}

function findUnitRecord(
  foodSlug: string,
  unit: string,
  unitRecords: readonly NaturalUnitRecord[],
): NaturalUnitRecord | undefined {
  return unitRecords.find((record) => {
    const aliases = record.aliases ?? [];
    return record.foodSlug === foodSlug && (record.unit === unit || aliases.includes(unit));
  });
}

function parsePositiveNumber(value: string, name: string): number {
  return assertPositiveNumber(Number(value), name);
}

function assertPositiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
