import { matchFood } from "./food-matcher.js";
import type { MealCatalog } from "./nutrition-estimate.js";

export interface SlugResolution {
  slug?: string;
  unresolved?: string;
}

export interface SeasoningLike {
  slug: string;
  name?: string;
  aliases?: readonly string[];
}

export function resolveFoodSlug(input: string, catalog: MealCatalog): SlugResolution {
  const trimmed = input.trim();
  if (!trimmed) return { unresolved: input };
  if (catalog.foods.some((food) => food.slug === trimmed)) {
    return { slug: trimmed };
  }

  const match = matchFood(trimmed, catalog);
  if (match === undefined || match.score < 0.55) {
    return { unresolved: trimmed };
  }
  return { slug: match.food.slug };
}

export function resolveSeasoningSlug(input: string, seasonings: readonly SeasoningLike[]): SlugResolution {
  const trimmed = input.trim();
  if (!trimmed) return { unresolved: input };
  const normalizedInput = normalizeToken(trimmed);
  const match = seasonings.find((seasoning) =>
    seasoning.slug === trimmed ||
    normalizeToken(seasoning.slug) === normalizedInput ||
    normalizeToken(seasoning.name ?? "") === normalizedInput ||
    (seasoning.aliases ?? []).some((alias) => normalizeToken(alias) === normalizedInput)
  );
  return match === undefined ? { unresolved: trimmed } : { slug: match.slug };
}

export function slugifyDishName(name: string): string {
  return name
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeToken(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s_]+/gu, "");
}
