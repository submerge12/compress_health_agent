import type { MealPlanEntry, WeeklyMealPlan } from "./meal-planner.js";
import type { RecipePreferences } from "./recipe-engine.js";
import {
  DEFAULT_SCORING_WEIGHTS,
  MAX_DISH_USES_PER_WEEK,
  MIN_DISTINCT_DISHES,
  SODIUM_CAP_MG,
  WEEKLY_FLOORS,
  type MealPlanScoringWeights,
} from "./scoring-weights.js";

export interface PlanScoringProfile {
  dailyKcalTarget?: number;
  dailyProteinTarget?: number;
  weeklyFloors?: Readonly<Record<string, number>>;
}

export interface MealPlanScoreBreakdown {
  protein: number;
  weeklyFloor: number;
  sodium: number;
  repetition: number;
  macro: number;
  diversity: number;
  preferenceBonus: number;
  recency: number;
}

export interface MealPlanScore {
  penalty: number;
  breakdown: MealPlanScoreBreakdown;
}

export function scorePlan(
  plan: WeeklyMealPlan,
  profile: PlanScoringProfile,
  preferences: RecipePreferences = {},
  weights: MealPlanScoringWeights = DEFAULT_SCORING_WEIGHTS,
): MealPlanScore {
  const raw = {
    protein: proteinPenalty(plan, profile.dailyProteinTarget ?? 0),
    weeklyFloor: weeklyFloorPenalty(plan, profile.weeklyFloors ?? WEEKLY_FLOORS),
    sodium: sodiumPenalty(plan),
    repetition: repetitionPenalty(plan.entries),
    macro: macroPenalty(plan, profile.dailyKcalTarget ?? 0),
    diversity: diversityPenalty(plan),
    preferenceBonus: preferenceBonus(plan.entries, preferences),
    recency: recencyPenalty(plan.entries),
  };
  const penalty =
    raw.protein * weights.protein +
    raw.weeklyFloor * weights.weeklyFloor +
    raw.sodium * weights.sodium +
    raw.repetition * weights.repetition +
    raw.macro * weights.macro +
    raw.diversity * weights.diversity -
    raw.preferenceBonus * weights.preferenceBonus +
    raw.recency * weights.recency;

  return {
    penalty: round3(Math.max(0, penalty)),
    breakdown: {
      protein: round3(raw.protein),
      weeklyFloor: round3(raw.weeklyFloor),
      sodium: round3(raw.sodium),
      repetition: round3(raw.repetition),
      macro: round3(raw.macro),
      diversity: round3(raw.diversity),
      preferenceBonus: round3(raw.preferenceBonus),
      recency: round3(raw.recency),
    },
  };
}

function proteinPenalty(plan: WeeklyMealPlan, target: number): number {
  if (target <= 0) return 0;
  return average(plan.days.map((day) => Math.max(0, (target - day.totals.proteinGrams) / target)));
}

function weeklyFloorPenalty(plan: WeeklyMealPlan, configFloors: Readonly<Record<string, number>>): number {
  // Seed floors from config so a bucket that is entirely absent from the plan
  // still registers a deficit (the selected dishes alone can't reveal it).
  const floors = new Map<string, number>(Object.entries(configFloors));
  const counts = new Map<string, number>();
  for (const entry of plan.entries) {
    for (const [bucket, floor] of Object.entries(entry.dish.weeklyFloors ?? {})) {
      floors.set(bucket, Math.max(floors.get(bucket) ?? 0, floor));
    }
    for (const bucket of entry.dish.buckets ?? []) {
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
  }
  const deficits = [...floors.entries()]
    .filter(([, floor]) => floor > 0)
    .map(([bucket, floor]) => Math.max(0, floor - (counts.get(bucket) ?? 0)) / floor);
  return deficits.length === 0 ? 0 : deficits.reduce((sum, item) => sum + item, 0);
}

function sodiumPenalty(plan: WeeklyMealPlan): number {
  return average(plan.days.map((day) => Math.max(0, (day.totals.sodiumMg - SODIUM_CAP_MG) / SODIUM_CAP_MG)));
}

function macroPenalty(plan: WeeklyMealPlan, dailyKcalTarget: number): number {
  if (dailyKcalTarget <= 0) return 0;
  return average(plan.days.map((day) => {
    const fatPct = day.totals.fatGrams * 9 / Math.max(1, day.totals.kcal);
    const carbPct = day.totals.carbsGrams * 4 / Math.max(1, day.totals.kcal);
    return Math.abs(fatPct - 0.3) + Math.abs(carbPct - 0.45);
  }));
}

function repetitionPenalty(entries: readonly MealPlanEntry[]): number {
  let repeated = 0;
  for (let index = 2; index < entries.length; index += 1) {
    const current = entries[index];
    const previous = entries[index - 1];
    const before = entries[index - 2];
    if (!current || !previous || !before) continue;
    const currentIngredients = new Set(current.dish.ingredients.map((ingredient) => ingredient.slug));
    const previousIngredients = new Set(previous.dish.ingredients.map((ingredient) => ingredient.slug));
    const beforeIngredients = new Set(before.dish.ingredients.map((ingredient) => ingredient.slug));
    if ([...currentIngredients].some((slug) => previousIngredients.has(slug) && beforeIngredients.has(slug))) {
      repeated += 1;
    }
  }
  return entries.length === 0 ? 0 : repeated / entries.length;
}

function diversityPenalty(plan: WeeklyMealPlan): number {
  const uses = new Map<string, number>();
  for (const entry of plan.entries) {
    uses.set(entry.dish.slug, (uses.get(entry.dish.slug) ?? 0) + 1);
  }
  const distinctPenalty = Math.max(0, (MIN_DISTINCT_DISHES - plan.distinctDishCount) / MIN_DISTINCT_DISHES);
  const overuse = [...uses.values()].reduce((sum, count) => sum + Math.max(0, count - MAX_DISH_USES_PER_WEEK), 0);
  return distinctPenalty + (plan.entries.length === 0 ? 0 : overuse / plan.entries.length);
}

function preferenceBonus(entries: readonly MealPlanEntry[], preferences: RecipePreferences): number {
  const preferredIngredients = new Set((preferences.preferredIngredients ?? []).map(normalize));
  const preferredMethods = new Set((preferences.preferredMethods ?? []).map(normalize));
  let matches = 0;
  for (const entry of entries) {
    matches += entry.dish.ingredients.filter((ingredient) => preferredIngredients.has(normalize(ingredient.slug))).length;
    if (entry.dish.method && preferredMethods.has(normalize(entry.dish.method))) matches += 1;
  }
  return Math.min(6, matches) / 6;
}

function recencyPenalty(entries: readonly MealPlanEntry[]): number {
  return entries.filter((entry) => entry.dish.lastServedAt !== undefined && entry.dish.lastServedAt !== null).length /
    Math.max(1, entries.length);
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, item) => sum + item, 0) / values.length;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
