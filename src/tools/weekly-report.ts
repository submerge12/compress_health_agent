export interface WeeklyReportDay {
  date: string;
  targetKcal: number;
  kcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
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
  suggestions: string[];
}

export interface WeeklyReportInput {
  days: readonly WeeklyReportDay[];
  sodiumLimitMg?: number;
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
  };

  return {
    ...withoutSuggestions,
    suggestions: suggestions(withoutSuggestions, days),
  };
}
