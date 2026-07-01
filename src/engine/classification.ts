import type { MealCatalog } from "../tools/nutrition-estimate.js";
import type { RecipeDish } from "./recipe-engine.js";
import {
  allergenTagsForFood,
  allergenTagsForSeasoning,
  specialHandlingTagsForFood,
  specialHandlingTagsForSeasoning,
} from "./food-taxonomy.js";

export interface DishClassification {
  buckets: string[];
  roles: string[];
  weeklyFloors: Record<string, number>;
  allergenTags: string[];
  specialHandlingTags: string[];
  frequencyHints: Record<string, string>;
  cookingDifficulties: string[];
  availabilityTags: string[];
}

export function dishBucketsRoles(dish: RecipeDish, catalog: MealCatalog): DishClassification {
  const foodsBySlug = new Map(catalog.foods.map((food) => [food.slug, food]));
  const buckets = new Set<string>();
  const roles = new Set<string>();
  const allergenTags = new Set<string>();
  const specialHandlingTags = new Set<string>();
  const cookingDifficulties = new Set<string>();
  const availabilityTags = new Set<string>();
  const weeklyFloors: Record<string, number> = {};
  const frequencyHints: Record<string, string> = {};

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
    for (const tag of food.allergenTags ?? allergenTagsForFood(food.slug, food.category)) {
      allergenTags.add(tag);
    }
    for (const tag of food.specialHandlingTags ?? specialHandlingTagsForFood(food.slug, food.category)) {
      specialHandlingTags.add(tag);
    }
    if (food.frequencyHint !== undefined && food.frequencyHint !== null) {
      frequencyHints[food.slug] = food.frequencyHint;
    }
    if (food.cookingDifficulty !== undefined && food.cookingDifficulty !== null) {
      cookingDifficulties.add(food.cookingDifficulty);
    }
    if (food.availability !== undefined && food.availability !== null) {
      availabilityTags.add(food.availability);
    }
  }

  for (const seasoning of dish.seasonings) {
    for (const tag of allergenTagsForSeasoning(seasoning)) {
      allergenTags.add(tag);
    }
    for (const tag of specialHandlingTagsForSeasoning(seasoning)) {
      specialHandlingTags.add(tag);
    }
  }

  return {
    buckets: [...buckets].sort(),
    roles: [...roles].sort(),
    weeklyFloors,
    allergenTags: [...allergenTags].sort(),
    specialHandlingTags: [...specialHandlingTags].sort(),
    frequencyHints,
    cookingDifficulties: [...cookingDifficulties].sort(),
    availabilityTags: [...availabilityTags].sort(),
  };
}
