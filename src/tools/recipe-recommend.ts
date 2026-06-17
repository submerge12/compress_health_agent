import {
  recommendRecipes,
  type MealType,
  type RankedRecipeOption,
  type RecipeDish,
  type RecipePreferences,
} from "../engine/recipe-engine.js";

export interface RecipeRecommendInput {
  mealType: MealType;
  maxKcal: number;
  candidates: readonly RecipeDish[];
  preferences?: RecipePreferences;
  recentDishSlugs?: readonly string[];
}

export interface RecipeRecommendResult {
  options: readonly RankedRecipeOption[];
  summary: string;
}

export function recipeRecommend(input: RecipeRecommendInput): RecipeRecommendResult {
  validateRecipeRecommendInput(input);
  const candidates = input.candidates.filter((dish) => dish.nutrition.kcal <= input.maxKcal);
  if (candidates.length === 0) return { options: [], summary: "No matching recipes under the kcal limit." };
  const options = recommendRecipes({
    candidates,
    mealType: input.mealType,
    target: { kcal: input.maxKcal },
    preferences: input.preferences,
    recentDishSlugs: input.recentDishSlugs,
    limit: 3,
  });
  return { options, summary: formatRecommendationSummary(options) };
}

function validateRecipeRecommendInput(input: RecipeRecommendInput): void {
  if (!Number.isFinite(input.maxKcal) || input.maxKcal <= 0) {
    throw new RangeError("maxKcal must be a positive finite number");
  }
}

function formatRecommendationSummary(options: readonly RankedRecipeOption[]): string {
  if (options.length === 0) return "No matching recipes after applying preferences.";
  return options
    .map(
      (option, index) =>
        `${index + 1}. ${option.name}: ${option.nutritionPreview.kcal} kcal, ${option.nutritionPreview.proteinGrams}g protein`,
    )
    .join("\n");
}
