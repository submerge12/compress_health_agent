import { aggregateNutrition } from "./nutrition.js";
import type { RecipeDish, RecipeNutrition } from "./recipe-engine.js";
import type { MealCatalog } from "../tools/nutrition-estimate.js";

/**
 * Nutrition recomputed from a dish's gram-bearing ingredient list against the
 * food catalog. This is the arithmetic base for portion scaling: once a dish's
 * primary-protein or staple grams change, the stored per-serving nutrition
 * block is stale and this recompute is the only honest value.
 *
 * Only `ingredients` are counted. `seasonings` is a slug list without grams,
 * so anything it contributes (cooking oil above all) shows up as divergence,
 * not as computed nutrition — see {@link dishNutritionDivergence}.
 */
export function computeDishNutritionFromIngredients(
  dish: RecipeDish,
  catalog: MealCatalog,
): RecipeNutrition {
  const known = new Set(catalog.foods.map((food) => food.slug));
  const counted = dish.ingredients.filter((ingredient) => known.has(ingredient.slug));
  const aggregate = aggregateNutrition({ foods: counted, foodRecords: catalog.foods });
  return {
    kcal: Math.round(aggregate.total.kcal),
    proteinGrams: roundTo1(aggregate.total.proteinGrams),
    carbsGrams: roundTo1(aggregate.total.carbsGrams),
    fatGrams: roundTo1(aggregate.total.fatGrams),
    sodiumMg: Math.round(aggregate.total.sodiumMg),
  };
}

export interface DishNutritionDivergence {
  slug: string;
  stored: RecipeNutrition;
  computed: RecipeNutrition;
  /**
   * stored − computed, per macro. Positive values are nutrition the stored
   * block claims but no gram-bearing ingredient accounts for.
   *
   * Interpreting the parts:
   * - kcal/carbs divergence on non-selfContained mains includes the implicit
   *   staple (rice) share their stored blocks carry.
   * - fat divergence is dominated by ungrammed seasonings — cooking oil and
   *   sauces. This is the rubric's "unattributed fat" (S6) metric; driving it
   *   toward zero means moving oil into `ingredients` with explicit grams.
   */
  unattributed: RecipeNutrition;
  /** Ingredient slugs absent from the catalog; computed under-counts when non-empty. */
  missingIngredients: readonly string[];
}

export function dishNutritionDivergence(
  dish: RecipeDish,
  catalog: MealCatalog,
): DishNutritionDivergence {
  const known = new Set(catalog.foods.map((food) => food.slug));
  const computed = computeDishNutritionFromIngredients(dish, catalog);
  return {
    slug: dish.slug,
    stored: dish.nutrition,
    computed,
    unattributed: {
      kcal: Math.round(dish.nutrition.kcal - computed.kcal),
      proteinGrams: roundTo1(dish.nutrition.proteinGrams - computed.proteinGrams),
      carbsGrams: roundTo1(dish.nutrition.carbsGrams - computed.carbsGrams),
      fatGrams: roundTo1(dish.nutrition.fatGrams - computed.fatGrams),
      sodiumMg: Math.round(dish.nutrition.sodiumMg - computed.sodiumMg),
    },
    missingIngredients: dish.ingredients
      .map((ingredient) => ingredient.slug)
      .filter((slug) => !known.has(slug)),
  };
}

function roundTo1(value: number): number {
  return Math.round(value * 10) / 10;
}
