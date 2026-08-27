const GRAMS_PER_MILLILITER: Readonly<Record<string, number>> = {
  // A 1:1 tracking conversion is intentional for water-based soy milk.
  soy_milk: 1,
};

export function gramsPerMilliliterForFood(foodSlug: string): number | null {
  return GRAMS_PER_MILLILITER[foodSlug] ?? null;
}
