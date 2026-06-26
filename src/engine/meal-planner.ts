import {
  hasRejectedSeasoning,
  type MealType,
  type RecipeDish,
  type RecipeNutrition,
  type RecipePreferences,
} from "./recipe-engine.js";
import {
  DEFAULT_STAPLE,
  addNutrition,
  composeMealNutrition,
  dishNutrition,
  solveStaplePortionsForDay,
  type Staple,
  type StaplePortion,
} from "./meal-composition.js";
import { scorePlan, type MealPlanScore } from "./meal-plan-scoring.js";
import {
  ENERGY_TOLERANCE_RATIO,
  MAX_ENERGY_TOLERANCE_RATIO,
  PROTEIN_FLOOR_RATIO,
} from "./scoring-weights.js";
import type { MealCatalog } from "../tools/nutrition-estimate.js";

export type { MealType };

export interface MealPlanRequest {
  startDate: string;
  dailyKcalTarget: number;
  dailyProteinTarget?: number;
  catalog?: MealCatalog;
  staple?: Staple;
  presetDishes?: readonly RecipeDish[];
  userDishes?: readonly RecipeDish[];
  candidates?: readonly RecipeDish[];
  preferences?: RecipePreferences;
}

export interface MealPlanEntry {
  id: string;
  date: string;
  dayIndex: number;
  mealType: MealType;
  targetKcal: number;
  dish: RecipeDish;
  side?: RecipeDish;
  staple?: StaplePortion;
  nutrition: RecipeNutrition;
  status: "planned" | "followed" | "substituted" | "skipped";
}

export interface MealPlanDay {
  date: string;
  meals: readonly MealPlanEntry[];
  totals: RecipeNutrition;
}

export interface WeeklyMealPlan {
  startDate: string;
  days: readonly MealPlanDay[];
  entries: readonly MealPlanEntry[];
  distinctDishCount: number;
  hardViolations: readonly HardViolation[];
  score?: MealPlanScore;
}

export interface HardViolation {
  type: "energy_band" | "protein_floor";
  date: string;
  actual: number;
  target: number;
  message: string;
}

export interface MealPlanValidationOptions {
  dailyKcalTarget: number;
  dailyProteinTarget?: number;
  minimumDistinctDishes?: number;
  energyToleranceRatio?: number;
}

export interface MealPlanValidationResult {
  ok: boolean;
  violations: readonly string[];
}

const MEAL_TYPES: readonly MealType[] = ["breakfast", "lunch", "dinner"];

export function generateWeeklyMealPlan(request: MealPlanRequest): WeeklyMealPlan {
  validateMealPlanRequest(request);
  const candidates = filterUsableCandidates(collectCandidates(request), request.preferences);
  if (candidates.length === 0) throw new RangeError("No usable meal-planning candidates");

  const breakfastPool = candidates.filter(matchesBreakfast);
  const mainPool = candidates.filter(matchesMain);
  const sidePool = candidates.filter(matchesSide);
  if (breakfastPool.length === 0) throw new RangeError("No breakfast candidates");
  if (mainPool.length === 0) throw new RangeError("No main meal candidates");

  const entries: MealPlanEntry[] = [];
  const mainUsage = new Map<string, number>();
  const sideUsage = new Map<string, number>();
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const date = addDays(request.startDate, dayIndex);
    const dayEntries = selectDayCombo(
      request,
      entries,
      mainUsage,
      sideUsage,
      breakfastPool,
      mainPool,
      sidePool,
      date,
      dayIndex,
    );
    for (const entry of dayEntries) {
      entries.push(entry);
      mainUsage.set(entry.dish.slug, (mainUsage.get(entry.dish.slug) ?? 0) + 1);
      if (entry.side !== undefined) {
        sideUsage.set(entry.side.slug, (sideUsage.get(entry.side.slug) ?? 0) + 1);
      }
    }
  }

  const plan = buildPlan(request.startDate, entries, []);
  const hardViolations = hardViolationsForPlan(plan, request);
  const withViolations = buildPlan(request.startDate, entries, hardViolations);
  return {
    ...withViolations,
    score: scorePlan(
      withViolations,
      {
        dailyKcalTarget: request.dailyKcalTarget,
        dailyProteinTarget: request.dailyProteinTarget,
      },
      request.preferences,
    ),
  };
}

export function validateWeeklyMealPlan(
  plan: WeeklyMealPlan,
  options: MealPlanValidationOptions,
): MealPlanValidationResult {
  const violations = [
    ...validateDailyKcal(plan, options.dailyKcalTarget, options.energyToleranceRatio ?? ENERGY_TOLERANCE_RATIO),
    ...validateDailyProtein(plan, options.dailyProteinTarget),
    ...validateStructuralCompleteness(plan),
    ...validateDistinctDishes(plan, options.minimumDistinctDishes),
  ];
  return { ok: violations.length === 0, violations };
}

function selectDayCombo(
  request: MealPlanRequest,
  entries: readonly MealPlanEntry[],
  mainUsage: Map<string, number>,
  sideUsage: Map<string, number>,
  breakfastPool: readonly RecipeDish[],
  mainPool: readonly RecipeDish[],
  sidePool: readonly RecipeDish[],
  date: string,
  dayIndex: number,
): readonly MealPlanEntry[] {
  let best: readonly MealPlanEntry[] | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const breakfast of breakfastPool) {
    for (const lunch of mainPool) {
      for (const dinner of mainPool) {
        for (const lunchSide of sideOptionsFor(lunch, sidePool)) {
          for (const dinnerSide of sideOptionsFor(dinner, sidePool)) {
            const combo = buildDayEntries(request, date, dayIndex, breakfast, lunch, dinner, lunchSide, dinnerSide);
            const candidateScore = comboScore(request, entries, combo, mainUsage, sideUsage);
            if (candidateScore < bestScore) {
              best = combo;
              bestScore = candidateScore;
            }
          }
        }
      }
    }
  }
  if (best === undefined) throw new RangeError("No meal-plan combo candidates");
  return best;
}

function buildDayEntries(
  request: MealPlanRequest,
  date: string,
  dayIndex: number,
  breakfast: RecipeDish,
  lunch: RecipeDish,
  dinner: RecipeDish,
  lunchSide?: RecipeDish,
  dinnerSide?: RecipeDish,
): readonly MealPlanEntry[] {
  if (request.catalog === undefined) {
    const lunchNutrition = addOptionalSideNutrition(lunch.nutrition, lunchSide);
    const dinnerNutrition = addOptionalSideNutrition(dinner.nutrition, dinnerSide);
    return [
      buildEntry(date, dayIndex, "breakfast", breakfast, breakfast.nutrition),
      buildEntry(date, dayIndex, "lunch", lunch, lunchNutrition, undefined, lunchSide),
      buildEntry(date, dayIndex, "dinner", dinner, dinnerNutrition, undefined, dinnerSide),
    ];
  }

  const breakfastNutrition = nutritionForDish(breakfast, request.catalog);
  const lunchNutrition = composeMealNutrition({ dish: lunch, side: lunchSide }, request.catalog);
  const dinnerNutrition = composeMealNutrition({ dish: dinner, side: dinnerSide }, request.catalog);
  const fixedNutrition = sumNutrition([breakfastNutrition, lunchNutrition, dinnerNutrition]);
  const stapleSolve = solveStaplePortionsForDay({
    dailyKcalTarget: request.dailyKcalTarget,
    fixedNutrition,
    mainMealCount: 2,
    staple: request.staple ?? DEFAULT_STAPLE,
    catalog: request.catalog,
    energyToleranceRatio: ENERGY_TOLERANCE_RATIO,
  });
  const [lunchStaple, dinnerStaple] = stapleSolve.portions;
  const lunchComposedNutrition = composeMealNutrition(
    { dish: lunch, side: lunchSide, staple: lunchStaple },
    request.catalog,
  );
  const dinnerComposedNutrition = composeMealNutrition(
    { dish: dinner, side: dinnerSide, staple: dinnerStaple },
    request.catalog,
  );

  return [
    buildEntry(date, dayIndex, "breakfast", breakfast, breakfastNutrition),
    buildEntry(date, dayIndex, "lunch", lunch, lunchComposedNutrition, lunchStaple, lunchSide),
    buildEntry(date, dayIndex, "dinner", dinner, dinnerComposedNutrition, dinnerStaple, dinnerSide),
  ];
}

function buildEntry(
  date: string,
  dayIndex: number,
  mealType: MealType,
  dish: RecipeDish,
  nutrition: RecipeNutrition,
  staple?: StaplePortion,
  side?: RecipeDish,
): MealPlanEntry {
  return {
    id: `${date}-${mealType}`,
    date,
    dayIndex,
    mealType,
    targetKcal: nutrition.kcal,
    dish,
    ...(side === undefined ? {} : { side }),
    ...(staple === undefined ? {} : { staple }),
    nutrition,
    status: "planned",
  };
}

function nutritionForDish(dish: RecipeDish, catalog: MealCatalog): RecipeNutrition {
  return dishNutrition(dish, catalog);
}

function comboScore(
  request: MealPlanRequest,
  existingEntries: readonly MealPlanEntry[],
  combo: readonly MealPlanEntry[],
  mainUsage: ReadonlyMap<string, number>,
  sideUsage: ReadonlyMap<string, number>,
): number {
  const trialEntries = [...existingEntries, ...combo];
  const dayTotals = sumNutrition(combo.map((entry) => entry.nutrition));
  const energySoftMiss = Math.max(
    0,
    Math.abs(dayTotals.kcal - request.dailyKcalTarget) -
      request.dailyKcalTarget * ENERGY_TOLERANCE_RATIO,
  ) / request.dailyKcalTarget;
  const energyMiss = Math.max(
    0,
    Math.abs(dayTotals.kcal - request.dailyKcalTarget) -
      request.dailyKcalTarget * MAX_ENERGY_TOLERANCE_RATIO,
  ) / request.dailyKcalTarget;
  const proteinFloor = (request.dailyProteinTarget ?? 0) * PROTEIN_FLOOR_RATIO;
  const proteinMiss = proteinFloor === 0 ? 0 : Math.max(0, proteinFloor - dayTotals.proteinGrams) / proteinFloor;
  const duplicateMainPenalty = combo[1]?.dish.slug === combo[2]?.dish.slug ? 4 : 0;
  const duplicateSidePenalty =
    combo[1]?.side !== undefined && combo[1].side?.slug === combo[2]?.side?.slug ? 1 : 0;
  const usagePenalty = combo.reduce((sum, entry) => sum + (mainUsage.get(entry.dish.slug) ?? 0), 0) * 0.7;
  const sideUsagePenalty = combo.reduce(
    (sum, entry) => sum + (entry.side === undefined ? 0 : sideUsage.get(entry.side.slug) ?? 0),
    0,
  ) * 0.25;
  const repeatIngredientPenalty = wouldRepeatIngredients(existingEntries, combo) ? 2 : 0;
  const trialPlan = buildPlan(request.startDate, trialEntries, []);
  const softPenalty = scorePlan(
    trialPlan,
    {
      dailyKcalTarget: request.dailyKcalTarget,
      dailyProteinTarget: request.dailyProteinTarget,
    },
    request.preferences,
  ).penalty;
  return energyMiss * 2_000 + energySoftMiss * 1_000 + proteinMiss * 1_500 + duplicateMainPenalty + duplicateSidePenalty + usagePenalty + sideUsagePenalty + repeatIngredientPenalty + softPenalty;
}

function buildPlan(
  startDate: string,
  entries: readonly MealPlanEntry[],
  hardViolations: readonly HardViolation[],
): WeeklyMealPlan {
  const days = Array.from({ length: 7 }, (_, dayIndex) => buildDay(addDays(startDate, dayIndex), entries));
  const distinctDishCount = new Set(entries.map((entry) => entry.dish.slug)).size;
  return { startDate, days, entries, distinctDishCount, hardViolations };
}

function buildDay(date: string, entries: readonly MealPlanEntry[]): MealPlanDay {
  const meals = entries.filter((entry) => entry.date === date);
  return { date, meals, totals: sumNutrition(meals.map((entry) => entry.nutrition)) };
}

function hardViolationsForPlan(plan: WeeklyMealPlan, request: MealPlanRequest): readonly HardViolation[] {
  const energyViolations = plan.days
    .filter((day) => !isDailyKcalWithinTarget(day.totals.kcal, request.dailyKcalTarget, MAX_ENERGY_TOLERANCE_RATIO))
    .map((day) => ({
      type: "energy_band" as const,
      date: day.date,
      actual: day.totals.kcal,
      target: request.dailyKcalTarget,
      message: `${day.date} kcal ${day.totals.kcal} outside +/-${Math.round(MAX_ENERGY_TOLERANCE_RATIO * 100)}%`,
    }));
  const proteinViolations = plan.days
    .filter((day) => !isDailyProteinWithinFloor(day.totals.proteinGrams, request.dailyProteinTarget))
    .map((day) => {
      const target = Math.round((request.dailyProteinTarget ?? 0) * PROTEIN_FLOOR_RATIO);
      return {
        type: "protein_floor" as const,
        date: day.date,
        actual: day.totals.proteinGrams,
        target,
        message: `${day.date} protein ${day.totals.proteinGrams}g below ${target}g floor`,
      };
    });
  return [...energyViolations, ...proteinViolations];
}

function validateDailyKcal(
  plan: WeeklyMealPlan,
  dailyKcalTarget: number,
  toleranceRatio: number,
): readonly string[] {
  return plan.days
    .filter((day) => !isDailyKcalWithinTarget(day.totals.kcal, dailyKcalTarget, toleranceRatio))
    .map((day) => `${day.date} kcal ${day.totals.kcal} outside +/-${Math.round(toleranceRatio * 100)}%`);
}

function validateDailyProtein(plan: WeeklyMealPlan, dailyProteinTarget: number | undefined): readonly string[] {
  if (dailyProteinTarget === undefined) return [];
  const floor = Math.round(dailyProteinTarget * PROTEIN_FLOOR_RATIO);
  return plan.days
    .filter((day) => !isDailyProteinWithinFloor(day.totals.proteinGrams, dailyProteinTarget))
    .map((day) => `${day.date} protein ${day.totals.proteinGrams}g below ${floor}g floor`);
}

function validateStructuralCompleteness(plan: WeeklyMealPlan): readonly string[] {
  return plan.days.flatMap((day) => {
    const mealTypes = day.meals.map((meal) => meal.mealType);
    const complete =
      day.meals.length === 3 &&
      mealTypes.filter((mealType) => mealType === "breakfast").length === 1 &&
      mealTypes.filter((mealType) => mealType === "lunch").length === 1 &&
      mealTypes.filter((mealType) => mealType === "dinner").length === 1;
    return complete ? [] : [`${day.date} does not have breakfast,lunch,dinner`];
  });
}

function isDailyKcalWithinTarget(kcal: number, dailyKcalTarget: number, toleranceRatio: number): boolean {
  return Math.abs(kcal - dailyKcalTarget) <= dailyKcalTarget * toleranceRatio;
}

function isDailyProteinWithinFloor(proteinGrams: number, dailyProteinTarget: number | undefined): boolean {
  return dailyProteinTarget === undefined || proteinGrams >= Math.round(dailyProteinTarget * PROTEIN_FLOOR_RATIO);
}

function validateDistinctDishes(
  plan: WeeklyMealPlan,
  minimumDistinctDishes: number | undefined,
): readonly string[] {
  if (minimumDistinctDishes === undefined || plan.distinctDishCount >= minimumDistinctDishes) return [];
  return [`only ${plan.distinctDishCount} distinct dishes planned`];
}

function wouldRepeatIngredients(existingEntries: readonly MealPlanEntry[], combo: readonly MealPlanEntry[]): boolean {
  const sequence = [...existingEntries.slice(-2), ...combo];
  for (let index = 2; index < sequence.length; index += 1) {
    const current = sequence[index];
    const previous = sequence[index - 1];
    const before = sequence[index - 2];
    if (current === undefined || previous === undefined || before === undefined) continue;
    for (const slug of ingredientSlugs(current.dish)) {
      if (ingredientSlugs(previous.dish).has(slug) && ingredientSlugs(before.dish).has(slug)) return true;
    }
  }
  return false;
}

function collectCandidates(request: MealPlanRequest): readonly RecipeDish[] {
  return [...(request.candidates ?? []), ...(request.presetDishes ?? []), ...(request.userDishes ?? [])];
}

function filterUsableCandidates(
  candidates: readonly RecipeDish[],
  preferences: RecipePreferences | undefined,
): readonly RecipeDish[] {
  const rejectedSeasonings = preferences?.rejectedSeasonings ?? [];
  const rejectedIngredients = new Set([
    ...(preferences?.rejectedIngredients ?? []),
    ...(preferences?.allergens ?? []),
  ].map(normalizeToken));
  return candidates.filter((dish) => {
    if (hasRejectedSeasoning(dish, rejectedSeasonings)) return false;
    return !dish.ingredients.some((ingredient) => rejectedIngredients.has(normalizeToken(ingredient.slug)));
  });
}

function matchesBreakfast(dish: RecipeDish): boolean {
  return dish.role !== "side" && (dish.mealTypes === undefined || dish.mealTypes.includes("breakfast"));
}

function matchesMain(dish: RecipeDish): boolean {
  return dish.role !== "side" && (
    dish.mealTypes === undefined ||
    dish.mealTypes.includes("lunch") ||
    dish.mealTypes.includes("dinner")
  );
}

function matchesSide(dish: RecipeDish): boolean {
  return dish.role === "side" && (
    dish.mealTypes === undefined ||
    dish.mealTypes.includes("lunch") ||
    dish.mealTypes.includes("dinner")
  );
}

function sideOptionsFor(main: RecipeDish, sidePool: readonly RecipeDish[]): readonly (RecipeDish | undefined)[] {
  if (isSelfContainedMain(main) || sidePool.length === 0) return [undefined];
  return sidePool;
}

function isSelfContainedMain(dish: RecipeDish): boolean {
  return dish.selfContained !== false;
}

function addOptionalSideNutrition(nutrition: RecipeNutrition, side: RecipeDish | undefined): RecipeNutrition {
  if (side === undefined) return nutrition;
  return addNutrition(nutrition, side.nutrition);
}

function sumNutrition(items: readonly RecipeNutrition[]): RecipeNutrition {
  return {
    kcal: items.reduce((sum, item) => sum + item.kcal, 0),
    proteinGrams: roundTo(items.reduce((sum, item) => sum + item.proteinGrams, 0), 1),
    carbsGrams: roundTo(items.reduce((sum, item) => sum + item.carbsGrams, 0), 1),
    fatGrams: roundTo(items.reduce((sum, item) => sum + item.fatGrams, 0), 1),
    sodiumMg: Math.round(items.reduce((sum, item) => sum + item.sodiumMg, 0)),
  };
}

function ingredientSlugs(dish: RecipeDish): ReadonlySet<string> {
  return new Set(dish.ingredients.map((ingredient) => ingredient.slug));
}

function validateMealPlanRequest(request: MealPlanRequest): void {
  if (!Number.isFinite(request.dailyKcalTarget) || request.dailyKcalTarget <= 0) {
    throw new RangeError("dailyKcalTarget must be a positive finite number");
  }
  if (Number.isNaN(Date.parse(`${request.startDate}T00:00:00.000Z`))) {
    throw new RangeError("startDate must be an ISO date string");
  }
}

function addDays(startDate: string, days: number): string {
  const date = new Date(`${startDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}
