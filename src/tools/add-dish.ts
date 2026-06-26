import { aggregateNutrition } from "../engine/nutrition.js";
import type { NutritionEntry, NutritionRecord } from "../engine/types.js";
import { dishBucketsRoles } from "../engine/classification.js";
import { STAPLES } from "../engine/meal-composition.js";
import type { DishRole, SideKind } from "../engine/recipe-engine.js";
import type { UserDishRow, UserDishMealCategory } from "../db/repository.js";
import type { MealCatalog } from "./nutrition-estimate.js";
import { resolveFoodSlug, resolveSeasoningSlug, slugifyDishName } from "./slug-resolver.js";

export type DishSource = "user_nl" | "agent_research" | "preset";

export interface DishDraftIngredient {
  slug?: string;
  name?: string;
  grams: number;
}

export interface DishDraft {
  name: string;
  mealCategory: UserDishMealCategory;
  role?: DishRole;
  sideKind?: SideKind;
  selfContained?: boolean;
  ingredients: DishDraftIngredient[];
  seasonings: string[];
  method?: string;
  source: DishSource;
  notes?: string;
}

export interface ResolvedDish {
  name: string;
  mealCategory: UserDishMealCategory;
  role: DishRole;
  sideKind?: SideKind;
  selfContained: boolean;
  ingredients: NutritionEntry[];
  seasonings: string[];
  method?: string;
  source: DishSource;
  notes?: string;
  slug: string;
  nutrition: {
    kcal: number;
    proteinGrams: number;
    carbsGrams: number;
    fatGrams: number;
    sodiumMg: number;
  };
  buckets: string[];
  roles: string[];
  unresolved: string[];
}

export interface ProposeDishInput {
  naturalLanguage?: string;
  draft?: DishDraft;
}

export interface AddDishDeps {
  catalog: MealCatalog;
  seasoningRecords: readonly NutritionRecord[];
}

const STAPLE_SLUGS = new Set(STAPLES.map((staple) => staple.slug));

export function proposeDish(input: ProposeDishInput, deps: AddDishDeps): ResolvedDish {
  const draft = draftFromInput(input);
  const role = requireDishRole(draft.role ?? "main");
  const sideKind = role === "side" ? requireSideKind(draft.sideKind) : undefined;
  const selfContained = role === "side" ? false : draft.selfContained ?? true;
  const unresolved: string[] = [];
  const ingredients: NutritionEntry[] = [];

  for (const ingredient of draft.ingredients) {
    assertPositiveNumber(ingredient.grams, "ingredient grams");
    const raw = ingredient.slug ?? ingredient.name;
    if (raw === undefined || raw.trim() === "") {
      unresolved.push("");
      continue;
    }
    const resolution = resolveFoodSlug(raw, deps.catalog);
    if (resolution.slug === undefined) {
      unresolved.push(resolution.unresolved ?? raw);
      continue;
    }
    ingredients.push({ slug: resolution.slug, grams: ingredient.grams });
  }

  const seasonings = resolveSeasonings(draft.seasonings, deps.seasoningRecords);
  const nutrition = computeDishNutrition(ingredients, deps.catalog);
  const classification = dishBucketsRoles(
    {
      slug: slugifyDishName(draft.name),
      name: draft.name,
      mealTypes: draft.mealCategory === "breakfast" ? ["breakfast"] : ["lunch", "dinner"],
      nutrition,
      ingredients,
      seasonings,
      source: draft.source === "preset" ? "preset" : "user",
      role,
      ...(sideKind === undefined ? {} : { sideKind }),
      selfContained,
      method: draft.method,
      notes: draft.notes,
    },
    deps.catalog,
  );

  return {
    name: requireText(draft.name, "name"),
    mealCategory: requireMealCategory(draft.mealCategory),
    role,
    ...(sideKind === undefined ? {} : { sideKind }),
    selfContained,
    ingredients,
    seasonings,
    ...(draft.method !== undefined ? { method: draft.method } : {}),
    source: draft.source,
    ...(draft.notes !== undefined ? { notes: draft.notes } : {}),
    slug: slugifyDishName(draft.name),
    nutrition,
    buckets: classification.buckets,
    roles: classification.roles,
    unresolved,
  };
}

export function validateResolvedDish(dish: ResolvedDish, catalog: MealCatalog): void {
  requireText(dish.name, "name");
  requireMealCategory(dish.mealCategory);
  const role = requireDishRole(dish.role);
  if (role === "side") requireSideKind(dish.sideKind);
  if (role === "side" && dish.mealCategory !== "main") {
    throw new RangeError("side dishes must use main mealCategory");
  }
  if (role === "main" && dish.sideKind !== undefined) {
    throw new RangeError("main dishes must not include sideKind");
  }
  if (dish.ingredients.length === 0) throw new RangeError("dish must include at least one ingredient");
  if (dish.unresolved.length > 0) throw new RangeError("dish has unresolved ingredients");
  const catalogBySlug = new Map(catalog.foods.map((food) => [food.slug, food]));
  for (const ingredient of dish.ingredients) {
    const food = catalogBySlug.get(ingredient.slug);
    if (food === undefined) {
      throw new RangeError(`unknown ingredient slug: ${ingredient.slug}`);
    }
    if (dish.mealCategory === "main" && STAPLE_SLUGS.has(ingredient.slug)) {
      throw new RangeError("main dishes must not include staple ingredients");
    }
    if (role === "side" && !isAllowedSideIngredient(food)) {
      throw new RangeError("side dishes must only include vegetable or soup ingredients");
    }
    assertPositiveNumber(ingredient.grams, "ingredient grams");
  }
  const nutrition = computeDishNutrition(dish.ingredients, catalog);
  if (nutrition.kcal <= 0) throw new RangeError("dish nutrition kcal must be positive");
  if (nutrition.proteinGrams < 0) throw new RangeError("dish protein must be non-negative");
}

export function userDishRowFromResolvedDish(
  userId: string,
  dish: ResolvedDish,
  catalog: MealCatalog,
): Omit<UserDishRow, "id"> {
  validateResolvedDish(dish, catalog);
  const nutrition = computeDishNutrition(dish.ingredients, catalog);
  return {
    userId,
    slug: dish.slug,
    name: dish.name,
    mealCategory: dish.mealCategory,
    role: dish.role,
    sideKind: dish.sideKind ?? null,
    selfContained: dish.selfContained,
    ingredientsJson: dish.ingredients.map((ingredient) => ({ ...ingredient })),
    seasoningsJson: dish.seasonings.map((slug) => ({ slug })),
    method: dish.method ?? null,
    caloriesKcal: nutrition.kcal,
    proteinGrams: nutrition.proteinGrams,
    carbsGrams: nutrition.carbsGrams,
    fatGrams: nutrition.fatGrams,
    sodiumMg: nutrition.sodiumMg,
    source: dish.source,
  };
}

function draftFromInput(input: ProposeDishInput): DishDraft {
  const hasNaturalLanguage = input.naturalLanguage !== undefined;
  const hasDraft = input.draft !== undefined;
  if (hasNaturalLanguage === hasDraft) {
    throw new RangeError("provide exactly one of naturalLanguage or draft");
  }
  if (input.draft !== undefined) return input.draft;
  return parseNaturalLanguage(requireText(input.naturalLanguage, "naturalLanguage"));
}

function parseNaturalLanguage(text: string): DishDraft {
  const tokens = text.match(/(\d+(?:\.\d+)?)\s*g\s+([\p{L}\p{N}_]+)/giu) ?? [];
  const ingredients = tokens.map((token) => {
    const match = token.match(/(\d+(?:\.\d+)?)\s*g\s+([\p{L}\p{N}_]+)/iu);
    return {
      name: match?.[2] ?? token,
      grams: Number(match?.[1] ?? 0),
    };
  });
  return {
    name: text.split(/[,:;]/)[0]?.trim() || text,
    mealCategory: "main",
    ingredients,
    seasonings: [],
    source: "user_nl",
  };
}

function resolveSeasonings(
  values: readonly string[],
  seasonings: readonly NutritionRecord[],
): string[] {
  return values
    .map((value) => resolveSeasoningSlug(value, seasonings).slug ?? value)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function computeDishNutrition(ingredients: readonly NutritionEntry[], catalog: MealCatalog): ResolvedDish["nutrition"] {
  const aggregate = aggregateNutrition({ foods: ingredients, foodRecords: catalog.foods });
  return {
    kcal: aggregate.total.kcal,
    proteinGrams: aggregate.total.proteinGrams,
    carbsGrams: aggregate.total.carbsGrams,
    fatGrams: aggregate.total.fatGrams,
    sodiumMg: aggregate.total.sodiumMg,
  };
}

function requireMealCategory(value: unknown): UserDishMealCategory {
  if (value !== "breakfast" && value !== "main") {
    throw new RangeError("mealCategory must be breakfast or main");
  }
  return value;
}

function requireDishRole(value: unknown): DishRole {
  if (value !== "main" && value !== "side") {
    throw new RangeError("role must be main or side");
  }
  return value;
}

function requireSideKind(value: unknown): SideKind {
  if (value !== "vegetable" && value !== "soup") {
    throw new RangeError("sideKind must be vegetable or soup");
  }
  return value;
}

function isAllowedSideIngredient(food: MealCatalog["foods"][number]): boolean {
  const category = food.category?.toLowerCase();
  const buckets = new Set((food.executionBuckets ?? []).map((bucket) => bucket.toLowerCase()));
  return (
    category === "vegetable" ||
    category === "mushroom" ||
    category === "seaweed" ||
    buckets.has("vegetable")
  );
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new RangeError(`${name} is required`);
  return trimmed;
}

function assertPositiveNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
}
