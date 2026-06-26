import {
  generateWeeklyMealPlan,
  type MealPlanEntry,
  type MealPlanRequest,
  type WeeklyMealPlan,
} from "../engine/meal-planner.js";
import { buildCoverageReport, type CoverageReport } from "../engine/plan-advisory.js";
import { buildProcurementList, type ProcurementList } from "../engine/procurement.js";
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

export interface GenerateMealPlanResult {
  plan: WeeklyMealPlan;
  overview: string;
  coverage: CoverageReport;
  procurement: ProcurementList;
  storedCount: number;
}

export function generateMealPlan(input: GenerateMealPlanInput): GenerateMealPlanResult {
  const plan = generateWeeklyMealPlan(input);
  const storedCount = storePlanEntries(input.store, plan.entries);
  return {
    plan,
    overview: formatWeeklyOverview(plan),
    coverage: buildCoverageReport(plan, {
      dailyProteinTarget: input.dailyProteinTarget,
    }),
    procurement: buildProcurementList(plan, input.catalog),
    storedCount,
  };
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
    (entry) =>
      `${entry.mealType}: ${entry.dish.name} (${entry.nutrition.kcal} kcal, ${entry.nutrition.proteinGrams}g protein)`,
  );
  return [`Day ${index + 1} - ${date}`, ...lines].join("\n");
}
