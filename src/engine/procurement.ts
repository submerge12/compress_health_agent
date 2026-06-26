import type { WeeklyMealPlan } from "./meal-planner.js";
import type { MealCatalog } from "../tools/nutrition-estimate.js";

export interface ProcurementOptions {
  bufferRatio?: number;
  roundToGrams?: number;
}

export interface ProcurementItem {
  slug: string;
  totalGrams: number;
  bufferedGrams: number;
  buckets: readonly string[];
  roles: readonly string[];
  keyFood: boolean;
  dishCount: number;
}

export interface ProcurementList {
  bufferRatio: number;
  roundToGrams: number;
  items: readonly ProcurementItem[];
}

const KEY_FOOD_BUCKETS = new Set([
  "red_meat",
  "lean_white_meat",
  "deep_sea_fish",
  "shellfish",
  "soy_product",
  "egg",
  "dairy",
]);

export function buildProcurementList(
  plan: WeeklyMealPlan,
  catalog?: MealCatalog,
  options: ProcurementOptions = {},
): ProcurementList {
  const bufferRatio = options.bufferRatio ?? 1.15;
  const roundToGrams = options.roundToGrams ?? 10;
  const catalogBySlug = new Map((catalog?.foods ?? []).map((food) => [food.slug, food]));
  const items = new Map<string, { grams: number; dishes: Set<string>; buckets: Set<string>; roles: Set<string> }>();

  for (const entry of plan.entries) {
    for (const ingredient of entry.dish.ingredients) {
      const existing = items.get(ingredient.slug) ?? {
        grams: 0,
        dishes: new Set<string>(),
        buckets: new Set<string>(),
        roles: new Set<string>(),
      };
      existing.grams += ingredient.grams;
      existing.dishes.add(entry.dish.slug);

      const food = catalogBySlug.get(ingredient.slug);
      const buckets = food?.executionBuckets ?? entry.dish.buckets ?? [];
      const roles = food?.roles ?? entry.dish.roles ?? [];
      for (const bucket of buckets) existing.buckets.add(bucket);
      for (const role of roles) existing.roles.add(role);
      items.set(ingredient.slug, existing);
    }
  }

  return {
    bufferRatio,
    roundToGrams,
    items: [...items.entries()]
      .map(([slug, item]) => ({
        slug,
        totalGrams: round1(item.grams),
        bufferedGrams: roundUp(item.grams * bufferRatio, roundToGrams),
        buckets: [...item.buckets].sort(),
        roles: [...item.roles].sort(),
        keyFood: [...item.buckets].some((bucket) => KEY_FOOD_BUCKETS.has(bucket)),
        dishCount: item.dishes.size,
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
  };
}

function roundUp(value: number, increment: number): number {
  return Math.ceil(value / increment) * increment;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
