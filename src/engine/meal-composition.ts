import { aggregateNutrition } from "./nutrition.js";
import type { NutritionEntry } from "./types.js";
import type { RecipeDish, RecipeNutrition } from "./recipe-engine.js";
import type { MealCatalog } from "../tools/nutrition-estimate.js";

export interface Staple {
  slug: string;
  defaultGrams: number;
  minGrams: number;
  maxGrams: number;
}

export interface StaplePortion {
  slug: string;
  grams: number;
}

export interface ComposedMealInput {
  dish: RecipeDish;
  side?: RecipeDish;
  staple?: StaplePortion;
}

export interface StapleSolveInput {
  dailyKcalTarget: number;
  fixedNutrition: RecipeNutrition;
  mainMealCount: number;
  staple: Staple;
  catalog: MealCatalog;
  energyToleranceRatio?: number;
  roundToGrams?: number;
}

export interface StapleSolveResult {
  portions: readonly StaplePortion[];
  composedKcal: number;
  withinEnergyBand: boolean;
  clamped: boolean;
}

export const DEFAULT_STAPLE: Staple = {
  slug: "brown_rice",
  defaultGrams: 100,
  minGrams: 40,
  maxGrams: 180,
};

export const STAPLES: readonly Staple[] = [
  DEFAULT_STAPLE,
  { slug: "steamed_bun", defaultGrams: 80, minGrams: 40, maxGrams: 160 },
  { slug: "sweet_potato", defaultGrams: 200, minGrams: 80, maxGrams: 300 },
  { slug: "corn_fresh", defaultGrams: 120, minGrams: 60, maxGrams: 240 },
  { slug: "quinoa_ciabatta", defaultGrams: 90, minGrams: 40, maxGrams: 160 },
];

const DEFAULT_ENERGY_TOLERANCE_RATIO = 0.12;
const DEFAULT_ROUND_TO_GRAMS = 10;

export function stapleNutrition(portion: StaplePortion, catalog: MealCatalog): RecipeNutrition {
  return nutritionFromEntries([{ slug: portion.slug, grams: portion.grams }], catalog);
}

export function dishNutrition(dish: RecipeDish, catalog: MealCatalog): RecipeNutrition {
  return nutritionFromEntries(dish.ingredients, catalog);
}

export function composeMealNutrition(input: ComposedMealInput, catalog: MealCatalog): RecipeNutrition {
  const dishTotals = dishNutrition(input.dish, catalog);
  const sideTotals = input.side === undefined
    ? undefined
    : dishNutrition(input.side, catalog);
  const baseTotals = sideTotals === undefined
    ? dishTotals
    : addNutrition(dishTotals, sideTotals);
  if (input.staple === undefined) return baseTotals;
  return addNutrition(baseTotals, stapleNutrition(input.staple, catalog));
}

export function solveStaplePortionsForDay(input: StapleSolveInput): StapleSolveResult {
  if (input.mainMealCount <= 0) {
    return {
      portions: [],
      composedKcal: input.fixedNutrition.kcal,
      withinEnergyBand: withinEnergyBand(
        input.fixedNutrition.kcal,
        input.dailyKcalTarget,
        input.energyToleranceRatio ?? DEFAULT_ENERGY_TOLERANCE_RATIO,
      ),
      clamped: false,
    };
  }

  const roundToGrams = input.roundToGrams ?? DEFAULT_ROUND_TO_GRAMS;
  const kcalPerGram = stapleNutrition({ slug: input.staple.slug, grams: 100 }, input.catalog).kcal / 100;
  const rawTotalGrams = kcalPerGram <= 0
    ? input.staple.defaultGrams * input.mainMealCount
    : (input.dailyKcalTarget - input.fixedNutrition.kcal) / kcalPerGram;
  const minTotalGrams = input.staple.minGrams * input.mainMealCount;
  const maxTotalGrams = input.staple.maxGrams * input.mainMealCount;
  const clampedTotal = clamp(rawTotalGrams, minTotalGrams, maxTotalGrams);
  const roundedTotal = clamp(roundToNearest(clampedTotal, roundToGrams), minTotalGrams, maxTotalGrams);
  const portions = distributePortions(roundedTotal, input.mainMealCount, input.staple, roundToGrams);
  const stapleKcal = portions.reduce(
    (sum, portion) => sum + stapleNutrition(portion, input.catalog).kcal,
    0,
  );
  const composedKcal = input.fixedNutrition.kcal + stapleKcal;

  return {
    portions,
    composedKcal,
    withinEnergyBand: withinEnergyBand(
      composedKcal,
      input.dailyKcalTarget,
      input.energyToleranceRatio ?? DEFAULT_ENERGY_TOLERANCE_RATIO,
    ),
    clamped: rawTotalGrams !== clampedTotal,
  };
}

export function addNutrition(left: RecipeNutrition, right: RecipeNutrition): RecipeNutrition {
  return {
    kcal: left.kcal + right.kcal,
    proteinGrams: roundTo(left.proteinGrams + right.proteinGrams, 1),
    carbsGrams: roundTo(left.carbsGrams + right.carbsGrams, 1),
    fatGrams: roundTo(left.fatGrams + right.fatGrams, 1),
    sodiumMg: Math.round(left.sodiumMg + right.sodiumMg),
  };
}

function nutritionFromEntries(entries: readonly NutritionEntry[], catalog: MealCatalog): RecipeNutrition {
  const aggregate = aggregateNutrition({
    foods: entries,
    foodRecords: catalog.foods,
    requireWeightType: true,
  });
  return {
    kcal: aggregate.total.kcal,
    proteinGrams: aggregate.total.proteinGrams,
    carbsGrams: aggregate.total.carbsGrams,
    fatGrams: aggregate.total.fatGrams,
    sodiumMg: aggregate.total.sodiumMg,
  };
}

function distributePortions(
  totalGrams: number,
  count: number,
  staple: Staple,
  roundToGrams: number,
): readonly StaplePortion[] {
  const portions: StaplePortion[] = [];
  let remaining = totalGrams;
  for (let index = 0; index < count; index += 1) {
    const remainingSlots = count - index;
    const grams = index === count - 1
      ? remaining
      : clamp(roundToNearest(remaining / remainingSlots, roundToGrams), staple.minGrams, staple.maxGrams);
    portions.push({ slug: staple.slug, grams });
    remaining -= grams;
  }
  return portions;
}

function withinEnergyBand(kcal: number, target: number, toleranceRatio: number): boolean {
  return Math.abs(kcal - target) <= target * toleranceRatio;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToNearest(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
