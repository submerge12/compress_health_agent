import { resolveNaturalPortion } from "../engine/natural-units.js";
import { aggregateNutrition } from "../engine/nutrition.js";
import type {
  FoodPortionRecord,
  NaturalUnitRecord,
  NutritionEntry,
  NutritionRecord,
} from "../engine/types.js";
import { rankFoodCandidates, type FoodMatchCandidate } from "./food-matcher.js";
import type { NutrientSnapshot } from "./store.js";

export interface FoodCatalogRecord extends FoodPortionRecord, NutritionRecord {
  name?: string;
  nameZh?: string | null;
  aliases?: readonly string[];
  category?: string | null;
  executionBuckets?: readonly string[];
  roles?: readonly string[];
  weeklyFloor?: number;
}

export interface MealCatalog {
  foods: readonly FoodCatalogRecord[];
  naturalUnits: readonly NaturalUnitRecord[];
}

export interface NutritionEstimateInput {
  description: string;
}

export interface FoodMatchCandidateSummary {
  slug: string;
  label: string;
  score: number;
}

export interface FoodResolutionDiagnostic {
  segment: string;
  candidates: FoodMatchCandidateSummary[];
}

export interface NutritionEstimateResult extends NutrientSnapshot {
  description: string;
  items: NutritionEntry[];
  needsConfirmation?: FoodResolutionDiagnostic[];
  unmatched?: FoodResolutionDiagnostic[];
}

interface MatchedFood {
  food: FoodCatalogRecord;
  label: string;
  score: number;
}

const SPLIT_PATTERN = /\s*(?:\+|,|，|、|;|；|\band\b)\s*|(?<=[一-鿿])\s+(?=\d)/;
const GRAMS_PATTERN = /(\d+(?:\.\d+)?)\s*(?:g|grams?|克)/i;
const COUNT_UNIT_PATTERN = /(\d+(?:\.\d+)?)\s*([A-Za-z\u4e00-\u9fff]+)/;
const HIGH_CONFIDENCE = 0.55;
const LOW_CONFIDENCE = 0.25;
const AMBIGUITY_DELTA = 0.001;
const CANDIDATE_LIMIT = 3;

export function nutritionEstimate(
  input: NutritionEstimateInput,
  catalog: MealCatalog,
): NutritionEstimateResult {
  const fields = requireInputObject(input, "input");
  const description = requireText(fields.description, "description");
  const resolution = resolveMealItems(description, catalog);
  const items = resolution.items;
  const aggregate = aggregateNutrition({ foods: items, foodRecords: catalog.foods });
  return {
    description,
    items,
    ...snapshotFromTotals(aggregate.total),
    ...(resolution.needsConfirmation.length > 0
      ? { needsConfirmation: resolution.needsConfirmation }
      : {}),
    ...(resolution.unmatched.length > 0
      ? { unmatched: resolution.unmatched }
      : {}),
  };
}

export function parseMealItems(description: string, catalog: MealCatalog): NutritionEntry[] {
  const resolution = resolveMealItems(description, catalog);
  if (resolution.needsConfirmation.length > 0 || resolution.unmatched.length > 0) {
    throw new RangeError("description includes ambiguous or unrecognized food");
  }
  if (resolution.items.length === 0) {
    throw new RangeError("description must include at least one recognized food");
  }
  return resolution.items;
}

export function assertNutritionEstimateResolved(result: NutritionEstimateResult): void {
  if ((result.needsConfirmation?.length ?? 0) > 0) {
    throw new RangeError("meal description needs food confirmation before logging");
  }
  if ((result.unmatched?.length ?? 0) > 0) {
    throw new RangeError("meal description includes unrecognized food");
  }
}

interface MealResolution {
  items: NutritionEntry[];
  needsConfirmation: FoodResolutionDiagnostic[];
  unmatched: FoodResolutionDiagnostic[];
}

function resolveMealItems(description: string, catalog: MealCatalog): MealResolution {
  validateCatalog(catalog);
  const safeDescription = requireText(description, "description");
  const segments = safeDescription.split(SPLIT_PATTERN).map((part) => part.trim()).filter(Boolean);
  const items: NutritionEntry[] = [];
  const needsConfirmation: FoodResolutionDiagnostic[] = [];
  const unmatched: FoodResolutionDiagnostic[] = [];

  for (const segment of segments) {
    const resolution = parseMealSegment(segment, catalog);
    if (resolution.kind === "matched") {
      items.push(resolution.item);
    } else if (resolution.kind === "needs_confirmation") {
      needsConfirmation.push({ segment, candidates: resolution.candidates });
    } else {
      unmatched.push({ segment, candidates: resolution.candidates });
    }
  }

  return { items, needsConfirmation, unmatched };
}

type SegmentResolution =
  | { kind: "matched"; item: NutritionEntry }
  | { kind: "needs_confirmation"; candidates: FoodMatchCandidateSummary[] }
  | { kind: "unmatched"; candidates: FoodMatchCandidateSummary[] };

function parseMealSegment(segment: string, catalog: MealCatalog): SegmentResolution {
  const candidates = rankFoodCandidates(segment, catalog, CANDIDATE_LIMIT);
  const match = selectFoodMatch(candidates);
  if (match.kind !== "matched") return match;

  try {
    const portion = extractPortion(segment, match.label);
    const resolved = resolveNaturalPortion(portion, match.food, catalog.naturalUnits);
    return { kind: "matched", item: { slug: match.food.slug, grams: resolved.grams } };
  } catch {
    return { kind: "unmatched", candidates: summarizeCandidates(candidates) };
  }
}

function selectFoodMatch(candidates: readonly FoodMatchCandidate[]): ({ kind: "matched" } & MatchedFood)
  | { kind: "needs_confirmation"; candidates: FoodMatchCandidateSummary[] }
  | { kind: "unmatched"; candidates: FoodMatchCandidateSummary[] } {
  const [best, second] = candidates;
  const summaries = summarizeCandidates(candidates);
  if (best === undefined || best.score < LOW_CONFIDENCE) {
    return { kind: "unmatched", candidates: summaries };
  }
  if (best.score < HIGH_CONFIDENCE || isAmbiguous(best, second)) {
    return { kind: "needs_confirmation", candidates: summaries };
  }
  return { kind: "matched", food: best.food, label: best.label, score: best.score };
}

function summarizeCandidates(candidates: readonly FoodMatchCandidate[]): FoodMatchCandidateSummary[] {
  return candidates.slice(0, CANDIDATE_LIMIT).map((candidate) => ({
    slug: candidate.food.slug,
    label: candidate.label,
    score: candidate.score,
  }));
}

function isAmbiguous(best: FoodMatchCandidate, second: FoodMatchCandidate | undefined): boolean {
  return second !== undefined && best.score - second.score <= AMBIGUITY_DELTA;
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
