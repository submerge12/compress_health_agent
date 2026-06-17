import {
  hasRejectedSeasoning,
  recommendRecipes,
  type MealType,
  type RecipeDish,
  type RecipeNutrition,
  type RecipePreferences,
} from "./recipe-engine.js";

export type { MealType };

export interface MealPlanRequest {
  startDate: string;
  dailyKcalTarget: number;
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
}

export interface MealPlanValidationOptions {
  dailyKcalTarget: number;
  minimumDistinctDishes?: number;
}

export interface MealPlanValidationResult {
  ok: boolean;
  violations: readonly string[];
}

const MEAL_TYPES: readonly MealType[] = ["breakfast", "lunch", "dinner"];
const MEAL_KCAL_SPLIT: Readonly<Record<MealType, number>> = {
  breakfast: 0.25,
  lunch: 0.40,
  dinner: 0.35,
};
const DAILY_KCAL_TOLERANCE_RATIO = 0.1;

export function generateWeeklyMealPlan(request: MealPlanRequest): WeeklyMealPlan {
  validateMealPlanRequest(request);
  const candidates = filterUsableCandidates(collectCandidates(request), request.preferences);
  if (candidates.length === 0) throw new RangeError("No usable meal-planning candidates");
  const entries = buildEntries(request, candidates);
  const plan = buildPlan(request.startDate, entries);
  assertDailyKcalValid(plan, request.dailyKcalTarget);
  return plan;
}

export function validateWeeklyMealPlan(
  plan: WeeklyMealPlan,
  options: MealPlanValidationOptions,
): MealPlanValidationResult {
  const violations = [
    ...validateDailyKcal(plan, options.dailyKcalTarget),
    ...validateIngredientRuns(plan.entries),
    ...validateDistinctDishes(plan, options.minimumDistinctDishes),
  ];
  return { ok: violations.length === 0, violations };
}

function buildEntries(request: MealPlanRequest, candidates: readonly RecipeDish[]): MealPlanEntry[] {
  const entries: MealPlanEntry[] = [];
  const usage = new Map<string, number>();
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    for (const mealType of MEAL_TYPES) {
      entries.push(buildEntry(request, candidates, entries, usage, dayIndex, mealType));
    }
  }
  return entries;
}

function buildEntry(
  request: MealPlanRequest,
  candidates: readonly RecipeDish[],
  entries: readonly MealPlanEntry[],
  usage: Map<string, number>,
  dayIndex: number,
  mealType: MealType,
): MealPlanEntry {
  const targetKcal = targetForSlot(request.dailyKcalTarget, mealType, entries, dayIndex);
  const dish = selectDish(candidates, entries, usage, mealType, targetKcal, request.dailyKcalTarget, dayIndex);
  usage.set(dish.slug, (usage.get(dish.slug) ?? 0) + 1);
  const date = addDays(request.startDate, dayIndex);
  return { id: `${date}-${mealType}`, date, dayIndex, mealType, targetKcal, dish, nutrition: dish.nutrition, status: "planned" };
}

function selectDish(
  candidates: readonly RecipeDish[],
  entries: readonly MealPlanEntry[],
  usage: ReadonlyMap<string, number>,
  mealType: MealType,
  targetKcal: number,
  dailyKcalTarget: number,
  dayIndex: number,
): RecipeDish {
  const pool = candidatePoolForMeal(candidates, entries, mealType);
  if (pool.length === 0) throw new RangeError(`No candidates for ${mealType}`);
  const ranked = rankedForPlan(pool, entries, usage, mealType, targetKcal);
  const feasible = ranked.find((dish) =>
    canCompleteDayWithinKcal(entries, candidates, dish, dayIndex, mealType, dailyKcalTarget),
  );
  if (feasible === undefined) throw new RangeError(`No kcal-feasible candidates for ${mealType}`);
  return feasible;
}

function rankedForPlan(
  pool: readonly RecipeDish[],
  entries: readonly MealPlanEntry[],
  usage: ReadonlyMap<string, number>,
  mealType: MealType,
  targetKcal: number,
): readonly RecipeDish[] {
  const recommendations = recommendRecipes({
    candidates: pool,
    target: { kcal: targetKcal },
    mealType,
    recentDishSlugs: entries.slice(-4).map((entry) => entry.dish.slug),
  });
  return [...recommendations].sort((left, right) => {
    const usageDelta = (usage.get(left.slug) ?? 0) - (usage.get(right.slug) ?? 0);
    return usageDelta !== 0 ? usageDelta : right.score - left.score;
  });
}

function canCompleteDayWithinKcal(
  entries: readonly MealPlanEntry[],
  candidates: readonly RecipeDish[],
  dish: RecipeDish,
  dayIndex: number,
  mealType: MealType,
  dailyKcalTarget: number,
): boolean {
  const trialEntries = [...entries, provisionalEntry(dayIndex, mealType, dish)];
  const remainingMealTypes = MEAL_TYPES.slice(MEAL_TYPES.indexOf(mealType) + 1);
  return canCompleteRemainingDay(trialEntries, candidates, dayIndex, remainingMealTypes, dailyKcalTarget);
}

function canCompleteRemainingDay(
  entries: readonly MealPlanEntry[],
  candidates: readonly RecipeDish[],
  dayIndex: number,
  remainingMealTypes: readonly MealType[],
  dailyKcalTarget: number,
): boolean {
  const [nextMealType, ...restMealTypes] = remainingMealTypes;
  if (nextMealType === undefined) return isDailyKcalWithinTarget(dayKcal(entries, dayIndex), dailyKcalTarget);
  return candidatePoolForMeal(candidates, entries, nextMealType).some((dish) =>
    canCompleteRemainingDay(
      [...entries, provisionalEntry(dayIndex, nextMealType, dish)],
      candidates,
      dayIndex,
      restMealTypes,
      dailyKcalTarget,
    ),
  );
}

function candidatePoolForMeal(
  candidates: readonly RecipeDish[],
  entries: readonly MealPlanEntry[],
  mealType: MealType,
): readonly RecipeDish[] {
  const eligible = candidates.filter((dish) => matchesMealType(dish, mealType));
  const safe = eligible.filter((dish) => !wouldExceedIngredientRun(entries, dish));
  return safe.length > 0 ? safe : eligible;
}

function provisionalEntry(dayIndex: number, mealType: MealType, dish: RecipeDish): MealPlanEntry {
  return {
    id: `provisional-${dayIndex}-${mealType}`,
    date: "",
    dayIndex,
    mealType,
    targetKcal: dish.nutrition.kcal,
    dish,
    nutrition: dish.nutrition,
    status: "planned",
  };
}

function targetForSlot(
  dailyTarget: number,
  mealType: MealType,
  entries: readonly MealPlanEntry[],
  dayIndex: number,
): number {
  if (mealType !== "dinner") return Math.round(dailyTarget * splitForMeal(mealType));
  const usedKcal = entries.filter((entry) => entry.dayIndex === dayIndex).reduce((sum, entry) => sum + entry.nutrition.kcal, 0);
  return Math.max(200, dailyTarget - usedKcal);
}

function buildPlan(startDate: string, entries: readonly MealPlanEntry[]): WeeklyMealPlan {
  const days = Array.from({ length: 7 }, (_, dayIndex) => buildDay(addDays(startDate, dayIndex), entries));
  const distinctDishCount = new Set(entries.map((entry) => entry.dish.slug)).size;
  return { startDate, days, entries, distinctDishCount };
}

function buildDay(date: string, entries: readonly MealPlanEntry[]): MealPlanDay {
  const meals = entries.filter((entry) => entry.date === date);
  return { date, meals, totals: sumNutrition(meals.map((entry) => entry.nutrition)) };
}

function validateDailyKcal(plan: WeeklyMealPlan, dailyKcalTarget: number): readonly string[] {
  return plan.days
    .filter((day) => !isDailyKcalWithinTarget(day.totals.kcal, dailyKcalTarget))
    .map((day) => `${day.date} kcal ${day.totals.kcal} outside +/-10%`);
}

function assertDailyKcalValid(plan: WeeklyMealPlan, dailyKcalTarget: number): void {
  const violations = validateDailyKcal(plan, dailyKcalTarget);
  if (violations.length > 0) {
    throw new RangeError(`Generated meal plan violates daily kcal target: ${violations.join("; ")}`);
  }
}

function isDailyKcalWithinTarget(kcal: number, dailyKcalTarget: number): boolean {
  return Math.abs(kcal - dailyKcalTarget) <= dailyKcalTarget * DAILY_KCAL_TOLERANCE_RATIO;
}

function dayKcal(entries: readonly MealPlanEntry[], dayIndex: number): number {
  return entries
    .filter((entry) => entry.dayIndex === dayIndex)
    .reduce((sum, entry) => sum + entry.nutrition.kcal, 0);
}

function validateIngredientRuns(entries: readonly MealPlanEntry[]): readonly string[] {
  const violations: string[] = [];
  for (let index = 2; index < entries.length; index += 1) {
    const current = entries[index];
    const previous = entries[index - 1];
    const beforePrevious = entries[index - 2];
    if (current === undefined || previous === undefined || beforePrevious === undefined) continue;
    for (const slug of ingredientSlugs(current.dish)) {
      if (ingredientSlugs(previous.dish).has(slug) && ingredientSlugs(beforePrevious.dish).has(slug)) {
        violations.push(`${slug} appears in more than 2 consecutive meals`);
      }
    }
  }
  return violations;
}

function validateDistinctDishes(
  plan: WeeklyMealPlan,
  minimumDistinctDishes: number | undefined,
): readonly string[] {
  if (minimumDistinctDishes === undefined || plan.distinctDishCount >= minimumDistinctDishes) return [];
  return [`only ${plan.distinctDishCount} distinct dishes planned`];
}

function wouldExceedIngredientRun(entries: readonly MealPlanEntry[], dish: RecipeDish): boolean {
  if (entries.length < 2) return false;
  const previous = entries.slice(-2).map((entry) => ingredientSlugs(entry.dish));
  return [...ingredientSlugs(dish)].some((slug) => previous.every((slugs) => slugs.has(slug)));
}

function collectCandidates(request: MealPlanRequest): readonly RecipeDish[] {
  return [...(request.candidates ?? []), ...(request.presetDishes ?? []), ...(request.userDishes ?? [])];
}

function filterUsableCandidates(
  candidates: readonly RecipeDish[],
  preferences: RecipePreferences | undefined,
): readonly RecipeDish[] {
  const rejected = preferences?.rejectedSeasonings ?? [];
  return candidates.filter((dish) => !hasRejectedSeasoning(dish, rejected));
}

function matchesMealType(dish: RecipeDish, mealType: MealType): boolean {
  return dish.mealTypes === undefined || dish.mealTypes.includes(mealType);
}

function splitForMeal(mealType: MealType): number {
  return MEAL_KCAL_SPLIT[mealType];
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
