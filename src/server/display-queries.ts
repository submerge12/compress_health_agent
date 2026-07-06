import type { MealPlanEntryRow } from "../db/repository.js";

/**
 * Read-only projections over STORED plan rows for the display API. These are
 * display arithmetic (sums of what is persisted), not planning behavior —
 * generation-time budgets/procurement still come from the generate handler.
 */

export interface StoredDayView {
  date: string;
  entries: MealPlanEntryRow[];
  totals: MacroTotals;
}

export interface MacroTotals {
  kcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
}

export interface StoredBudgetLine {
  actual: number;
  target: number | null;
  percentOfTarget: number | null;
}

export interface StoredWeekView {
  startDate: string;
  endDate: string;
  days: StoredDayView[];
  weekly: {
    kcal: StoredBudgetLine;
    proteinGrams: StoredBudgetLine;
    fatGrams: StoredBudgetLine;
    carbsGrams: StoredBudgetLine;
    sodiumMg: StoredBudgetLine;
  };
}

export interface DisplayTargets {
  targetKcal?: number;
  proteinTargetGrams?: number;
  fatTargetGrams?: number;
  carbsTargetGrams?: number;
  sodiumCapMg?: number;
}

const DEFAULT_SODIUM_CAP_MG = 2300;

export function storedWeekView(
  rows: readonly MealPlanEntryRow[],
  startDate: string,
  dayCount: number,
  targets: DisplayTargets = {},
): StoredWeekView {
  const days: StoredDayView[] = Array.from({ length: dayCount }, (_, index) => {
    const date = addDaysIso(startDate, index);
    // Skipped meals stay visible in the list but do not count toward totals.
    const entries = rows.filter((row) => row.planDate === date);
    const counted = entries.filter((row) => row.status !== "skipped");
    return { date, entries, totals: sumRows(counted) };
  });

  const weekTotals = sumRows(days.flatMap((day) => day.entries.filter((row) => row.status !== "skipped")));
  const weeklyTarget = (daily: number | undefined): number | null =>
    daily === undefined ? null : Math.round(daily * dayCount * 10) / 10;

  return {
    startDate,
    endDate: addDaysIso(startDate, dayCount - 1),
    days,
    weekly: {
      kcal: budgetLine(weekTotals.kcal, weeklyTarget(targets.targetKcal)),
      proteinGrams: budgetLine(weekTotals.proteinGrams, weeklyTarget(targets.proteinTargetGrams)),
      fatGrams: budgetLine(weekTotals.fatGrams, weeklyTarget(targets.fatTargetGrams)),
      carbsGrams: budgetLine(weekTotals.carbsGrams, weeklyTarget(targets.carbsTargetGrams)),
      sodiumMg: budgetLine(weekTotals.sodiumMg, weeklyTarget(targets.sodiumCapMg ?? DEFAULT_SODIUM_CAP_MG)),
    },
  };
}

export interface StoredProcurementItem {
  slug: string;
  totalGrams: number;
  bufferedGrams: number;
  dishCount: number;
}

/**
 * Grocery list for the STORED week: aggregates the gram-bearing ingredients
 * persisted on each entry (dish + side + top-ups + staple all live in
 * ingredientsJson), so it reflects swaps and supersedes exactly as stored.
 */
export function storedProcurement(
  rows: readonly MealPlanEntryRow[],
  options: { bufferRatio?: number; roundToGrams?: number } = {},
): { bufferRatio: number; roundToGrams: number; items: StoredProcurementItem[] } {
  const bufferRatio = options.bufferRatio ?? 1.15;
  const roundToGrams = options.roundToGrams ?? 10;
  const totals = new Map<string, { grams: number; dishes: Set<string> }>();

  for (const row of rows) {
    if (row.status === "skipped") continue;
    for (const item of row.ingredientsJson ?? []) {
      const slug = String(item["slug"] ?? "").trim();
      const grams = Number(item["grams"] ?? 0);
      if (slug === "" || !Number.isFinite(grams) || grams <= 0) continue;
      const bucket = totals.get(slug) ?? { grams: 0, dishes: new Set<string>() };
      bucket.grams += grams;
      bucket.dishes.add(row.recipeSlug ?? row.dishName);
      totals.set(slug, bucket);
    }
  }

  const items = [...totals.entries()]
    .map(([slug, bucket]) => ({
      slug,
      totalGrams: roundToNearest(bucket.grams, roundToGrams),
      bufferedGrams: roundToNearest(bucket.grams * bufferRatio, roundToGrams),
      dishCount: bucket.dishes.size,
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
  return { bufferRatio, roundToGrams, items };
}

function sumRows(rows: readonly MealPlanEntryRow[]): MacroTotals {
  return {
    kcal: Math.round(rows.reduce((sum, row) => sum + row.caloriesKcal, 0)),
    proteinGrams: round1(rows.reduce((sum, row) => sum + row.proteinGrams, 0)),
    carbsGrams: round1(rows.reduce((sum, row) => sum + row.carbsGrams, 0)),
    fatGrams: round1(rows.reduce((sum, row) => sum + row.fatGrams, 0)),
    sodiumMg: Math.round(rows.reduce((sum, row) => sum + row.sodiumMg, 0)),
  };
}

function budgetLine(actual: number, target: number | null): StoredBudgetLine {
  return {
    actual: round1(actual),
    target,
    percentOfTarget: target === null || target === 0 ? null : round1((actual / target) * 100),
  };
}

function roundToNearest(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
