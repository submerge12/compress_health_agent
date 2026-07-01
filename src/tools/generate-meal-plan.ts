import {
  filterUsableCandidates,
  generateWeeklyMealPlan,
  MealPlanInfeasibleError,
  type MealPlanEntry,
  type MealPlanRequest,
  type MealPlanInfeasibleResult,
  type WeeklyMealPlan,
} from "../engine/meal-planner.js";
import { buildCoverageReport, type CoverageReport } from "../engine/plan-advisory.js";
import { buildProcurementList, type ProcurementList } from "../engine/procurement.js";
import type { RecipeDish } from "../engine/recipe-engine.js";
import type { MealCatalog } from "./nutrition-estimate.js";

export interface MealPlanStore {
  insertMealPlanEntries?: (entries: readonly MealPlanEntry[]) => unknown;
  insertMealPlanEntry?: (entry: MealPlanEntry) => unknown;
  mealPlanEntries?: {
    insert?: (entry: MealPlanEntry) => unknown;
    insertMany?: (entries: readonly MealPlanEntry[]) => unknown;
  };
}

export interface GenerateMealPlanInput extends MealPlanRequest {
  store?: MealPlanStore;
  catalog?: MealCatalog;
}

export type GenerateMealPlanResult = GenerateMealPlanPlannedResult | GenerateMealPlanBlockedResult;

export interface GenerateMealPlanPlannedResult {
  status: "planned";
  plan: WeeklyMealPlan;
  overview: string;
  coverage: CoverageReport;
  procurement: ProcurementList;
  storedCount: number;
}

export interface GenerateMealPlanBlockedResult {
  status: "blocked";
  plan: WeeklyMealPlan;
  cannotSatisfy: MealPlanInfeasibleResult;
  overview: string;
  coverage: CoverageReport;
  procurement: ProcurementList;
  storedCount: 0;
}

export function generateMealPlan(input: GenerateMealPlanInput): GenerateMealPlanResult {
  const acceptedCandidates = acceptedMealCandidates(input);
  let plan: WeeklyMealPlan;
  try {
    plan = generateWeeklyMealPlan(input);
  } catch (error) {
    if (error instanceof MealPlanInfeasibleError) {
      const empty = emptyPlan(input.startDate);
      return {
        status: "blocked",
        plan: empty,
        cannotSatisfy: error.result,
        overview: formatCannotSatisfy(error.result),
        coverage: buildCoverageReport(empty, {
          dailyProteinTarget: input.dailyProteinTarget,
          dailyFatTarget: input.dailyFatTarget,
          acceptedCandidates,
        }),
        procurement: buildProcurementList(empty, input.catalog),
        storedCount: 0,
      };
    }
    throw error;
  }
  const storedCount = storePlanEntries(input.store, plan.entries);
  return {
    status: "planned",
    plan,
    overview: formatWeeklyOverview(plan),
    coverage: buildCoverageReport(plan, {
      dailyProteinTarget: input.dailyProteinTarget,
      dailyFatTarget: input.dailyFatTarget,
      acceptedCandidates,
    }),
    procurement: buildProcurementList(plan, input.catalog),
    storedCount,
  };
}

function acceptedMealCandidates(input: GenerateMealPlanInput): readonly RecipeDish[] {
  return filterUsableCandidates([
    ...(input.candidates ?? []),
    ...(input.presetDishes ?? []),
    ...(input.userDishes ?? []),
  ], input.preferences);
}

function emptyPlan(startDate: string): WeeklyMealPlan {
  const days = Array.from({ length: 7 }, (_, dayIndex) => ({
    date: addDays(startDate, dayIndex),
    meals: [],
    totals: { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 },
  }));
  return {
    startDate,
    days,
    entries: [],
    distinctDishCount: 0,
    hardViolations: [],
  };
}

function formatCannotSatisfy(result: MealPlanInfeasibleResult): string {
  return [
    result.reason,
    ...result.violations.map((violation) => `- ${violation.message}`),
    ...result.suggestions.map((suggestion) => `Suggestion: ${suggestion}`),
  ].join("\n");
}

function storePlanEntries(store: MealPlanStore | undefined, entries: readonly MealPlanEntry[]): number {
  if (store === undefined) return 0;
  if (store.insertMealPlanEntries !== undefined) {
    store.insertMealPlanEntries(entries);
    return entries.length;
  }
  if (store.mealPlanEntries?.insertMany !== undefined) {
    store.mealPlanEntries.insertMany(entries);
    return entries.length;
  }
  return insertEntriesOneByOne(store, entries);
}

function insertEntriesOneByOne(store: MealPlanStore, entries: readonly MealPlanEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (store.insertMealPlanEntry !== undefined) store.insertMealPlanEntry(entry);
    else if (store.mealPlanEntries?.insert !== undefined) store.mealPlanEntries.insert(entry);
    else return count;
    count += 1;
  }
  return count;
}

function formatWeeklyOverview(plan: WeeklyMealPlan): string {
  return plan.days.map((day, index) => formatDayOverview(day.date, index, day.meals)).join("\n\n");
}

function formatDayOverview(date: string, index: number, entries: readonly MealPlanEntry[]): string {
  const lines = entries.map(
    (entry) => {
      const dishName = entry.side === undefined
        ? entry.dish.name
        : `${entry.dish.name} + ${entry.side.name}`;
      return `${entry.mealType}: ${dishName} (${entry.nutrition.kcal} kcal, ${entry.nutrition.proteinGrams}g protein)`;
    },
  );
  return [`Day ${index + 1} - ${date}`, ...lines].join("\n");
}

function addDays(startDate: string, days: number): string {
  const date = new Date(`${startDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
