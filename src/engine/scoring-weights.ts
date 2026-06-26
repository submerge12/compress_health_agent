export interface MealPlanScoringWeights {
  protein: number;
  weeklyFloor: number;
  sodium: number;
  repetition: number;
  macro: number;
  diversity: number;
  preferenceBonus: number;
  recency: number;
}

export const DEFAULT_SCORING_WEIGHTS: MealPlanScoringWeights = {
  protein: 10,
  weeklyFloor: 6,
  sodium: 5,
  repetition: 4,
  macro: 3,
  diversity: 3,
  preferenceBonus: 3,
  recency: 2,
};

export const ENERGY_TOLERANCE_RATIO = 0.12;
export const MAX_ENERGY_TOLERANCE_RATIO = 0.15;
export const PROTEIN_FLOOR_RATIO = 0.8;
export const SODIUM_CAP_MG = 2300;
export const MIN_DISTINCT_DISHES = 10;
export const MAX_DISH_USES_PER_WEEK = 3;

// Weekly serving floors per classification bucket. Sourced from config (not the
// selected plan) so an entirely-absent bucket still incurs a deficit and gets
// pulled in. red_meat ≥2, deep_sea_fish ≥2, shellfish ≥1 per week.
export const WEEKLY_FLOORS: Readonly<Record<string, number>> = {
  red_meat: 2,
  deep_sea_fish: 2,
  shellfish: 1,
};
