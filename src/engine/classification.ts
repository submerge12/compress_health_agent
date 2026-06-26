import type { MealCatalog } from "../tools/nutrition-estimate.js";
import type { RecipeDish } from "./recipe-engine.js";

export interface DishClassification {
  buckets: string[];
  roles: string[];
  weeklyFloors: Record<string, number>;
}

export function dishBucketsRoles(dish: RecipeDish, catalog: MealCatalog): DishClassification {
  const foodsBySlug = new Map(catalog.foods.map((food) => [food.slug, food]));
  const buckets = new Set<string>();
  const roles = new Set<string>();
  const weeklyFloors: Record<string, number> = {};

  for (const ingredient of dish.ingredients) {
    const food = foodsBySlug.get(ingredient.slug);
    if (food === undefined) continue;

    for (const bucket of food.executionBuckets ?? []) {
      buckets.add(bucket);
      const floor = food.weeklyFloor ?? 0;
      if (floor > 0) {
        weeklyFloors[bucket] = Math.max(weeklyFloors[bucket] ?? 0, floor);
      }
    }
    for (const role of food.roles ?? []) {
      roles.add(role);
    }
  }

  return {
    buckets: [...buckets].sort(),
    roles: [...roles].sort(),
    weeklyFloors,
  };
}
