import { aggregateNutrition } from "./nutrition.js";
import type { NutritionEntry } from "./types.js";
import {
  hasRejectedIngredient,
  type RecipeDish,
  type RecipeNutrition,
  type RecipePreferences,
} from "./recipe-engine.js";
import type { MealCatalog } from "../tools/nutrition-estimate.js";

export interface Staple {
  slug: string;
  defaultGrams: number;
  minGrams: number;
  maxGrams: number;
  /**
   * Natural-unit half-step: solved portions land on multiples of this so the
   * plan reads in kitchen units (半碗/半个), not scale-precise grams.
   */
  stepGrams?: number;
}

export interface StaplePortion {
  slug: string;
  grams: number;
}

export interface ProteinTopUpAddOn {
  slug: string;
  name: string;
  ingredients: readonly NutritionEntry[];
  allergenTags?: readonly string[];
}

export interface ProteinTopUpPortion extends ProteinTopUpAddOn {
  nutrition: RecipeNutrition;
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

export interface ProteinTopUpSolveInput {
  proteinFloorGrams: number;
  fixedNutrition: RecipeNutrition;
  remainingKcalBudget: number;
  catalog: MealCatalog;
  preferences?: RecipePreferences;
  menu?: readonly ProteinTopUpAddOn[];
}

export interface ProteinTopUpSolveResult {
  addOns: readonly ProteinTopUpPortion[];
  composedNutrition: RecipeNutrition;
  meetsProteinFloor: boolean;
  kcalWithinBudget: boolean;
}

// brown_rice is on a dry-weight basis: 1 碗 cooked = 60 g dry, so the
// half-bowl lattice step is 30 g and the floor is 半碗.
export const DEFAULT_STAPLE: Staple = {
  slug: "brown_rice",
  defaultGrams: 90,
  minGrams: 30,
  maxGrams: 180,
  stepGrams: 30,
};

export const STAPLES: readonly Staple[] = [
  DEFAULT_STAPLE,
  { slug: "steamed_bun", defaultGrams: 100, minGrams: 50, maxGrams: 200, stepGrams: 50 },
  { slug: "sweet_potato", defaultGrams: 200, minGrams: 100, maxGrams: 300, stepGrams: 100 },
  { slug: "corn_fresh", defaultGrams: 120, minGrams: 60, maxGrams: 240, stepGrams: 60 },
  { slug: "quinoa_ciabatta", defaultGrams: 90, minGrams: 45, maxGrams: 180, stepGrams: 45 },
];

// Ordered menu per the v2 design (egg / yogurt / chicken-breast extra grams /
// tofu / soy milk); items missing from the catalog are skipped, so small test
// catalogs see only the classic egg/tofu/soy subset.
export const DEFAULT_PROTEIN_TOP_UP_MENU: readonly ProteinTopUpAddOn[] = [
  {
    slug: "protein_topup_egg",
    name: "Boiled egg",
    ingredients: [{ slug: "egg", grams: 50 }],
    allergenTags: ["egg"],
  },
  {
    slug: "protein_topup_yogurt",
    name: "Unsweetened Greek yogurt",
    ingredients: [{ slug: "yogurt_high_protein", grams: 150 }],
    allergenTags: ["dairy"],
  },
  {
    slug: "protein_topup_chicken_breast",
    name: "Extra chicken breast",
    ingredients: [{ slug: "chicken_breast", grams: 100 }],
  },
  {
    slug: "protein_topup_tofu",
    name: "Plain tofu",
    ingredients: [{ slug: "tofu", grams: 150 }],
    allergenTags: ["soy"],
  },
  {
    slug: "protein_topup_soy_milk",
    name: "Unsweetened soy milk",
    ingredients: [{ slug: "soy_milk", grams: 250 }],
    allergenTags: ["soy"],
  },
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

  const roundToGrams = input.roundToGrams ?? input.staple.stepGrams ?? DEFAULT_ROUND_TO_GRAMS;
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

export function solveProteinTopUps(input: ProteinTopUpSolveInput): ProteinTopUpSolveResult {
  const budget = Math.max(0, input.remainingKcalBudget);
  const selected: ProteinTopUpPortion[] = [];
  let composedNutrition = input.fixedNutrition;
  let selectedKcal = 0;

  for (const addOn of input.menu ?? DEFAULT_PROTEIN_TOP_UP_MENU) {
    if (composedNutrition.proteinGrams >= input.proteinFloorGrams) break;
    if (!isAvailableAddOn(addOn, input.catalog)) continue;
    if (!isAllowedAddOn(addOn, input.preferences)) continue;

    const nutrition = nutritionFromEntries(addOn.ingredients, input.catalog);
    if (selectedKcal + nutrition.kcal > budget) continue;

    selected.push({ ...addOn, nutrition });
    selectedKcal += nutrition.kcal;
    composedNutrition = addNutrition(composedNutrition, nutrition);
  }

  return {
    addOns: selected,
    composedNutrition,
    meetsProteinFloor: composedNutrition.proteinGrams >= input.proteinFloorGrams,
    kcalWithinBudget: selectedKcal <= budget,
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

function isAvailableAddOn(addOn: ProteinTopUpAddOn, catalog: MealCatalog): boolean {
  return addOn.ingredients.every((ingredient) =>
    catalog.foods.some((food) => food.slug === ingredient.slug)
  );
}

function isAllowedAddOn(addOn: ProteinTopUpAddOn, preferences: RecipePreferences | undefined): boolean {
  const avoidedDishSlugs = new Set((preferences?.avoidedDishSlugs ?? []).map(normalizeToken));
  if (avoidedDishSlugs.has(normalizeToken(addOn.slug))) return false;

  const asDish: RecipeDish = {
    slug: addOn.slug,
    name: addOn.name,
    nutrition: { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 },
    ingredients: addOn.ingredients,
    seasonings: [],
    source: "preset",
    allergenTags: addOn.allergenTags,
  };

  return !hasRejectedIngredient(
    asDish,
    preferences?.rejectedIngredients ?? [],
    preferences?.allergens ?? [],
  );
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

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}
