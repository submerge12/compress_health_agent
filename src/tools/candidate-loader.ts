import type { RecipeDish, RecipePreferences } from "../engine/recipe-engine.js";
import type { DietLogRow, UserDishRow } from "../db/repository.js";
import { presetDishes } from "../data/preset-dishes.js";
import { dishBucketsRoles } from "../engine/classification.js";
import { allergenGroupsForMemorySubject } from "../engine/food-taxonomy.js";
import { resolveFoodSlug, resolveSeasoningSlug, type SeasoningLike } from "./slug-resolver.js";
import type { ToolContext } from "./context.js";

/**
 * Derive recommendation preferences from what the user has told the agent.
 * Active `dislike` memories (written by the `remember` tool) are resolved to
 * food slugs (rejected ingredients) or seasoning slugs (rejected seasonings),
 * unioned with any rejected seasonings stored in the seasoning-preference table.
 */
export interface LoadUserPreferenceOptions {
  asOfDate?: string;
  lookbackDays?: number;
}

export async function loadUserPreferences(
  ctx: ToolContext,
  options: LoadUserPreferenceOptions = {},
): Promise<RecipePreferences> {
  const { startDate, endDate } = recentWindow(options.asOfDate ?? todayIso(), options.lookbackDays ?? 7);
  const [dislikes, likes, tableRejectedSeasonings, planHistory, dietHistory] = await Promise.all([
    ctx.repo.listActiveMemories(ctx.userId, ["dislike"]),
    ctx.repo.listActiveMemories(ctx.userId, ["preference"]),
    ctx.repo.listRejectedSeasoningSlugs(ctx.userId),
    ctx.repo.listMealPlanEntriesRange(ctx.userId, startDate, endDate),
    ctx.repo.listDietLogsRange(ctx.userId, startDate, endDate),
  ]);

  const seasoningCatalog: readonly SeasoningLike[] = ctx.seasoningCatalog ?? ctx.seasoningRecords;
  const rejectedSeasonings = new Set<string>(tableRejectedSeasonings);
  const rejectedIngredients = new Set<string>();
  const allergens = new Set<string>();
  const preferredIngredients = new Set<string>();
  const preferredSeasonings = new Set<string>();
  const preferredMethods = new Set<string>();
  const recentDishSlugs = new Set<string>();
  const skippedCounts = new Map<string, number>();

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
      continue;
    }
    for (const group of allergenGroupsForMemorySubject(subject)) {
      allergens.add(group);
    }
  }

  for (const memory of likes) {
    const subject = memory.subject.trim();
    if (!subject) continue;
    const asFood = resolveFoodSlug(subject, ctx.catalog);
    if (asFood.slug !== undefined) {
      preferredIngredients.add(asFood.slug);
      continue;
    }
    const asSeasoning = resolveSeasoningSlug(subject, seasoningCatalog);
    if (asSeasoning.slug !== undefined) {
      preferredSeasonings.add(asSeasoning.slug);
      continue;
    }
    const method = resolvePreferredMethod(subject);
    if (method !== undefined) {
      preferredMethods.add(method);
    }
  }

  for (const entry of planHistory.filter((row) => isWithinWindow(row.planDate, startDate, endDate))) {
    const slug = entry.recipeSlug?.trim();
    if (!slug || !isBehaviorStatus(entry.status)) continue;
    recentDishSlugs.add(slug);
    if (entry.status === "skipped") {
      skippedCounts.set(slug, (skippedCounts.get(slug) ?? 0) + 1);
    }
  }

  for (const log of dietHistory.filter((row) => row.source === "substituted" && isWithinWindow(row.logDate, startDate, endDate))) {
    for (const slug of ingredientSlugsFromLog(log)) {
      const asFood = resolveFoodSlug(slug, ctx.catalog);
      preferredIngredients.add(asFood.slug ?? slug);
    }
  }

  return {
    rejectedSeasonings: [...rejectedSeasonings],
    rejectedIngredients: [...rejectedIngredients],
    allergens: [...allergens],
    preferredIngredients: [...preferredIngredients],
    preferredSeasonings: [...preferredSeasonings],
    preferredMethods: [...preferredMethods],
    recentDishSlugs: [...recentDishSlugs],
    avoidedDishSlugs: [...skippedCounts]
      .filter(([, count]) => count >= 2)
      .map(([slug]) => slug),
  };
}

function isBehaviorStatus(status: string): boolean {
  return status === "followed" || status === "substituted" || status === "skipped";
}

function ingredientSlugsFromLog(log: DietLogRow): string[] {
  return log.ingredientsJson
    .filter((ingredient) => ingredient["estimateSource"] !== "fallback")
    .map((ingredient) => ingredient["slug"])
    .filter((slug): slug is string => typeof slug === "string" && slug.trim().length > 0);
}

function recentWindow(asOfDate: string, lookbackDays: number): { startDate: string; endDate: string } {
  return {
    startDate: addDaysIso(asOfDate, -lookbackDays),
    endDate: addDaysIso(asOfDate, -1),
  };
}

function isWithinWindow(dateIso: string, startDate: string, endDate: string): boolean {
  return dateIso >= startDate && dateIso <= endDate;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const METHOD_ALIASES = new Map<string, string>([
  ["stir_fry", "stir_fry"],
  ["stirfry", "stir_fry"],
  ["pan_searing", "pan_searing"],
  ["pan_seared", "pan_searing"],
  ["searing", "pan_searing"],
  ["steaming", "steaming"],
  ["steamed", "steaming"],
  ["steam", "steaming"],
  ["boiling", "boiling"],
  ["boiled", "boiling"],
  ["braising", "braising"],
  ["braised", "braising"],
  ["cold_mixing", "cold_mixing"],
]);

function resolvePreferredMethod(subject: string): string | undefined {
  const normalized = subject.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return METHOD_ALIASES.get(normalized);
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
    allergenTags: classification.allergenTags,
    specialHandlingTags: classification.specialHandlingTags,
    frequencyHints: classification.frequencyHints,
    cookingDifficulties: classification.cookingDifficulties,
    availabilityTags: classification.availabilityTags,
  };
}
