import { resolveNaturalPortion } from "../engine/natural-units.js";
import { aggregateNutrition } from "../engine/nutrition.js";
import type { EmbeddingClient } from "../embeddings/client.js";
import type {
  FoodPortionRecord,
  NaturalUnitRecord,
  NutritionEntry,
  NutritionWeightType,
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
  allergenTags?: readonly string[];
  weightType?: NutritionWeightType;
  frequencyHint?: string | null;
  cookingDifficulty?: string | null;
  availability?: string | null;
  specialHandlingTags?: readonly string[];
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

export interface WeightBasisDiagnostic {
  segment: string;
  slug: string;
  expectedWeightType: NutritionWeightType;
  message: string;
}

export interface FallbackEstimateDiagnostic {
  segment: string;
  grams: number;
  kcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
  confidence: "low";
  assumption: string;
}

export interface NutritionEstimateResult extends NutrientSnapshot {
  description: string;
  items: NutritionEntry[];
  needsConfirmation?: FoodResolutionDiagnostic[];
  unmatched?: FoodResolutionDiagnostic[];
  basisWarnings?: WeightBasisDiagnostic[];
  fallbackEstimates?: FallbackEstimateDiagnostic[];
  uncertain?: boolean;
}

export interface NutritionResolutionOptions {
  requireWeightBasis?: boolean;
}

export interface SemanticFoodCandidate {
  slug: string;
  score: number;
  label?: string;
}

export interface SemanticFoodSearch {
  findFoodCandidatesByEmbedding(
    queryEmbedding: readonly number[],
    limit: number,
  ): Promise<SemanticFoodCandidate[]>;
}

export interface SemanticNutritionResolutionOptions {
  embeddingClient: EmbeddingClient;
  semanticSearch: SemanticFoodSearch;
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
export const FALLBACK_FOOD_SLUG = "unknown_food";
const FALLBACK_DEFAULT_GRAMS = 350;
const FALLBACK_NUTRITION_PER_100G = {
  kcal: 180,
  proteinGrams: 8,
  carbsGrams: 18,
  fatGrams: 8,
  sodiumMg: 600,
};
const FALLBACK_GRAMS_PATTERN = /(\d+(?:\.\d+)?)\s*(?:g|grams?|\u514b)/i;

export function nutritionEstimate(
  input: NutritionEstimateInput,
  catalog: MealCatalog,
): NutritionEstimateResult {
  const fields = requireInputObject(input, "input");
  const description = requireText(fields.description, "description");
  const resolution = resolveMealItems(description, catalog);
  return nutritionEstimateFromResolution(description, catalog, resolution);
}

export async function nutritionEstimateWithSemanticFallback(
  input: NutritionEstimateInput,
  catalog: MealCatalog,
  options: SemanticNutritionResolutionOptions,
): Promise<NutritionEstimateResult> {
  const fields = requireInputObject(input, "input");
  const description = requireText(fields.description, "description");
  const resolution = await resolveMealItemsWithSemanticFallback(description, catalog, options);
  return nutritionEstimateFromResolution(description, catalog, resolution);
}

export function parseMealItems(
  description: string,
  catalog: MealCatalog,
  options: NutritionResolutionOptions = {},
): NutritionEntry[] {
  const resolution = resolveMealItems(description, catalog);
  if (resolution.needsConfirmation.length > 0 || resolution.unmatched.length > 0) {
    throw new RangeError("description includes ambiguous or unrecognized food");
  }
  if (options.requireWeightBasis === true && resolution.basisWarnings.length > 0) {
    throw new RangeError("description needs weight basis confirmation");
  }
  if (resolution.items.length === 0) {
    throw new RangeError("description must include at least one recognized food");
  }
  return resolution.items;
}

export async function parseMealItemsWithSemanticFallback(
  description: string,
  catalog: MealCatalog,
  semanticOptions: SemanticNutritionResolutionOptions,
  options: NutritionResolutionOptions = {},
): Promise<NutritionEntry[]> {
  const resolution = await resolveMealItemsWithSemanticFallback(description, catalog, semanticOptions);
  if (resolution.needsConfirmation.length > 0 || resolution.unmatched.length > 0) {
    throw new RangeError("description includes ambiguous or unrecognized food");
  }
  if (options.requireWeightBasis === true && resolution.basisWarnings.length > 0) {
    throw new RangeError("description needs weight basis confirmation");
  }
  if (resolution.items.length === 0) {
    throw new RangeError("description must include at least one recognized food");
  }
  return resolution.items;
}

export function assertNutritionEstimateResolved(
  result: NutritionEstimateResult,
  options: NutritionResolutionOptions = {},
): void {
  if ((result.needsConfirmation?.length ?? 0) > 0) {
    throw new RangeError("meal description needs food confirmation before logging");
  }
  const unmatchedCount = result.unmatched?.length ?? 0;
  const fallbackCount = result.fallbackEstimates?.length ?? 0;
  if (unmatchedCount > fallbackCount) {
    throw new RangeError("meal description includes unrecognized food");
  }
  if (options.requireWeightBasis === true && (result.basisWarnings?.length ?? 0) > 0) {
    throw new RangeError("meal description needs weight basis confirmation before logging");
  }
}

interface MealResolution {
  items: NutritionEntry[];
  needsConfirmation: FoodResolutionDiagnostic[];
  unmatched: FoodResolutionDiagnostic[];
  basisWarnings: WeightBasisDiagnostic[];
}

function resolveMealItems(description: string, catalog: MealCatalog): MealResolution {
  validateCatalog(catalog);
  const safeDescription = requireText(description, "description");
  const segments = safeDescription.split(SPLIT_PATTERN).map((part) => part.trim()).filter(Boolean);
  const items: NutritionEntry[] = [];
  const needsConfirmation: FoodResolutionDiagnostic[] = [];
  const unmatched: FoodResolutionDiagnostic[] = [];
  const basisWarnings: WeightBasisDiagnostic[] = [];

  for (const segment of segments) {
    const resolution = parseMealSegment(segment, catalog);
    if (resolution.kind === "matched") {
      items.push(resolution.item);
      if (resolution.basisWarning !== undefined) {
        basisWarnings.push(resolution.basisWarning);
      }
    } else if (resolution.kind === "needs_confirmation") {
      needsConfirmation.push({ segment, candidates: resolution.candidates });
    } else {
      unmatched.push({ segment, candidates: resolution.candidates });
    }
  }

  return { items, needsConfirmation, unmatched, basisWarnings };
}

async function resolveMealItemsWithSemanticFallback(
  description: string,
  catalog: MealCatalog,
  options: SemanticNutritionResolutionOptions,
): Promise<MealResolution> {
  validateCatalog(catalog);
  const safeDescription = requireText(description, "description");
  const segments = safeDescription.split(SPLIT_PATTERN).map((part) => part.trim()).filter(Boolean);
  const items: NutritionEntry[] = [];
  const needsConfirmation: FoodResolutionDiagnostic[] = [];
  const unmatched: FoodResolutionDiagnostic[] = [];
  const basisWarnings: WeightBasisDiagnostic[] = [];

  for (const segment of segments) {
    const resolution = await parseMealSegmentWithSemanticFallback(segment, catalog, options);
    if (resolution.kind === "matched") {
      items.push(resolution.item);
      if (resolution.basisWarning !== undefined) {
        basisWarnings.push(resolution.basisWarning);
      }
    } else if (resolution.kind === "needs_confirmation") {
      needsConfirmation.push({ segment, candidates: resolution.candidates });
    } else {
      unmatched.push({ segment, candidates: resolution.candidates });
    }
  }

  return { items, needsConfirmation, unmatched, basisWarnings };
}

type SegmentResolution =
  | { kind: "matched"; item: NutritionEntry; basisWarning?: WeightBasisDiagnostic }
  | { kind: "needs_confirmation"; candidates: FoodMatchCandidateSummary[] }
  | { kind: "unmatched"; candidates: FoodMatchCandidateSummary[] };

function parseMealSegment(segment: string, catalog: MealCatalog): SegmentResolution {
  const candidates = rankFoodCandidates(segment, catalog, CANDIDATE_LIMIT);
  const match = selectFoodMatch(candidates);
  if (match.kind !== "matched") return match;

  try {
    const portion = extractPortion(segment, match.label);
    const resolved = resolveNaturalPortion(portion, match.food, catalog.naturalUnits);
    return {
      kind: "matched",
      item: { slug: match.food.slug, grams: resolved.grams },
      basisWarning: basisWarningForSegment(segment, match.food, resolved.source),
    };
  } catch {
    return { kind: "unmatched", candidates: summarizeCandidates(candidates) };
  }
}

async function parseMealSegmentWithSemanticFallback(
  segment: string,
  catalog: MealCatalog,
  options: SemanticNutritionResolutionOptions,
): Promise<SegmentResolution> {
  let candidates = rankFoodCandidates(segment, catalog, CANDIDATE_LIMIT);
  const [bestLexical] = candidates;
  if (bestLexical === undefined || bestLexical.score < LOW_CONFIDENCE) {
    const semanticCandidates = await rankSemanticFoodCandidates(segment, catalog, options);
    if (semanticCandidates.length > 0) {
      candidates = semanticCandidates;
    }
  }

  const match = selectFoodMatch(candidates);
  if (match.kind !== "matched") return match;

  try {
    const portion = extractPortion(segment, match.label);
    const resolved = resolveNaturalPortion(portion, match.food, catalog.naturalUnits);
    return {
      kind: "matched",
      item: { slug: match.food.slug, grams: resolved.grams },
      basisWarning: basisWarningForSegment(segment, match.food, resolved.source),
    };
  } catch {
    return { kind: "unmatched", candidates: summarizeCandidates(candidates) };
  }
}

async function rankSemanticFoodCandidates(
  segment: string,
  catalog: MealCatalog,
  options: SemanticNutritionResolutionOptions,
): Promise<FoodMatchCandidate[]> {
  const [queryEmbedding] = await options.embeddingClient.embed([segment]);
  if (queryEmbedding === undefined) return [];
  const foodsBySlug = new Map(catalog.foods.map((food) => [food.slug, food]));
  const rows = await options.semanticSearch.findFoodCandidatesByEmbedding(queryEmbedding, CANDIDATE_LIMIT);

  const candidates: FoodMatchCandidate[] = [];
  for (const row of rows) {
    const food = foodsBySlug.get(row.slug);
    if (food === undefined || row.score <= 0) continue;
    candidates.push({
        food,
        label: row.label ?? displayLabelForFood(food),
        score: roundScore(row.score),
        matchType: "semantic" as const,
    });
  }

  return candidates.sort((left, right) => right.score - left.score || left.food.slug.localeCompare(right.food.slug));
}

function basisWarningForSegment(
  segment: string,
  food: FoodCatalogRecord,
  source: ReturnType<typeof resolveNaturalPortion>["source"],
): WeightBasisDiagnostic | undefined {
  if (food.weightType !== "dry" || hasDryBasisCue(segment)) {
    return undefined;
  }
  const portionSource = source === "natural_unit" ? "natural unit" : source.replaceAll("_", " ");
  return {
    segment,
    slug: food.slug,
    expectedWeightType: "dry",
    message: `${food.slug} nutrition is stored on a dry-weight basis; confirm the ${portionSource} is dry weight or provide cooked conversion`,
  };
}

function hasDryBasisCue(segment: string): boolean {
  return /\b(?:dry|raw|uncooked)\b/i.test(segment) ||
    /[\u5e72\u751f][\u91cd\u7684]?/.test(segment);
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

function nutritionEstimateFromResolution(
  description: string,
  catalog: MealCatalog,
  resolution: MealResolution,
): NutritionEstimateResult {
  const items = resolution.items;
  const aggregate = aggregateNutrition({ foods: items, foodRecords: catalog.foods, requireWeightType: true });
  const fallbackEstimates = resolution.unmatched.map(fallbackEstimateForSegment);
  const totals = addSnapshots(snapshotFromTotals(aggregate.total), snapshotFromFallbackEstimates(fallbackEstimates));
  return {
    description,
    items,
    ...totals,
    ...(resolution.needsConfirmation.length > 0
      ? { needsConfirmation: resolution.needsConfirmation }
      : {}),
    ...(resolution.unmatched.length > 0
      ? { unmatched: resolution.unmatched }
      : {}),
    ...(resolution.basisWarnings.length > 0
      ? { basisWarnings: resolution.basisWarnings }
      : {}),
    ...(fallbackEstimates.length > 0
      ? { fallbackEstimates, uncertain: true }
      : {}),
  };
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

function fallbackEstimateForSegment(diagnostic: FoodResolutionDiagnostic): FallbackEstimateDiagnostic {
  const grams = fallbackGrams(diagnostic.segment);
  const scale = grams / 100;
  return {
    segment: diagnostic.segment,
    grams,
    kcal: Math.round(FALLBACK_NUTRITION_PER_100G.kcal * scale),
    proteinGrams: roundTo(FALLBACK_NUTRITION_PER_100G.proteinGrams * scale, 1),
    carbsGrams: roundTo(FALLBACK_NUTRITION_PER_100G.carbsGrams * scale, 1),
    fatGrams: roundTo(FALLBACK_NUTRITION_PER_100G.fatGrams * scale, 1),
    sodiumMg: Math.round(FALLBACK_NUTRITION_PER_100G.sodiumMg * scale),
    confidence: "low",
    assumption: "Conservative generic meal estimate; refine when the food can be identified.",
  };
}

function fallbackGrams(segment: string): number {
  const grams = segment.match(FALLBACK_GRAMS_PATTERN);
  if (grams !== null) {
    return Math.max(1, Math.round(Number(grams[1])));
  }
  return FALLBACK_DEFAULT_GRAMS;
}

function snapshotFromFallbackEstimates(estimates: readonly FallbackEstimateDiagnostic[]): NutrientSnapshot {
  return estimates.reduce<NutrientSnapshot>((total, estimate) => addSnapshots(total, {
    kcal: estimate.kcal,
    proteinGrams: estimate.proteinGrams,
    carbsGrams: estimate.carbsGrams,
    fatGrams: estimate.fatGrams,
    sodiumMg: estimate.sodiumMg,
    micronutrients: {},
  }), zeroSnapshot());
}

function addSnapshots(left: NutrientSnapshot, right: NutrientSnapshot): NutrientSnapshot {
  return {
    kcal: left.kcal + right.kcal,
    proteinGrams: roundTo(left.proteinGrams + right.proteinGrams, 1),
    carbsGrams: roundTo(left.carbsGrams + right.carbsGrams, 1),
    fatGrams: roundTo(left.fatGrams + right.fatGrams, 1),
    sodiumMg: left.sodiumMg + right.sodiumMg,
    micronutrients: {
      ...left.micronutrients,
      ...Object.fromEntries(Object.entries(right.micronutrients).map(([key, value]) => [
        key,
        roundTo((left.micronutrients[key] ?? 0) + value, 2),
      ])),
    },
  };
}

function zeroSnapshot(): NutrientSnapshot {
  return {
    kcal: 0,
    proteinGrams: 0,
    carbsGrams: 0,
    fatGrams: 0,
    sodiumMg: 0,
    micronutrients: {},
  };
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function displayLabelForFood(food: FoodCatalogRecord): string {
  return food.nameZh ?? food.name ?? food.slug;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
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
