import type { HardViolation, WeeklyMealPlan } from "./meal-planner.js";
import type { RecipeDish } from "./recipe-engine.js";
import {
  MIN_DISTINCT_DISHES,
  SODIUM_CAP_MG,
  WEEKLY_FLOORS,
} from "./scoring-weights.js";

export type CoverageItemType =
  | "weekly_floor"
  | "protein_average"
  | "fat_ceiling"
  | "sodium"
  | "diversity"
  | "hard_violation"
  | "pool_coverage"
  | "pool_balance";

export interface CoverageItem {
  type: CoverageItemType;
  key: string;
  actual: number;
  target: number;
  message: string;
}

export interface CoverageReportOptions {
  dailyProteinTarget?: number;
  dailyFatTarget?: number;
  weeklyFloors?: Readonly<Record<string, number>>;
  minDistinctDishes?: number;
  sodiumCapMg?: number;
  acceptedCandidates?: readonly RecipeDish[];
}

export interface CoverageReport {
  unmet: readonly CoverageItem[];
}

export function buildCoverageReport(
  plan: WeeklyMealPlan,
  options: CoverageReportOptions = {},
): CoverageReport {
  return {
    unmet: [
      ...weeklyFloorItems(plan, options.weeklyFloors ?? WEEKLY_FLOORS),
      ...proteinAverageItems(plan, options.dailyProteinTarget),
      ...fatCeilingItems(plan, options.dailyFatTarget),
      ...sodiumItems(plan, options.sodiumCapMg ?? SODIUM_CAP_MG),
      ...diversityItems(plan, options.minDistinctDishes ?? MIN_DISTINCT_DISHES),
      ...hardViolationItems(plan.hardViolations),
      ...frequencyHintItems(plan),
      ...acceptedPoolItems(options.acceptedCandidates),
    ],
  };
}

const PROTEIN_BUCKETS = new Set([
  "red_meat",
  "lean_white_meat",
  "deep_sea_fish",
  "shellfish",
  "soy_product",
  "egg",
  "dairy",
]);
const LOW_FAT_PROTEIN_BUCKETS = new Set(["lean_white_meat", "deep_sea_fish", "shellfish", "soy_product"]);
const LEAFY_SLUGS = new Set(["bok_choy", "spinach", "baby_napa", "napa_cabbage"]);
const CRUCIFEROUS_SLUGS = new Set(["broccoli", "cauliflower", "bok_choy", "baby_napa", "napa_cabbage", "cabbage"]);
const MUSHROOM_SLUGS = new Set(["shiitake_fresh", "mushroom", "enoki", "oyster_mushroom"]);
const GENERIC_VEGETABLE_SLUGS = new Set(["cucumber", "tomato", "carrot"]);
const FILLER_SLUGS = new Set(["konjac"]);

function acceptedPoolItems(candidates: readonly RecipeDish[] | undefined): readonly CoverageItem[] {
  if (candidates === undefined || candidates.length === 0) return [];

  const items: CoverageItem[] = [];
  const hasProtein = candidates.some(hasProteinSource);
  if (!hasProtein) {
    items.push({
      type: "pool_coverage",
      key: "protein_sources",
      actual: 0,
      target: 1,
      message: "accepted pool has no clear protein source; add a lean protein dish",
    });
  } else if (!candidates.some(hasLowFatProteinSource)) {
    items.push({
      type: "pool_balance",
      key: "low_fat_protein",
      actual: 0,
      target: 1,
      message: "accepted protein choices are mostly high-fat; add a low-fat protein option",
    });
  }

  if (!hasAnyVegetableChoice(candidates) && candidates.some(hasFillerChoice)) {
    items.push({
      type: "pool_coverage",
      key: "vegetable_sources",
      actual: 0,
      target: 1,
      message: "accepted pool has filler ingredients but no clear vegetable source; add a real vegetable option",
    });
  }

  if (candidates.some((dish) => hasSpecialHandlingTag(dish, "high_sodium"))) {
    items.push({
      type: "pool_balance",
      key: "high_sodium_special_ingredient",
      actual: 1,
      target: 0,
      message: "accepted pool includes a high-sodium special ingredient; use it as seasoning rather than a main item",
    });
  }

  if (candidates.some(hasAdvancedCooking)) {
    items.push({
      type: "pool_balance",
      key: "advanced_cooking",
      actual: 1,
      target: 0,
      message: "accepted pool includes ingredients marked as advanced cooking difficulty",
    });
  }

  if (candidates.some(hasSpecialtyAvailability)) {
    items.push({
      type: "pool_balance",
      key: "specialty_availability",
      actual: 1,
      target: 0,
      message: "accepted pool depends on specialty ingredients; confirm availability or add common substitutes",
    });
  }

  if (hasAnyVegetableChoice(candidates)) {
    items.push(...missingSubtypeItems(candidates));
  }

  return items;
}

function missingSubtypeItems(candidates: readonly RecipeDish[]): readonly CoverageItem[] {
  const checks: Array<[string, ReadonlySet<string>, string]> = [
    ["leafy_vegetables", LEAFY_SLUGS, "accepted vegetables do not include a leafy option"],
    ["cruciferous_vegetables", CRUCIFEROUS_SLUGS, "accepted vegetables do not include a cruciferous option"],
    ["mushrooms", MUSHROOM_SLUGS, "accepted vegetables do not include mushrooms"],
  ];
  return checks
    .filter(([, slugs]) => !candidates.some((dish) => hasIngredientIn(dish, slugs)))
    .map(([key, , message]) => ({
      type: "pool_coverage" as const,
      key,
      actual: 0,
      target: 1,
      message,
    }));
}

function hasProteinSource(dish: RecipeDish): boolean {
  if (hasSpecialHandlingTag(dish, "seasoning_not_main_protein") && !hasBucketIn(dish, PROTEIN_BUCKETS)) {
    return false;
  }
  return hasBucketIn(dish, PROTEIN_BUCKETS) || dish.nutrition.proteinGrams >= 20;
}

function hasLowFatProteinSource(dish: RecipeDish): boolean {
  if (!hasProteinSource(dish)) return false;
  return hasBucketIn(dish, LOW_FAT_PROTEIN_BUCKETS) ||
    dish.nutrition.fatGrams <= dish.nutrition.proteinGrams * 0.5;
}

function hasAnyVegetableChoice(candidates: readonly RecipeDish[]): boolean {
  return candidates.some((dish) =>
    hasBucket(dish, "vegetable") ||
    hasIngredientIn(dish, LEAFY_SLUGS) ||
    hasIngredientIn(dish, CRUCIFEROUS_SLUGS) ||
    hasIngredientIn(dish, MUSHROOM_SLUGS) ||
    hasIngredientIn(dish, GENERIC_VEGETABLE_SLUGS)
  );
}

function hasFillerChoice(dish: RecipeDish): boolean {
  return hasSpecialHandlingTag(dish, "filler") || hasIngredientIn(dish, FILLER_SLUGS);
}

function hasBucket(dish: RecipeDish, bucket: string): boolean {
  return (dish.buckets ?? []).some((candidate) => normalize(candidate) === bucket);
}

function hasBucketIn(dish: RecipeDish, buckets: ReadonlySet<string>): boolean {
  return (dish.buckets ?? []).some((bucket) => buckets.has(normalize(bucket)));
}

function hasIngredientIn(dish: RecipeDish, slugs: ReadonlySet<string>): boolean {
  return dish.ingredients.some((ingredient) => slugs.has(normalize(ingredient.slug)));
}

function hasSpecialHandlingTag(dish: RecipeDish, tag: string): boolean {
  return (dish.specialHandlingTags ?? []).some((candidate) => normalize(candidate) === tag);
}

function hasAdvancedCooking(dish: RecipeDish): boolean {
  return (dish.cookingDifficulties ?? []).some((difficulty) => normalize(difficulty) === "advanced");
}

function hasSpecialtyAvailability(dish: RecipeDish): boolean {
  return (dish.availabilityTags ?? []).some((availability) => normalize(availability) === "specialty");
}

function weeklyFloorItems(
  plan: WeeklyMealPlan,
  explicitFloors: Readonly<Record<string, number>>,
): readonly CoverageItem[] {
  const floors = new Map<string, number>(Object.entries(explicitFloors));
  const counts = new Map<string, number>();

  for (const entry of plan.entries) {
    for (const [bucket, floor] of Object.entries(entry.dish.weeklyFloors ?? {})) {
      floors.set(bucket, Math.max(floors.get(bucket) ?? 0, floor));
    }
    for (const bucket of entry.dish.buckets ?? []) {
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
  }

  return [...floors.entries()]
    .filter(([, floor]) => floor > 0)
    .map(([bucket, floor]) => ({ bucket, floor, actual: counts.get(bucket) ?? 0 }))
    .filter((item) => item.actual < item.floor)
    .sort((left, right) => left.bucket.localeCompare(right.bucket))
    .map((item) => ({
      type: "weekly_floor" as const,
      key: item.bucket,
      actual: item.actual,
      target: item.floor,
      message: `${item.bucket}: ${item.actual}/${item.floor} weekly servings`,
    }));
}

function proteinAverageItems(
  plan: WeeklyMealPlan,
  dailyProteinTarget: number | undefined,
): readonly CoverageItem[] {
  if (dailyProteinTarget === undefined || dailyProteinTarget <= 0) return [];
  const actual = round1(average(plan.days.map((day) => day.totals.proteinGrams)));
  if (actual >= dailyProteinTarget) return [];
  return [{
    type: "protein_average",
    key: "protein",
    actual,
    target: dailyProteinTarget,
    message: `protein averaged ${actual}g/day vs ${dailyProteinTarget}g target`,
  }];
}

function fatCeilingItems(
  plan: WeeklyMealPlan,
  dailyFatTarget: number | undefined,
): readonly CoverageItem[] {
  if (dailyFatTarget === undefined || dailyFatTarget <= 0) return [];
  const actual = round1(Math.max(...plan.days.map((day) => day.totals.fatGrams), 0));
  if (actual <= dailyFatTarget) return [];
  return [{
    type: "fat_ceiling",
    key: "fat",
    actual,
    target: dailyFatTarget,
    message: `fat reached ${actual}g/day vs ${dailyFatTarget}g ceiling`,
  }];
}

function sodiumItems(plan: WeeklyMealPlan, sodiumCapMg: number): readonly CoverageItem[] {
  const daysOver = plan.days.filter((day) => day.totals.sodiumMg > sodiumCapMg).length;
  if (daysOver === 0) return [];
  return [{
    type: "sodium",
    key: "days_over_cap",
    actual: daysOver,
    target: 0,
    message: `${daysOver} day(s) exceeded ${sodiumCapMg}mg sodium`,
  }];
}

function diversityItems(plan: WeeklyMealPlan, minDistinctDishes: number): readonly CoverageItem[] {
  if (plan.distinctDishCount >= minDistinctDishes) return [];
  return [{
    type: "diversity",
    key: "distinct_dishes",
    actual: plan.distinctDishCount,
    target: minDistinctDishes,
    message: `${plan.distinctDishCount}/${minDistinctDishes} distinct dishes planned`,
  }];
}

function hardViolationItems(violations: readonly HardViolation[]): readonly CoverageItem[] {
  return violations.map((violation) => ({
    type: "hard_violation",
    key: violation.type,
    actual: round1(violation.actual),
    target: round1(violation.target),
    message: violation.message,
  }));
}

function frequencyHintItems(plan: WeeklyMealPlan): readonly CoverageItem[] {
  const weeklyCounts = new Map<string, number>();
  for (const entry of plan.entries) {
    for (const dish of [entry.dish, entry.side].filter((item): item is RecipeDish => item !== undefined)) {
      for (const [slug, hint] of Object.entries(dish.frequencyHints ?? {})) {
        if (normalize(hint) === "weekly") {
          weeklyCounts.set(slug, (weeklyCounts.get(slug) ?? 0) + 1);
        }
      }
    }
  }

  return [...weeklyCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slug, count]) => ({
      type: "pool_balance" as const,
      key: `weekly_frequency_${slug}`,
      actual: count,
      target: 1,
      message: `${slug}: planned ${count} times despite weekly frequency hint`,
    }));
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
