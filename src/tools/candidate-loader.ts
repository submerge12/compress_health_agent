import type { RecipeDish, RecipePreferences } from "../engine/recipe-engine.js";
import type { CookingRecordRow } from "../db/repository.js";
import { presetDishes } from "../data/preset-dishes.js";
import type { ToolContext } from "./context.js";

export async function loadUserPreferences(ctx: ToolContext): Promise<RecipePreferences> {
  const rejected = await ctx.repo.listRejectedSeasoningSlugs(ctx.userId);
  return { rejectedSeasonings: rejected };
}

export async function loadCandidateDishes(ctx: ToolContext): Promise<RecipeDish[]> {
  const records = await ctx.repo.listCookingRecords(ctx.userId);
  const userDishes = records
    .filter((r) => r.caloriesKcal > 0)
    .map(cookingRecordToDish);
  const presetSlugs = new Set(presetDishes.map((d) => d.slug));
  const dedupedUser = userDishes.filter((d) => !presetSlugs.has(d.slug));
  return [...presetDishes, ...dedupedUser];
}

function cookingRecordToDish(row: CookingRecordRow): RecipeDish {
  const ingredients = (row.ingredientsJson ?? []).map((item) => ({
    slug: String(item.slug ?? "unknown"),
    grams: Number(item.grams ?? 100),
  }));
  const seasonings = (row.seasoningsJson ?? []).map((item) => String(item.slug ?? item));
  return {
    slug: slugify(row.dishName),
    name: row.dishName,
    nutrition: {
      kcal: row.caloriesKcal,
      proteinGrams: row.proteinGrams,
      carbsGrams: row.carbsGrams,
      fatGrams: row.fatGrams,
      sodiumMg: row.sodiumMg,
    },
    ingredients,
    seasonings,
    source: "cooking_record",
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_|_$/g, "");
}
