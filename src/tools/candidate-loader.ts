import type { RecipeDish, RecipePreferences } from "../engine/recipe-engine.js";
import type { UserDishRow } from "../db/repository.js";
import { presetDishes } from "../data/preset-dishes.js";
import { dishBucketsRoles } from "../engine/classification.js";
import type { ToolContext } from "./context.js";

export async function loadUserPreferences(ctx: ToolContext): Promise<RecipePreferences> {
  const rejected = await ctx.repo.listRejectedSeasoningSlugs(ctx.userId);
  return { rejectedSeasonings: rejected };
}

export async function loadCandidateDishes(ctx: ToolContext): Promise<RecipeDish[]> {
  const records = await ctx.repo.listUserDishes(ctx.userId);
  const userDishes = records
    .filter(hasValidNutrition)
    .map(userDishToDish);
  const presetSlugs = new Set(presetDishes.map((d) => d.slug));
  const dedupedUser = userDishes.filter((d) => !presetSlugs.has(d.slug));
  return [...presetDishes, ...dedupedUser].map((dish) => withClassification(dish, ctx));
}

function userDishToDish(row: UserDishRow): RecipeDish {
  const ingredients = (row.ingredientsJson ?? []).map((item) => ({
    slug: String(item.slug ?? "unknown"),
    grams: Number(item.grams ?? 100),
  }));
  const seasonings = (row.seasoningsJson ?? []).map((item) => String(item.slug ?? item));
  return {
    slug: row.slug,
    name: row.name,
    mealTypes: row.mealCategory === "breakfast" ? ["breakfast"] : ["lunch", "dinner"],
    nutrition: {
      kcal: row.caloriesKcal,
      proteinGrams: row.proteinGrams,
      carbsGrams: row.carbsGrams,
      fatGrams: row.fatGrams,
      sodiumMg: row.sodiumMg,
    },
    ingredients,
    seasonings,
    source: "user",
    method: row.method ?? undefined,
  };
}

function hasValidNutrition(row: UserDishRow): boolean {
  return [
    row.caloriesKcal,
    row.proteinGrams,
    row.carbsGrams,
    row.fatGrams,
    row.sodiumMg,
  ].every(Number.isFinite) && row.caloriesKcal > 0;
}

function withClassification(dish: RecipeDish, ctx: ToolContext): RecipeDish {
  const classification = dishBucketsRoles(dish, ctx.catalog);
  return {
    ...dish,
    buckets: classification.buckets,
    roles: classification.roles,
    weeklyFloors: classification.weeklyFloors,
  };
}
