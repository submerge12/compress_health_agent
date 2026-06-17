export type Sex = "male" | "female";

export type ActivityLevel = "sedentary" | "lightly_active" | "moderately_active" | "strength_training";

export type Goal =
  | "improve_health"
  | "body_recomp"
  | "fat_loss_slow"
  | "fat_loss_moderate"
  | "fat_loss_fast"
  | "muscle_gain_slow"
  | "muscle_gain_moderate"
  | "muscle_gain_fast";

export type GoalFamily = "improve_health" | "body_recomp" | "fat_loss" | "muscle_gain";

export type CalorieStatus = "on_target" | "lower_bound_applied" | "upper_bound_applied" | "lower_overrides_upper";

export type MacroStatus = "appropriate" | "insufficient" | "slightly_high" | "excessive" | "below_min" | "high" | "below_range" | "below_range_unavoidable" | "above_range";

export interface BmrProfile {
  sex: Sex;
  ageYears: number;
  heightCm: number;
  weightKg: number;
}

export interface CalorieProfile extends BmrProfile {
  activityLevel: ActivityLevel;
  goal: Goal;
}

export interface MacroTargets {
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
}

export interface MacroRanges {
  proteinBand: [number, number, number];
  proteinRangeGrams: [number, number];
  carbsRangeGrams: [number, number];
  fatMinGrams: number;
  fatSoftMaxGrams: number;
}

export interface MacroStatuses {
  protein: MacroStatus;
  fat: MacroStatus;
  carbs: MacroStatus;
}

export interface CaloriePlan {
  bmrKcal: number;
  tdeeKcal: number;
  targetKcal: number;
  calorieStatus: CalorieStatus;
  isExerciser: boolean;
  macros: MacroTargets;
  ranges: MacroRanges;
  statuses: MacroStatuses;
  warnings: string[];
}

export interface FoodPortionRecord {
  slug: string;
  defaultGrams?: number | null;
  defaultUnit?: string | null;
}

export interface NaturalUnitRecord {
  foodSlug: string;
  unit: string;
  grams: number;
  aliases?: readonly string[];
}

export type PortionSource = "grams" | "natural_unit" | "default_portion";

export interface ResolvedPortion {
  grams: number;
  quantity: number;
  unit: string;
  source: PortionSource;
}

export interface NutritionEntry {
  slug: string;
  grams: number;
}

export interface NutritionRecord {
  slug: string;
  kcalPer100g: number;
  proteinGramsPer100g: number;
  carbsGramsPer100g: number;
  fatGramsPer100g: number;
  sodiumMgPer100g: number;
  micronutrientsPer100g?: Readonly<Record<string, number>>;
}

export interface NutrientTotals {
  kcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
  micronutrients: Record<string, number>;
}

export interface NutritionAggregateInput {
  foods: readonly NutritionEntry[];
  seasonings?: readonly NutritionEntry[];
  foodRecords: readonly NutritionRecord[];
  seasoningRecords?: readonly NutritionRecord[];
}

export interface NutritionAggregate {
  foods: NutrientTotals;
  seasonings: NutrientTotals;
  total: NutrientTotals;
  seasoningSodiumMg: number;
}
