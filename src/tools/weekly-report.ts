export interface WeeklyReportDay {
  date: string;
  targetKcal: number;
  kcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
  dailyCarbsTarget?: number;
  dailyFatTarget?: number;
  micronutrients?: Readonly<Record<string, number>>;
  nutrientTargets?: Readonly<Record<string, number>>;
}

export interface NutrientGap {
  nutrient: string;
  average: number;
  target: number;
  gapPct: number;
}

export interface WeeklyReport {
  averageKcal: number;
  macroSplit: {
    proteinPct: number;
    carbsPct: number;
    fatPct: number;
  };
  adherencePct: number;
  topNutrientGaps: NutrientGap[];
  sodiumTrend: "up" | "down" | "flat";
  sodiumOverLimitDays: string[];
  weeklyBudgetLine: string;
  suggestions: string[];
}

export interface WeeklyReportInput {
  days: readonly WeeklyReportDay[];
  sodiumLimitMg?: number;
  dailyCarbsTarget?: number;
  dailyFatTarget?: number;
}

const round = (value: number): number => Math.round(value);

const average = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const requireSevenDays = (days: readonly WeeklyReportDay[]): void => {
  if (days.length !== 7) {
    throw new Error("Weekly report requires exactly 7 days of data.");
  }
};

const macroSplit = (days: readonly WeeklyReportDay[]): WeeklyReport["macroSplit"] => {
  const proteinKcal = average(days.map((day) => day.proteinGrams * 4));
  const carbsKcal = average(days.map((day) => day.carbsGrams * 4));
  const fatKcal = average(days.map((day) => day.fatGrams * 9));
  const total = proteinKcal + carbsKcal + fatKcal;
  if (total <= 0) {
    return { proteinPct: 0, carbsPct: 0, fatPct: 0 };
  }
  return {
    proteinPct: round((proteinKcal / total) * 100),
    carbsPct: round((carbsKcal / total) * 100),
    fatPct: round((fatKcal / total) * 100),
  };
};

const adherencePct = (days: readonly WeeklyReportDay[]): number => {
  const eligible = days.filter((day) => day.targetKcal > 0);
  if (eligible.length === 0) {
    return 0;
  }
  const adherent = eligible.filter((day) => {
    const lower = day.targetKcal * 0.9;
    const upper = day.targetKcal * 1.1;
    return day.kcal >= lower && day.kcal <= upper;
  });
  return round((adherent.length / eligible.length) * 100);
};

const nutrientNames = (days: readonly WeeklyReportDay[]): string[] => {
  const names = new Set<string>();
  for (const day of days) {
    for (const nutrient of Object.keys(day.nutrientTargets ?? {})) {
      names.add(nutrient);
    }
  }
  return [...names].sort();
};

const topNutrientGaps = (days: readonly WeeklyReportDay[]): NutrientGap[] =>
  nutrientNames(days)
    .map((nutrient) => {
      const averageActual = average(days.map((day) => day.micronutrients?.[nutrient] ?? 0));
      const averageTarget = average(days.map((day) => day.nutrientTargets?.[nutrient] ?? 0));
      const gapPct = averageTarget > 0 ? round(((averageTarget - averageActual) / averageTarget) * 100) : 0;
      return { nutrient, average: round(averageActual), target: round(averageTarget), gapPct };
    })
    .filter((gap) => gap.gapPct > 0)
    .sort((a, b) => b.gapPct - a.gapPct || a.nutrient.localeCompare(b.nutrient))
    .slice(0, 3);

const sodiumTrend = (days: readonly WeeklyReportDay[]): WeeklyReport["sodiumTrend"] => {
  const first = average(days.slice(0, 3).map((day) => day.sodiumMg));
  const last = average(days.slice(-3).map((day) => day.sodiumMg));
  if (first === 0 && last === 0) {
    return "flat";
  }
  const changePct = first === 0 ? 1 : (last - first) / first;
  if (changePct > 0.05) {
    return "up";
  }
  if (changePct < -0.05) {
    return "down";
  }
  return "flat";
};

const weeklyBudgetLine = (days: readonly WeeklyReportDay[], input: WeeklyReportInput): string => {
  const dailyFatTarget = input.dailyFatTarget ?? firstPositive(days.map((day) => day.dailyFatTarget));
  const dailyCarbsTarget = input.dailyCarbsTarget ?? firstPositive(days.map((day) => day.dailyCarbsTarget));
  const sodiumLimitMg = input.sodiumLimitMg ?? 2000;
  return [
    "Weekly budgets:",
    formatBudget("fat", sum(days.map((day) => day.fatGrams)), dailyFatTarget, "g"),
    formatBudget("sodium", sum(days.map((day) => day.sodiumMg)), sodiumLimitMg, "mg"),
    formatBudget("carbs", sum(days.map((day) => day.carbsGrams)), dailyCarbsTarget, "g"),
  ].join(" ");
};

const formatBudget = (
  label: string,
  actualRaw: number,
  dailyTarget: number | undefined,
  unit: string,
): string => {
  const actual = unit === "mg" ? round(actualRaw) : roundTo(actualRaw, 1);
  if (dailyTarget === undefined || dailyTarget <= 0) return `${label} ${formatNumber(actual)}${unit} logged, no weekly target;`;
  const target = unit === "mg" ? round(dailyTarget * 7) : roundTo(dailyTarget * 7, 1);
  const difference = roundTo(actual - target, unit === "mg" ? 0 : 1);
  const percentDifference = target === 0 ? 0 : roundTo(Math.abs(difference) / target * 100, 1);
  const status = difference > 0 ? "over" : difference < 0 ? "under" : "on target";
  return `${label} ${formatNumber(actual)}${unit} / ${formatNumber(target)}${unit}, ${formatNumber(percentDifference)}% ${status};`;
};

const firstPositive = (values: readonly (number | undefined)[]): number | undefined =>
  values.find((value) => value !== undefined && Number.isFinite(value) && value > 0);

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const suggestions = (
  report: Omit<WeeklyReport, "suggestions">,
  days: readonly WeeklyReportDay[],
): string[] => {
  if (report.averageKcal === 0 && report.topNutrientGaps.length === 0) {
    return ["Log complete meals for the next 7 days to unlock more specific guidance."];
  }

  const items: string[] = [];
  if (report.sodiumOverLimitDays.length > 0) {
    items.push("Reduce high-sodium seasonings on over-limit days and use vinegar, herbs, or citrus for flavor.");
  }
  const primaryGap = report.topNutrientGaps[0];
  if (primaryGap) {
    items.push(`Prioritize ${primaryGap.nutrient}-rich foods next week; it averaged ${primaryGap.gapPct}% below target.`);
  }
  if (report.adherencePct === 100) {
    items.push(`Keep calorie portions steady; all ${days.length} days landed within 10% of target.`);
  } else if (report.adherencePct < 70) {
    items.push("Pre-plan protein and staple portions before dinner to bring more days within target.");
  }
  return items;
};

export function generateWeeklyReport(input: WeeklyReportInput): WeeklyReport {
  const days = input.days;
  requireSevenDays(days);

  const sodiumLimitMg = input.sodiumLimitMg ?? 2000;
  const withoutSuggestions = {
    averageKcal: round(average(days.map((day) => day.kcal))),
    macroSplit: macroSplit(days),
    adherencePct: adherencePct(days),
    topNutrientGaps: topNutrientGaps(days),
    sodiumTrend: sodiumTrend(days),
    sodiumOverLimitDays: days.filter((day) => day.sodiumMg > sodiumLimitMg).map((day) => day.date),
    weeklyBudgetLine: trimBudgetLine(weeklyBudgetLine(days, input)),
  };

  return {
    ...withoutSuggestions,
    suggestions: suggestions(withoutSuggestions, days),
  };
}

function trimBudgetLine(line: string): string {
  return line.replace(/;$/, ".");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
