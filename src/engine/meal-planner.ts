import {
  hasRejectedIngredient,
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
  solveProteinTopUps,
  solveStaplePortionsForDay,
  stapleNutrition,
  type ProteinTopUpPortion,
  type Staple,
  type StaplePortion,
} from "./meal-composition.js";
import { scorePlan, type MealPlanScore } from "./meal-plan-scoring.js";
import {
  ENERGY_TOLERANCE_RATIO,
  MAX_ENERGY_TOLERANCE_RATIO,
  PROTEIN_FLOOR_RATIO,
  SODIUM_CAP_MG,
} from "./scoring-weights.js";
import type { MealCatalog } from "../tools/nutrition-estimate.js";

export type { MealType };

export interface MealPlanRequest {
  startDate: string;
  dailyKcalTarget: number;
  dailyProteinTarget?: number;
  dailyFatTarget?: number;
  dailyCarbsTarget?: number;
  catalog?: MealCatalog;
  staple?: Staple;
  presetDishes?: readonly RecipeDish[];
  userDishes?: readonly RecipeDish[];
  candidates?: readonly RecipeDish[];
  /**
   * Explicit role split from pool selection. When present it is authoritative:
   * the planner must not re-derive roles from mealTypes (a mealTypes-undefined
   * dish matches every role matcher and would leak mains into breakfasts).
   */
  pools?: {
    breakfasts: readonly RecipeDish[];
    mains: readonly RecipeDish[];
    sides: readonly RecipeDish[];
  };
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
  /** Protein-lever add-ons attached to this meal; included in `nutrition`. */
  proteinTopUps?: readonly ProteinTopUpPortion[];
  /**
   * Pre-vetted swaps from the weekly pool: substituting one and re-running
   * the levers keeps the day inside the kcal band and protein floor.
   */
  alternates?: readonly MealPlanAlternate[];
  nutrition: RecipeNutrition;
  status: "planned" | "followed" | "substituted" | "skipped";
}

export interface MealPlanAlternate {
  slug: string;
  name: string;
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
  weeklyBudgets: WeeklyBudgets;
  score?: MealPlanScore;
}

export type WeeklyBudgetStatus = "over" | "under" | "on_target" | "no_target";

export interface WeeklyBudget {
  actual: number;
  target: number;
  difference: number;
  percentDifference: number;
  status: WeeklyBudgetStatus;
}

export interface WeeklyBudgets {
  fat: WeeklyBudget;
  sodium: WeeklyBudget;
  carbs: WeeklyBudget;
}

export interface WeeklyBudgetTargets {
  dailyFatTarget?: number;
  dailySodiumTarget?: number;
  dailyCarbsTarget?: number;
}

export interface HardViolation {
  type: "safety_filter" | "candidate_pool" | "energy_band" | "protein_floor";
  date: string;
  actual: number;
  target: number;
  message: string;
}

export interface MealPlanInfeasibleResult {
  reason: string;
  violations: readonly HardViolation[];
  suggestions: readonly string[];
}

export class MealPlanInfeasibleError extends RangeError {
  readonly result: MealPlanInfeasibleResult;

  constructor(result: MealPlanInfeasibleResult) {
    super(result.reason);
    this.name = "MealPlanInfeasibleError";
    this.result = result;
  }
}

export interface MealPlanValidationOptions {
  dailyKcalTarget: number;
  dailyProteinTarget?: number;
  dailyFatTarget?: number;
  dailyCarbsTarget?: number;
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
  const rawCandidates = request.pools === undefined
    ? collectCandidates(request)
    : [...request.pools.breakfasts, ...request.pools.mains, ...request.pools.sides];
  const candidates = filterUsableCandidates(rawCandidates, request.preferences);
  if (candidates.length === 0) {
    throw new MealPlanInfeasibleError(noUsableCandidatesResult(request, rawCandidates.length));
  }

  const usable = new Set(candidates.map((dish) => dish.slug));
  const breakfastPool = request.pools === undefined
    ? candidates.filter(matchesBreakfast)
    : request.pools.breakfasts.filter((dish) => usable.has(dish.slug));
  const mainPool = request.pools === undefined
    ? candidates.filter(matchesMain)
    : request.pools.mains.filter((dish) => usable.has(dish.slug));
  const sidePool = request.pools === undefined
    ? candidates.filter(matchesSide)
    : request.pools.sides.filter((dish) => usable.has(dish.slug));
  if (breakfastPool.length === 0) {
    throw new MealPlanInfeasibleError(noMealRoleCandidatesResult(request.startDate, "breakfast"));
  }
  if (mainPool.length === 0) {
    throw new MealPlanInfeasibleError(noMealRoleCandidatesResult(request.startDate, "main meal"));
  }

  const entries: MealPlanEntry[] = [];
  const rotationMains = sortMainsByProteinDesc(mainPool, request.catalog);
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const date = addDays(request.startDate, dayIndex);
    const assignment = rotationAssignment(breakfastPool, rotationMains, sidePool, dayIndex);
    const dayEntries = buildDayEntries(
      request,
      date,
      dayIndex,
      assignment.breakfast,
      assignment.lunch,
      assignment.dinner,
      assignment.lunchSide,
      assignment.dinnerSide,
    );
    entries.push(...withMainAlternates(
      request,
      dayEntries,
      assignment,
      rotationMains,
      sidePool,
      date,
      dayIndex,
    ));
  }

  const budgetTargets = {
    dailyFatTarget: request.dailyFatTarget,
    dailyCarbsTarget: request.dailyCarbsTarget,
  };
  const plan = buildPlan(request.startDate, entries, [], budgetTargets);
  const hardViolations = hardViolationsForPlan(plan, request);
  if (hardViolations.length > 0) {
    throw new MealPlanInfeasibleError(buildInfeasibleResult(hardViolations));
  }
  const withViolations = buildPlan(request.startDate, entries, hardViolations, budgetTargets);
  return {
    ...withViolations,
    score: scorePlan(
      withViolations,
      {
        dailyKcalTarget: request.dailyKcalTarget,
        dailyProteinTarget: request.dailyProteinTarget,
        dailyFatTarget: request.dailyFatTarget,
        dailyCarbsTarget: request.dailyCarbsTarget,
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

export function buildWeeklyBudgets(plan: Pick<WeeklyMealPlan, "days">, targets: WeeklyBudgetTargets): WeeklyBudgets {
  return {
    fat: weeklyBudget(
      sumValues(plan.days.map((day) => day.totals.fatGrams)),
      targets.dailyFatTarget,
      1,
    ),
    sodium: weeklyBudget(
      sumValues(plan.days.map((day) => day.totals.sodiumMg)),
      targets.dailySodiumTarget ?? SODIUM_CAP_MG,
      0,
    ),
    carbs: weeklyBudget(
      sumValues(plan.days.map((day) => day.totals.carbsGrams)),
      targets.dailyCarbsTarget,
      1,
    ),
  };
}

export function formatWeeklyBudgetLine(budgets: WeeklyBudgets): string {
  return `Weekly budgets: ${formatBudget("fat", budgets.fat, "g")}; ${formatBudget("sodium", budgets.sodium, "mg")}; ${formatBudget("carbs", budgets.carbs, "g")}.`;
}

interface RotationAssignment {
  breakfast: RecipeDish;
  lunch: RecipeDish;
  dinner: RecipeDish;
  lunchSide?: RecipeDish;
  dinnerSide?: RecipeDish;
}

/**
 * Rule-based rotation fill (v2): lunch walks the main pool in order and
 * dinner walks it half a cycle ahead. With 7 mains this gives every main
 * exactly two uses per week and no main on consecutive days; smaller pools
 * degrade gracefully (a 1-main pool repeats it, as before).
 *
 * The pool is protein-sorted (strongest first), so the half-cycle offset
 * pairs strong-protein mains with weak ones and no day concentrates the
 * pool's weakest dishes — the daily protein floor is a hard rule, while fat
 * is a weekly budget and its per-day placement is free.
 */
function rotationAssignment(
  breakfastPool: readonly RecipeDish[],
  mainPool: readonly RecipeDish[],
  sidePool: readonly RecipeDish[],
  dayIndex: number,
): RotationAssignment {
  const dinnerOffset = Math.max(1, Math.ceil(mainPool.length / 2));
  const lunch = atCycle(mainPool, dayIndex);
  const dinner = atCycle(mainPool, dayIndex + dinnerOffset);
  const lunchSide = rotationSide(lunch, sidePool, dayIndex * 2);
  const dinnerSide = rotationSide(dinner, sidePool, dayIndex * 2 + 1);
  return {
    breakfast: atCycle(breakfastPool, dayIndex),
    lunch,
    dinner,
    ...(lunchSide === undefined ? {} : { lunchSide }),
    ...(dinnerSide === undefined ? {} : { dinnerSide }),
  };
}

/**
 * V2-P4 alternates: for the lunch and dinner entries, offer up to two pool
 * mains that (a) do not collide with this day's or the adjacent days'
 * rotation slots and (b) keep the day inside the hard gates after the levers
 * re-run — so a "换一个" swap can never invalidate the day.
 */
function withMainAlternates(
  request: MealPlanRequest,
  dayEntries: readonly MealPlanEntry[],
  assignment: RotationAssignment,
  rotationMains: readonly RecipeDish[],
  sidePool: readonly RecipeDish[],
  date: string,
  dayIndex: number,
): readonly MealPlanEntry[] {
  const [breakfastEntry, lunchEntry, dinnerEntry] = dayEntries;
  if (breakfastEntry === undefined || lunchEntry === undefined || dinnerEntry === undefined) {
    return dayEntries;
  }
  const adjacentSlugs = new Set<string>();
  for (const adjacentDay of [dayIndex - 1, dayIndex + 1]) {
    if (adjacentDay < 0 || adjacentDay > 6) continue;
    const adjacent = rotationAssignment([assignment.breakfast], rotationMains, sidePool, adjacentDay);
    adjacentSlugs.add(adjacent.lunch.slug);
    adjacentSlugs.add(adjacent.dinner.slug);
  }

  const alternatesFor = (slot: "lunch" | "dinner"): readonly MealPlanAlternate[] => {
    const alternates: MealPlanAlternate[] = [];
    for (const candidate of rotationMains) {
      if (alternates.length >= 2) break;
      if (candidate.slug === assignment.lunch.slug || candidate.slug === assignment.dinner.slug) continue;
      if (adjacentSlugs.has(candidate.slug)) continue;
      const trial = buildDayEntries(
        request,
        date,
        dayIndex,
        assignment.breakfast,
        slot === "lunch" ? candidate : assignment.lunch,
        slot === "dinner" ? candidate : assignment.dinner,
        slot === "lunch" ? rotationSide(candidate, sidePool, dayIndex * 2) : assignment.lunchSide,
        slot === "dinner" ? rotationSide(candidate, sidePool, dayIndex * 2 + 1) : assignment.dinnerSide,
      );
      if (dayMeetsHardGates(trial, request)) {
        alternates.push({ slug: candidate.slug, name: candidate.name });
      }
    }
    return alternates;
  };

  const lunchAlternates = alternatesFor("lunch");
  const dinnerAlternates = alternatesFor("dinner");
  return [
    breakfastEntry,
    { ...lunchEntry, ...(lunchAlternates.length === 0 ? {} : { alternates: lunchAlternates }) },
    { ...dinnerEntry, ...(dinnerAlternates.length === 0 ? {} : { alternates: dinnerAlternates }) },
  ];
}

function dayMeetsHardGates(dayEntries: readonly MealPlanEntry[], request: MealPlanRequest): boolean {
  const totals = sumNutrition(dayEntries.map((entry) => entry.nutrition));
  return isDailyKcalWithinTarget(totals.kcal, request.dailyKcalTarget, MAX_ENERGY_TOLERANCE_RATIO) &&
    isDailyProteinWithinFloor(totals.proteinGrams, request.dailyProteinTarget);
}

/** Rotation order: strongest protein first. Shared with the pool-time kcal screen. */
export function sortMainsByProteinDesc(
  mains: readonly RecipeDish[],
  catalog: MealCatalog | undefined,
): readonly RecipeDish[] {
  const proteinOf = (dish: RecipeDish): number => {
    if (catalog !== undefined) {
      try {
        return dishNutrition(dish, catalog).proteinGrams;
      } catch {
        // uncataloged ingredients fall back to the stored block
      }
    }
    return dish.nutrition.proteinGrams;
  };
  return [...mains].sort((left, right) => proteinOf(right) - proteinOf(left));
}

function rotationSide(
  main: RecipeDish,
  sidePool: readonly RecipeDish[],
  slot: number,
): RecipeDish | undefined {
  if (isSelfContainedMain(main) || sidePool.length === 0) return undefined;
  return atCycle(sidePool, slot);
}

function atCycle<T>(items: readonly T[], index: number): T {
  return items[index % items.length] as T;
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
  const staple = request.staple ?? DEFAULT_STAPLE;

  // Lever order: protein top-ups close the floor first (crediting only the
  // staple minimum the day will carry anyway), then the staple lever re-trues
  // kcal around the enlarged fixed load.
  const proteinTopUps = solveDayProteinTopUps(request, fixedNutrition, staple);
  const topUpNutrition = proteinTopUps.length === 0
    ? undefined
    : sumNutrition(proteinTopUps.map((topUp) => topUp.nutrition));
  const fixedWithTopUps = topUpNutrition === undefined
    ? fixedNutrition
    : addNutrition(fixedNutrition, topUpNutrition);
  const stapleSolve = solveStaplePortionsForDay({
    dailyKcalTarget: request.dailyKcalTarget,
    fixedNutrition: fixedWithTopUps,
    mainMealCount: 2,
    staple,
    catalog: request.catalog,
    energyToleranceRatio: ENERGY_TOLERANCE_RATIO,
  });
  const [lunchStaple, dinnerStaple] = stapleSolve.portions;
  const lunchComposedNutrition = composeMealNutrition(
    { dish: lunch, side: lunchSide, staple: lunchStaple },
    request.catalog,
  );
  const dinnerComposedBase = composeMealNutrition(
    { dish: dinner, side: dinnerSide, staple: dinnerStaple },
    request.catalog,
  );
  const dinnerComposedNutrition = topUpNutrition === undefined
    ? dinnerComposedBase
    : addNutrition(dinnerComposedBase, topUpNutrition);

  return [
    buildEntry(date, dayIndex, "breakfast", breakfast, breakfastNutrition),
    buildEntry(date, dayIndex, "lunch", lunch, lunchComposedNutrition, lunchStaple, lunchSide),
    {
      ...buildEntry(date, dayIndex, "dinner", dinner, dinnerComposedNutrition, dinnerStaple, dinnerSide),
      ...(proteinTopUps.length === 0 ? {} : { proteinTopUps }),
    },
  ];
}

/**
 * Protein lever: when the day's fixed dishes (plus the guaranteed staple
 * minimum) sit under the protein floor, append add-ons from the ordered
 * top-up menu within the day's remaining kcal headroom.
 */
function solveDayProteinTopUps(
  request: MealPlanRequest,
  fixedNutrition: RecipeNutrition,
  staple: Staple,
): readonly ProteinTopUpPortion[] {
  if (request.catalog === undefined || request.dailyProteinTarget === undefined) return [];
  const floor = Math.round(request.dailyProteinTarget * PROTEIN_FLOOR_RATIO);
  if (floor <= 0) return [];
  let minStaple: RecipeNutrition = { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 };
  try {
    minStaple = stapleNutrition({ slug: staple.slug, grams: staple.minGrams * 2 }, request.catalog);
  } catch {
    // staple missing from the catalog: solve without the staple credit
  }
  if (fixedNutrition.proteinGrams + minStaple.proteinGrams >= floor) return [];
  const solve = solveProteinTopUps({
    proteinFloorGrams: floor - minStaple.proteinGrams,
    fixedNutrition,
    remainingKcalBudget:
      request.dailyKcalTarget * (1 + ENERGY_TOLERANCE_RATIO) - fixedNutrition.kcal - minStaple.kcal,
    catalog: request.catalog,
    ...(request.preferences === undefined ? {} : { preferences: request.preferences }),
  });
  return solve.addOns;
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

function buildPlan(
  startDate: string,
  entries: readonly MealPlanEntry[],
  hardViolations: readonly HardViolation[],
  targets: WeeklyBudgetTargets = {},
): WeeklyMealPlan {
  const days = Array.from({ length: 7 }, (_, dayIndex) => buildDay(addDays(startDate, dayIndex), entries));
  const distinctDishCount = new Set(entries.map((entry) => entry.dish.slug)).size;
  return {
    startDate,
    days,
    entries,
    distinctDishCount,
    hardViolations,
    weeklyBudgets: buildWeeklyBudgets({ days }, targets),
  };
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
  // Fat is a SOFT constraint: it is not a hard violation. It stays as a ranking
  // signal and is reported as a weekly budget instead of a per-day advisory.
  return [...energyViolations, ...proteinViolations];
}

function buildInfeasibleResult(violations: readonly HardViolation[]): MealPlanInfeasibleResult {
  const types = new Set(violations.map((violation) => violation.type));
  const suggestions: string[] = [];
  if (types.has("energy_band")) {
    suggestions.push("relax the daily energy target or allow a wider staple portion range");
  }
  if (types.has("protein_floor")) {
    suggestions.push("add a lean protein dish or lower the protein target");
  }
  if (types.has("safety_filter")) {
    suggestions.push("add safe dishes that avoid the strict exclusions; do not relax allergies without medical guidance");
  }
  if (types.has("candidate_pool")) {
    suggestions.push("add meal-planning candidates for the missing meal role");
  }
  return {
    reason: `Cannot generate a meal plan that satisfies hard constraints: ${[...types].join(", ")}`,
    violations,
    suggestions,
  };
}

function noUsableCandidatesResult(request: MealPlanRequest, rawCandidateCount: number): MealPlanInfeasibleResult {
  const type = rawCandidateCount === 0 ? "candidate_pool" : "safety_filter";
  const violation: HardViolation = {
    type,
    date: request.startDate,
    actual: 0,
    target: 1,
    message: rawCandidateCount === 0
      ? "No meal-planning candidates are available"
      : "All meal-planning candidates were removed by strict exclusions",
  };
  return buildInfeasibleResult([violation]);
}

function noMealRoleCandidatesResult(startDate: string, role: string): MealPlanInfeasibleResult {
  return buildInfeasibleResult([{
    type: "candidate_pool",
    date: startDate,
    actual: 0,
    target: 1,
    message: `No allowed ${role} candidates remain after safety filters`,
  }]);
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

function collectCandidates(request: MealPlanRequest): readonly RecipeDish[] {
  return [...(request.candidates ?? []), ...(request.presetDishes ?? []), ...(request.userDishes ?? [])];
}

export function filterUsableCandidates(
  candidates: readonly RecipeDish[],
  preferences: RecipePreferences | undefined,
): readonly RecipeDish[] {
  const rejectedSeasonings = preferences?.rejectedSeasonings ?? [];
  const rejectedIngredients = [
    ...(preferences?.rejectedIngredients ?? []),
  ];
  return candidates.filter((dish) => {
    if (hasRejectedSeasoning(dish, rejectedSeasonings)) return false;
    return !hasRejectedIngredient(dish, rejectedIngredients, preferences?.allergens ?? []);
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

function weeklyBudget(actualRaw: number, dailyTarget: number | undefined, decimals: number): WeeklyBudget {
  const actual = roundTo(actualRaw, decimals);
  const positiveDailyTarget = positiveTarget(dailyTarget);
  const target = positiveDailyTarget === undefined ? 0 : roundTo(positiveDailyTarget * 7, decimals);
  const difference = roundTo(actual - target, decimals);
  const percentDifference = target === 0 ? 0 : roundTo(Math.abs(difference) / target * 100, 1);
  const status: WeeklyBudgetStatus = target === 0
    ? "no_target"
    : difference > 0
      ? "over"
      : difference < 0
        ? "under"
        : "on_target";
  return { actual, target, difference, percentDifference, status };
}

function formatBudget(label: string, budget: WeeklyBudget, unit: string): string {
  if (budget.status === "no_target") return `${label} ${formatNumber(budget.actual)}${unit} logged, no weekly target`;
  return `${label} ${formatNumber(budget.actual)}${unit} / ${formatNumber(budget.target)}${unit}, ${formatNumber(budget.percentDifference)}% ${budget.status === "on_target" ? "on target" : budget.status}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function sumValues(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
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

function positiveTarget(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
