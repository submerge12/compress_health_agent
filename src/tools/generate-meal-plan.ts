import {
  filterUsableCandidates,
  formatWeeklyBudgetLine,
  buildWeeklyBudgets,
  generateWeeklyMealPlan,
  MealPlanInfeasibleError,
  type MealPlanEntry,
  type MealPlanRequest,
  type MealPlanInfeasibleResult,
  type WeeklyMealPlan,
} from "../engine/meal-planner.js";
import {
  selectWeeklyPool as defaultSelectWeeklyPool,
  type PoolCannotSatisfy,
  type SelectWeeklyPoolRequest,
  type SelectWeeklyPoolResult,
  type WaivedWeeklyFloor,
} from "../engine/pool-selection.js";
import { DEFAULT_STAPLE, stapleNutrition } from "../engine/meal-composition.js";
import { buildCoverageReport, type CoverageReport } from "../engine/plan-advisory.js";
import { buildProcurementList, type ProcurementList } from "../engine/procurement.js";
import { WEEKLY_FLOORS } from "../engine/scoring-weights.js";
import type { RecipeDish, RecipePreferences } from "../engine/recipe-engine.js";
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

export interface GenerateMealPlanDependencies {
  selectWeeklyPool: (request: SelectWeeklyPoolRequest) => SelectWeeklyPoolResult;
}

export type GenerateMealPlanResult = GenerateMealPlanPlannedResult | GenerateMealPlanBlockedResult;

export interface PoolDishSummary {
  slug: string;
  name: string;
}

/** The selected weekly pool; doubles as the shape behind the grocery list. */
export interface WeeklyPoolSummary {
  breakfasts: readonly PoolDishSummary[];
  mains: readonly PoolDishSummary[];
  sides: readonly PoolDishSummary[];
  fatBudgetNotice?: string;
  poolNotices?: readonly string[];
}

export interface GenerateMealPlanPlannedResult {
  status: "planned";
  plan: WeeklyMealPlan;
  pool: WeeklyPoolSummary;
  overview: string;
  coverage: CoverageReport;
  procurement: ProcurementList;
  storedCount: number;
  /** Weekly floors skipped because their bucket is fully excluded by safety filters. */
  waivedFloors?: readonly WaivedWeeklyFloor[];
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

const DEFAULT_DEPENDENCIES: GenerateMealPlanDependencies = {
  selectWeeklyPool: defaultSelectWeeklyPool,
};

export function generateMealPlan(
  input: GenerateMealPlanInput,
  dependencies: GenerateMealPlanDependencies = DEFAULT_DEPENDENCIES,
): GenerateMealPlanResult {
  const rawCandidates = collectInputCandidates(input);
  const poolResult = dependencies.selectWeeklyPool(
    buildPoolRequest(input, rawCandidates, dependencies.selectWeeklyPool === defaultSelectWeeklyPool),
  );
  if (!poolResult.ok) {
    return blockedResultFromCannotSatisfy(
      input,
      poolCannotSatisfyResult(input, rawCandidates, poolResult.cannotSatisfy),
      acceptedMealCandidates(rawCandidates, input.preferences),
    );
  }

  const poolCandidates = poolResult.pool.all;
  const plannerInput = plannerInputFromPool(input, poolResult.pool);
  const acceptedCandidates = acceptedMealCandidates(poolCandidates, input.preferences);
  let plan: WeeklyMealPlan;
  try {
    plan = generateWeeklyMealPlan(plannerInput);
  } catch (error) {
    if (error instanceof MealPlanInfeasibleError) {
      return blockedResultFromCannotSatisfy(input, error.result, acceptedCandidates);
    }
    throw error;
  }
  const storedCount = storePlanEntries(input.store, plan.entries);
  const waivedFloors = poolResult.pool.waivedFloors ?? [];
  return {
    status: "planned",
    plan,
    pool: poolSummary(poolResult.pool),
    overview: [
      ...(waivedFloors.length > 0 ? [formatWaivedFloors(waivedFloors)] : []),
      ...(poolResult.pool.fatBudgetNotice === undefined ? [] : [poolResult.pool.fatBudgetNotice]),
      ...(poolResult.pool.poolNotices ?? []),
      formatWeeklyOverview(plan),
    ].join("\n\n"),
    ...(waivedFloors.length > 0 ? { waivedFloors } : {}),
    coverage: buildCoverageReport(plan, {
      dailyProteinTarget: input.dailyProteinTarget,
      dailyFatTarget: input.dailyFatTarget,
      dailyCarbsTarget: input.dailyCarbsTarget,
      acceptedCandidates,
    }),
    procurement: buildProcurementList(plan, input.catalog),
    storedCount,
  };
}

function poolSummary(pool: {
  breakfasts: readonly RecipeDish[];
  mains: readonly RecipeDish[];
  sides: readonly RecipeDish[];
  fatBudgetNotice?: string;
  poolNotices?: readonly string[];
}): WeeklyPoolSummary {
  const summarize = (dishes: readonly RecipeDish[]): PoolDishSummary[] =>
    dishes.map((dish) => ({ slug: dish.slug, name: dish.name }));
  return {
    breakfasts: summarize(pool.breakfasts),
    mains: summarize(pool.mains),
    sides: summarize(pool.sides),
    ...(pool.fatBudgetNotice === undefined ? {} : { fatBudgetNotice: pool.fatBudgetNotice }),
    ...(pool.poolNotices === undefined ? {} : { poolNotices: pool.poolNotices }),
  };
}

function collectInputCandidates(input: GenerateMealPlanInput): readonly RecipeDish[] {
  return [
    ...(input.candidates ?? []),
    ...(input.presetDishes ?? []),
    ...(input.userDishes ?? []),
  ];
}

function acceptedMealCandidates(
  candidates: readonly RecipeDish[],
  preferences: RecipePreferences | undefined,
): readonly RecipeDish[] {
  return filterUsableCandidates(candidates, preferences);
}

function buildPoolRequest(
  input: GenerateMealPlanInput,
  candidates: readonly RecipeDish[],
  useDefaultSelector: boolean,
): SelectWeeklyPoolRequest {
  const weeklyFloors = useDefaultSelector ? WEEKLY_FLOORS : undefined;
  return {
    candidates,
    preferences: input.preferences,
    ...(weeklyFloors === undefined ? {} : { weeklyFloors }),
    kcalScreen: {
      dailyKcalTarget: input.dailyKcalTarget,
      ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
      ...(input.staple === undefined ? {} : { staple: input.staple }),
    },
    ...(input.dailyProteinTarget !== undefined &&
      shouldCheckProteinAtPoolTime(candidates, useDefaultSelector)
      ? {
        proteinFloor: {
          dailyTargetGrams: input.dailyProteinTarget,
          ...(input.catalog === undefined ? {} : {
            catalog: input.catalog,
            stapleProteinHeadroomGrams: stapleProteinHeadroomGrams(input),
          }),
        },
      }
      : {}),
    ...(input.dailyFatTarget !== undefined
      ? {
        fatBudget: {
          dailyTargetGrams: input.dailyFatTarget,
          ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
        },
      }
      : {}),
  };
}

/**
 * Optimistic staple-lever protein credit for the pool feasibility screen:
 * the staple solver can allocate up to maxGrams per main meal (2 main meals),
 * and that staple carries protein the dish-only estimate ignores.
 */
function stapleProteinHeadroomGrams(input: GenerateMealPlanInput): number {
  if (input.catalog === undefined) return 0;
  const staple = input.staple ?? DEFAULT_STAPLE;
  try {
    return stapleNutrition({ slug: staple.slug, grams: staple.maxGrams * 2 }, input.catalog).proteinGrams;
  } catch {
    return 0;
  }
}

function formatWaivedFloors(waivedFloors: readonly WaivedWeeklyFloor[]): string {
  return [
    "Waived weekly floors (bucket fully excluded by safety filters):",
    ...waivedFloors.map((item) => `- ${item.bucket} (${item.floor}/wk): ${item.reason}`),
  ].join("\n");
}

function shouldCheckProteinAtPoolTime(
  candidates: readonly RecipeDish[],
  useDefaultSelector: boolean,
): boolean {
  // Single-main libraries have no protein headroom to screen against; the
  // planner's hard-violation check still guards the generated days.
  return !useDefaultSelector || candidates.filter(matchesMain).length >= 2;
}

function plannerInputFromPool(
  input: GenerateMealPlanInput,
  pool: {
    breakfasts: readonly RecipeDish[];
    mains: readonly RecipeDish[];
    sides: readonly RecipeDish[];
    all: readonly RecipeDish[];
  },
): MealPlanRequest {
  const { store: _store, ...request } = input;
  return {
    ...request,
    candidates: pool.all,
    presetDishes: [],
    userDishes: [],
    pools: {
      breakfasts: pool.breakfasts,
      mains: pool.mains,
      sides: pool.sides,
    },
  };
}

function blockedResultFromCannotSatisfy(
  input: GenerateMealPlanInput,
  cannotSatisfy: MealPlanInfeasibleResult,
  acceptedCandidates: readonly RecipeDish[] = [],
): GenerateMealPlanBlockedResult {
  const empty = emptyPlan(input.startDate);
  return {
    status: "blocked",
    plan: empty,
    cannotSatisfy,
    overview: formatCannotSatisfy(cannotSatisfy),
    coverage: buildCoverageReport(empty, {
      dailyProteinTarget: input.dailyProteinTarget,
      dailyFatTarget: input.dailyFatTarget,
      dailyCarbsTarget: input.dailyCarbsTarget,
      acceptedCandidates,
    }),
    procurement: buildProcurementList(empty, input.catalog),
    storedCount: 0,
  };
}

function poolCannotSatisfyResult(
  input: GenerateMealPlanInput,
  rawCandidates: readonly RecipeDish[],
  cannotSatisfy: PoolCannotSatisfy,
): MealPlanInfeasibleResult {
  const accepted = acceptedMealCandidates(rawCandidates, input.preferences);
  const type = accepted.length === 0 && rawCandidates.length > 0
    ? "safety_filter"
    : cannotSatisfy.reason.toLowerCase().includes("protein")
      ? "protein_floor"
      : "candidate_pool";
  return {
    reason: cannotSatisfy.reason,
    violations: [{
      type,
      date: input.startDate,
      actual: 0,
      target: type === "protein_floor" ? input.dailyProteinTarget ?? 1 : 1,
      message: cannotSatisfy.reason,
    }],
    suggestions: cannotSatisfy.suggestions,
  };
}

function matchesMain(dish: RecipeDish): boolean {
  return dish.role !== "side" && (
    dish.mealTypes === undefined ||
    dish.mealTypes.includes("lunch") ||
    dish.mealTypes.includes("dinner")
  );
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
    weeklyBudgets: buildWeeklyBudgets({ days }, {}),
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
  return [
    formatWeeklyBudgetLine(plan.weeklyBudgets),
    ...plan.days.map((day, index) => formatDayOverview(day.date, index, day.meals)),
  ].join("\n\n");
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
