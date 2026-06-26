import type { HardViolation, WeeklyMealPlan } from "./meal-planner.js";
import {
  MIN_DISTINCT_DISHES,
  SODIUM_CAP_MG,
  WEEKLY_FLOORS,
} from "./scoring-weights.js";

export type CoverageItemType =
  | "weekly_floor"
  | "protein_average"
  | "sodium"
  | "diversity"
  | "hard_violation";

export interface CoverageItem {
  type: CoverageItemType;
  key: string;
  actual: number;
  target: number;
  message: string;
}

export interface CoverageReportOptions {
  dailyProteinTarget?: number;
  weeklyFloors?: Readonly<Record<string, number>>;
  minDistinctDishes?: number;
  sodiumCapMg?: number;
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
      ...sodiumItems(plan, options.sodiumCapMg ?? SODIUM_CAP_MG),
      ...diversityItems(plan, options.minDistinctDishes ?? MIN_DISTINCT_DISHES),
      ...hardViolationItems(plan.hardViolations),
    ],
  };
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

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
