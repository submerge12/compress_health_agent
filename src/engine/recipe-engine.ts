export type MealType = "breakfast" | "lunch" | "dinner";

export type RecipeSource = "preset" | "cooking_record" | "user";

export interface RecipeNutrition {
  kcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
}

export interface RecipeIngredient {
  slug: string;
  grams: number;
}

export interface RecipeDish {
  slug: string;
  name: string;
  mealTypes?: readonly MealType[];
  nutrition: RecipeNutrition;
  ingredients: readonly RecipeIngredient[];
  seasonings: readonly string[];
  source: RecipeSource;
  method?: string;
  notes?: string;
  lastServedAt?: string | null;
}

export interface RecipePreferences {
  rejectedSeasonings?: readonly string[];
  preferredIngredients?: readonly string[];
  preferredMethods?: readonly string[];
}

export interface RecipeTarget {
  kcal: number;
  proteinGrams?: number;
  protein?: number;
}

export interface RecipeRecommendationRequest {
  candidates: readonly RecipeDish[];
  target: RecipeTarget;
  mealType?: MealType;
  preferences?: RecipePreferences;
  recentDishSlugs?: readonly string[];
  limit?: number;
  asOfDate?: string;
}

export interface RankedRecipeOption extends RecipeDish {
  score: number;
  reasons: readonly string[];
  nutritionPreview: RecipeNutrition;
}

interface ScoreContext {
  targetProteinGrams: number;
  recentDishSlugs: ReadonlySet<string>;
  recentIngredientSlugs: ReadonlySet<string>;
  asOfDate?: string;
  preferences: RecipePreferences;
}

export function recommendRecipes(request: RecipeRecommendationRequest): RankedRecipeOption[] {
  validateRecommendationRequest(request);
  const context = buildScoreContext(request);
  return request.candidates
    .filter((dish) => matchesMealType(dish, request.mealType))
    .filter((dish) => !hasRejectedSeasoning(dish, context.preferences.rejectedSeasonings ?? []))
    .map((dish) => rankDish(dish, request.target.kcal, context))
    .sort(compareRankedOptions)
    .slice(0, request.limit ?? request.candidates.length);
}

export function hasRejectedSeasoning(
  dish: RecipeDish,
  rejectedSeasonings: readonly string[],
): boolean {
  const rejected = new Set(rejectedSeasonings.map(normalizeToken));
  return dish.seasonings.some((seasoning) => rejected.has(normalizeToken(seasoning)));
}

function validateRecommendationRequest(request: RecipeRecommendationRequest): void {
  if (request.candidates.length === 0) {
    throw new RangeError("At least one recipe candidate is required");
  }
  assertPositiveFinite(request.target.kcal, "target kcal");
  const protein = request.target.proteinGrams ?? request.target.protein ?? 0;
  if (protein < 0 || !Number.isFinite(protein)) {
    throw new RangeError("target protein must be a non-negative finite number");
  }
}

function buildScoreContext(request: RecipeRecommendationRequest): ScoreContext {
  const recentDishSlugs = new Set(request.recentDishSlugs ?? []);
  return {
    targetProteinGrams: request.target.proteinGrams ?? request.target.protein ?? 0,
    recentDishSlugs,
    recentIngredientSlugs: collectRecentIngredients(request.candidates, recentDishSlugs),
    asOfDate: request.asOfDate,
    preferences: request.preferences ?? {},
  };
}

function collectRecentIngredients(
  candidates: readonly RecipeDish[],
  recentDishSlugs: ReadonlySet<string>,
): ReadonlySet<string> {
  const ingredients = new Set<string>();
  for (const dish of candidates.filter((item) => recentDishSlugs.has(item.slug))) {
    for (const ingredient of dish.ingredients) ingredients.add(ingredient.slug);
  }
  return ingredients;
}

function rankDish(
  dish: RecipeDish,
  targetKcal: number,
  context: ScoreContext,
): RankedRecipeOption {
  const nutrientScore = scoreNutrients(dish, targetKcal, context.targetProteinGrams);
  const recencyPenalty = scoreRecencyPenalty(dish, context);
  const varietyBonus = scoreVarietyBonus(dish, context);
  const preferenceBonus = scorePreferenceBonus(dish, context.preferences);
  const score = roundTo(nutrientScore - recencyPenalty + varietyBonus + preferenceBonus, 3);
  return { ...dish, score, reasons: explainScore(recencyPenalty, varietyBonus), nutritionPreview: dish.nutrition };
}

function scoreNutrients(dish: RecipeDish, targetKcal: number, targetProteinGrams: number): number {
  const kcalPenalty = (Math.abs(dish.nutrition.kcal - targetKcal) / targetKcal) * 55;
  const proteinPenalty =
    targetProteinGrams === 0
      ? 0
      : (Math.abs(dish.nutrition.proteinGrams - targetProteinGrams) / targetProteinGrams) * 25;
  return 100 - kcalPenalty - proteinPenalty;
}

function scoreRecencyPenalty(dish: RecipeDish, context: ScoreContext): number {
  const explicitPenalty = context.recentDishSlugs.has(dish.slug) ? 45 : 0;
  const servedPenalty = scoreLastServedPenalty(dish.lastServedAt, context.asOfDate);
  return explicitPenalty + servedPenalty;
}

function scoreLastServedPenalty(lastServedAt: string | null | undefined, asOfDate?: string): number {
  if (!lastServedAt || !asOfDate) return 0;
  const elapsedDays = daysBetween(lastServedAt, asOfDate);
  if (elapsedDays < 0) return 0;
  if (elapsedDays <= 2) return 18;
  if (elapsedDays <= 7) return 8;
  return 0;
}

function scoreVarietyBonus(dish: RecipeDish, context: ScoreContext): number {
  const overlapsRecentIngredient = dish.ingredients.some((ingredient) =>
    context.recentIngredientSlugs.has(ingredient.slug),
  );
  return (overlapsRecentIngredient ? 0 : 5) + (dish.source === "cooking_record" ? 2 : 0);
}

function scorePreferenceBonus(dish: RecipeDish, preferences: RecipePreferences): number {
  const ingredientBonus = countMatches(
    dish.ingredients.map((ingredient) => ingredient.slug),
    preferences.preferredIngredients ?? [],
  );
  const methodBonus = dish.method === undefined ? 0 : countMatches([dish.method], preferences.preferredMethods ?? []);
  return ingredientBonus * 2 + methodBonus * 2;
}

function explainScore(recencyPenalty: number, varietyBonus: number): readonly string[] {
  const reasons: string[] = [];
  if (recencyPenalty > 0) reasons.push("recently served penalty applied");
  if (varietyBonus > 0) reasons.push("adds weekly variety");
  return reasons;
}

function matchesMealType(dish: RecipeDish, mealType: MealType | undefined): boolean {
  return mealType === undefined || dish.mealTypes === undefined || dish.mealTypes.includes(mealType);
}

function compareRankedOptions(left: RankedRecipeOption, right: RankedRecipeOption): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.slug.localeCompare(right.slug);
}

function countMatches(values: readonly string[], preferredValues: readonly string[]): number {
  const preferred = new Set(preferredValues.map(normalizeToken));
  return values.filter((value) => preferred.has(normalizeToken(value))).length;
}

function daysBetween(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 999;
  return Math.floor((end - start) / 86_400_000);
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
