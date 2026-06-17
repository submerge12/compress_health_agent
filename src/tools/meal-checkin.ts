import type { MealPlanEntry, MealType, WeeklyMealPlan } from "../engine/meal-planner.js";
import type { RecipeNutrition } from "../engine/recipe-engine.js";

export type MealCheckinStatus = "followed" | "substituted" | "skipped";

export interface DietLog {
  date: string;
  mealType: MealType;
  description: string;
  nutrition: RecipeNutrition;
  source: "planned" | "substituted";
}

export interface MealCheckinStore {
  insertDietLog?: (log: DietLog) => unknown;
  updateMealPlanEntry?: (entry: MealPlanEntryUpdate) => unknown;
  dietLogs?: {
    insert: (log: DietLog) => unknown;
  };
  mealPlanEntries?: {
    update: (entry: MealPlanEntryUpdate) => unknown;
  };
}

export interface MealPlanEntryUpdate {
  id: string;
  status: MealCheckinStatus;
  actualDescription?: string;
  actualNutrition?: RecipeNutrition;
}

export interface MealCheckinInput {
  plan: WeeklyMealPlan;
  date: string;
  mealType: MealType;
  status: MealCheckinStatus;
  actualDescription?: string;
  actualNutrition?: RecipeNutrition;
  store?: MealCheckinStore;
}

export interface MealCheckinResult {
  entry: MealPlanEntry;
  dietLog?: DietLog;
  rebalancedTargets: readonly RebalancedMealTarget[];
}

export interface RebalanceRemainingMealsInput {
  plannedConsumedKcal: number;
  actualConsumedKcal: number;
  remainingMeals: readonly RemainingMeal[];
}

export interface RemainingMeal {
  mealType: MealType;
  plannedKcal: number;
}

export interface RebalancedMealTarget {
  mealType: MealType;
  targetKcal: number;
}

export function mealCheckin(input: MealCheckinInput): MealCheckinResult {
  const plannedEntry = findPlannedEntry(input.plan, input.date, input.mealType);
  const checkedEntry = buildCheckedEntry(plannedEntry, input);
  const dietLog = buildDietLog(checkedEntry, input);
  if (dietLog !== undefined) insertDietLog(input.store, dietLog);
  updateMealPlanEntry(input.store, buildEntryUpdate(checkedEntry, input, dietLog));
  return { entry: checkedEntry, dietLog, rebalancedTargets: rebalanceAfterCheckin(input.plan, checkedEntry, dietLog) };
}

export function rebalanceRemainingMealTargets(
  input: RebalanceRemainingMealsInput,
): readonly RebalancedMealTarget[] {
  if (input.remainingMeals.length === 0) return [];
  const deviation = input.actualConsumedKcal - input.plannedConsumedKcal;
  const perMealAdjustment = deviation / input.remainingMeals.length;
  return input.remainingMeals.map((meal) => ({
    mealType: meal.mealType,
    targetKcal: Math.max(200, Math.round(meal.plannedKcal - perMealAdjustment)),
  }));
}

function findPlannedEntry(plan: WeeklyMealPlan, date: string, mealType: MealType): MealPlanEntry {
  const entry = plan.entries.find((item) => item.date === date && item.mealType === mealType);
  if (entry === undefined) throw new RangeError(`No planned ${mealType} entry for ${date}`);
  return entry;
}

function buildCheckedEntry(entry: MealPlanEntry, input: MealCheckinInput): MealPlanEntry {
  return { ...entry, status: input.status };
}

function buildDietLog(entry: MealPlanEntry, input: MealCheckinInput): DietLog | undefined {
  if (input.status === "skipped") return undefined;
  if (input.status === "followed") return plannedDietLog(entry);
  validateSubstitution(input);
  return {
    date: entry.date,
    mealType: entry.mealType,
    description: input.actualDescription,
    nutrition: input.actualNutrition,
    source: "substituted",
  };
}

function plannedDietLog(entry: MealPlanEntry): DietLog {
  return {
    date: entry.date,
    mealType: entry.mealType,
    description: entry.dish.name,
    nutrition: entry.nutrition,
    source: "planned",
  };
}

function validateSubstitution(
  input: MealCheckinInput,
): asserts input is MealCheckinInput & { actualDescription: string; actualNutrition: RecipeNutrition } {
  if (input.actualDescription === undefined || input.actualNutrition === undefined) {
    throw new RangeError("substituted check-ins require actualDescription and actualNutrition");
  }
}

function buildEntryUpdate(
  entry: MealPlanEntry,
  input: MealCheckinInput,
  dietLog: DietLog | undefined,
): MealPlanEntryUpdate {
  return {
    id: entry.id,
    status: input.status,
    ...(dietLog === undefined ? {} : { actualDescription: dietLog.description, actualNutrition: dietLog.nutrition }),
  };
}

function insertDietLog(store: MealCheckinStore | undefined, log: DietLog): void {
  if (store?.insertDietLog !== undefined) store.insertDietLog(log);
  else if (store?.dietLogs !== undefined) store.dietLogs.insert(log);
}

function updateMealPlanEntry(store: MealCheckinStore | undefined, update: MealPlanEntryUpdate): void {
  if (store?.updateMealPlanEntry !== undefined) store.updateMealPlanEntry(update);
  else if (store?.mealPlanEntries !== undefined) store.mealPlanEntries.update(update);
}

function rebalanceAfterCheckin(
  plan: WeeklyMealPlan,
  entry: MealPlanEntry,
  dietLog: DietLog | undefined,
): readonly RebalancedMealTarget[] {
  const actualKcal = dietLog?.nutrition.kcal ?? 0;
  return rebalanceRemainingMealTargets({
    plannedConsumedKcal: entry.nutrition.kcal,
    actualConsumedKcal: actualKcal,
    remainingMeals: remainingMealsForDay(plan, entry),
  });
}

function remainingMealsForDay(plan: WeeklyMealPlan, entry: MealPlanEntry): readonly RemainingMeal[] {
  const entries = plan.entries.filter((item) => item.date === entry.date);
  const entryIndex = entries.findIndex((item) => item.id === entry.id);
  return entries.slice(entryIndex + 1).map((item) => ({ mealType: item.mealType, plannedKcal: item.nutrition.kcal }));
}
