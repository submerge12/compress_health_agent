import type { RecipeDish, RecipePreferences } from "../engine/recipe-engine.js";
import type { UserDishRow } from "../db/repository.js";
import { presetDishes } from "../data/preset-dishes.js";
import { dishBucketsRoles } from "../engine/classification.js";
import { resolveFoodSlug, resolveSeasoningSlug, type SeasoningLike } from "./slug-resolver.js";
import type { ToolContext } from "./context.js";

/**
 * Derive recommendation preferences from what the user has told the agent.
 * Active `dislike` memories (written by the `remember` tool) are resolved to
 * food slugs (rejected ingredients) or seasoning slugs (rejected seasonings),
 * unioned with any rejected seasonings stored in the seasoning-preference table.
 */
export async function loadUserPreferences(ctx: ToolContext): Promise<RecipePreferences> {
  const [dislikes, tableRejectedSeasonings] = await Promise.all([
    ctx.repo.listActiveMemories(ctx.userId, ["dislike"]),
    ctx.repo.listRejectedSeasoningSlugs(ctx.userId),
  ]);

  const seasoningCatalog: readonly SeasoningLike[] = ctx.seasoningCatalog ?? ctx.seasoningRecords;
  const rejectedSeasonings = new Set<string>(tableRejectedSeasonings);
  const rejectedIngredients = new Set<string>();

  for (const memory of dislikes) {
    const subject = memory.subject.trim();
    if (!subject) continue;
    const asFood = resolveFoodSlug(subject, ctx.catalog);
    if (asFood.slug !== undefined) {
      rejectedIngredients.add(asFood.slug);
      continue;
    }
    const asSeasoning = resolveSeasoningSlug(subject, seasoningCatalog);
    if (asSeasoning.slug !== undefined) {
      rejectedSeasonings.add(asSeasoning.slug);
    }
  }

  return {
    rejectedSeasonings: [...rejectedSeasonings],
    rejectedIngredients: [...rejectedIngredients],
  };
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
  const role = row.role ?? "main";
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
    role,
    ...(row.sideKind === null || row.sideKind === undefined ? {} : { sideKind: row.sideKind }),
    ...(role === "main" ? { selfContained: row.selfContained ?? true } : {}),
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
