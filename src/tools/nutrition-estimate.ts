import { resolveNaturalPortion } from "../engine/natural-units.js";
import { aggregateNutrition } from "../engine/nutrition.js";
import type {
  FoodPortionRecord,
  NaturalUnitRecord,
  NutritionEntry,
  NutritionRecord,
} from "../engine/types.js";
import type { NutrientSnapshot } from "./store.js";

export interface FoodCatalogRecord extends FoodPortionRecord, NutritionRecord {
  name?: string;
  aliases?: readonly string[];
}

export interface MealCatalog {
  foods: readonly FoodCatalogRecord[];
  naturalUnits: readonly NaturalUnitRecord[];
}

export interface NutritionEstimateInput {
  description: string;
}

export interface NutritionEstimateResult extends NutrientSnapshot {
  description: string;
  items: NutritionEntry[];
}

interface MatchedFood {
  food: FoodCatalogRecord;
  label: string;
}

const SPLIT_PATTERN = /\s*(?:\+|,|，|、|;|；|\band\b)\s*|(?<=[一-鿿])\s+(?=\d)/;
const GRAMS_PATTERN = /(\d+(?:\.\d+)?)\s*(?:g|grams?|克)/i;
const COUNT_UNIT_PATTERN = /(\d+(?:\.\d+)?)\s*([A-Za-z\u4e00-\u9fff]+)/;

export function nutritionEstimate(
  input: NutritionEstimateInput,
  catalog: MealCatalog,
): NutritionEstimateResult {
  const fields = requireInputObject(input, "input");
  const description = requireText(fields.description, "description");
  const items = parseMealItems(description, catalog);
  const aggregate = aggregateNutrition({ foods: items, foodRecords: catalog.foods });
  return { description, items, ...snapshotFromTotals(aggregate.total) };
}

export function parseMealItems(description: string, catalog: MealCatalog): NutritionEntry[] {
  validateCatalog(catalog);
  const safeDescription = requireText(description, "description");
  const segments = safeDescription.split(SPLIT_PATTERN).map((part) => part.trim()).filter(Boolean);
  const items: NutritionEntry[] = [];
  for (const segment of segments) {
    const entry = parseMealSegment(segment, catalog);
    if (entry) items.push(entry);
  }
  if (items.length === 0) {
    throw new RangeError("description must include at least one recognized food");
  }
  return items;
}

function parseMealSegment(segment: string, catalog: MealCatalog): NutritionEntry | undefined {
  const match = findFood(segment, catalog.foods);
  if (match === undefined) return undefined;
  try {
    const portion = extractPortion(segment, match.label);
    const resolved = resolveNaturalPortion(portion, match.food, catalog.naturalUnits);
    return { slug: match.food.slug, grams: resolved.grams };
  } catch {
    return undefined;
  }
}

function findFood(segment: string, foods: readonly FoodCatalogRecord[]): MatchedFood | undefined {
  const lowered = segment.toLocaleLowerCase();
  for (const food of foods) {
    const label = labelsFor(food).find((candidate) => lowered.includes(candidate.toLocaleLowerCase()));
    if (label !== undefined) {
      return { food, label };
    }
  }
  return undefined;
}

function labelsFor(food: FoodCatalogRecord): string[] {
  return [food.name, food.slug.replace(/_/g, " "), food.slug, ...(food.aliases ?? [])]
    .filter((label): label is string => Boolean(label?.trim()))
    .sort((left, right) => right.length - left.length);
}

function extractPortion(segment: string, label: string): string | null {
  const withoutFood = segment.replace(new RegExp(escapePattern(label), "i"), " ").trim();
  const grams = withoutFood.match(GRAMS_PATTERN);
  if (grams !== null) {
    return `${grams[1]}g`;
  }
  const counted = withoutFood.match(COUNT_UNIT_PATTERN);
  if (counted !== null) {
    return `${counted[1]}${counted[2]}`;
  }
  return null;
}

function snapshotFromTotals(total: NutrientSnapshot): NutrientSnapshot {
  return {
    kcal: total.kcal,
    proteinGrams: total.proteinGrams,
    carbsGrams: total.carbsGrams,
    fatGrams: total.fatGrams,
    sodiumMg: total.sodiumMg,
    micronutrients: { ...total.micronutrients },
  };
}

function validateCatalog(catalog: MealCatalog): void {
  if (catalog.foods.length === 0) {
    throw new RangeError("food catalog must not be empty");
  }
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new RangeError(`${name} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RangeError(`${name} is required`);
  }
  return trimmed;
}

function requireInputObject(value: NutritionEstimateInput, name: string): Record<string, unknown> {
  const candidate: unknown = value;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new RangeError(`${name} must be an object`);
  }
  return candidate as Record<string, unknown>;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
