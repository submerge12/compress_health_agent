export type MealType = "breakfast" | "lunch" | "dinner";

export interface PatternMeal {
  type: MealType;
  skipped?: boolean;
  kcal?: number;
  time?: string;
}

export interface PatternDay {
  date: string;
  meals: readonly PatternMeal[];
  nutrientSources?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface DetectedPattern {
  pattern: string;
  days?: string[];
  confidence: number;
  source?: string;
  nutrient?: string;
  time?: string;
}

const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const mealTypes: readonly MealType[] = ["breakfast", "lunch", "dinner"];

const roundConfidence = (value: number): number => Math.round(value * 100) / 100;

const parseDay = (date: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid pattern day date: ${date}`);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  const normalized = [
    String(parsed.getUTCFullYear()).padStart(4, "0"),
    String(parsed.getUTCMonth() + 1).padStart(2, "0"),
    String(parsed.getUTCDate()).padStart(2, "0"),
  ].join("-");
  if (Number.isNaN(parsed.getTime()) || normalized !== date) {
    throw new Error(`Invalid pattern day date: ${date}`);
  }
  return parsed;
};

const weekdayOf = (date: string): string => {
  const weekday = weekdays[parseDay(date).getUTCDay()];
  if (!weekday) {
    throw new Error(`Invalid pattern day date: ${date}`);
  }
  return weekday;
};

const mealFor = (day: PatternDay, type: MealType): PatternMeal | undefined =>
  day.meals.find((meal) => meal.type === type);

const skippedMealPatterns = (days: readonly PatternDay[]): DetectedPattern[] => {
  const patterns: DetectedPattern[] = [];
  for (const mealType of mealTypes) {
    const skippedDays = weekdays.filter((weekday) => {
      const matching = days.filter((day) => weekdayOf(day.date) === weekday);
      const skipped = matching.filter((day) => mealFor(day, mealType)?.skipped === true);
      return matching.length > 0 && skipped.length / matching.length >= 0.75;
    });
    if (skippedDays.length > 0) {
      patterns.push({
        pattern: `skip_${mealType}`,
        days: skippedDays,
        confidence: skippedConfidence(days, mealType, skippedDays),
      });
    }
  }
  return patterns;
};

const skippedConfidence = (
  days: readonly PatternDay[],
  mealType: MealType,
  matchedDays: readonly string[],
): number => {
  const matching = days.filter((day) => matchedDays.includes(weekdayOf(day.date)));
  const skipped = matching.filter((day) => mealFor(day, mealType)?.skipped === true);
  return matching.length === 0 ? 0 : roundConfidence(skipped.length / matching.length);
};

const dailyKcal = (day: PatternDay): number =>
  day.meals.reduce((sum, meal) => sum + (meal.skipped ? 0 : meal.kcal ?? 0), 0);

const weekendOvereatingPattern = (days: readonly PatternDay[]): DetectedPattern[] => {
  const weekend = days.filter((day) => ["saturday", "sunday"].includes(weekdayOf(day.date)));
  const weekday = days.filter((day) => !["saturday", "sunday"].includes(weekdayOf(day.date)));
  const weekendAverage = average(weekend.map(dailyKcal));
  const weekdayAverage = average(weekday.map(dailyKcal));
  if (weekdayAverage > 0 && weekendAverage > weekdayAverage * 1.15) {
    return [{ pattern: "weekend_overeating", days: ["saturday", "sunday"], confidence: 1 }];
  }
  return [];
};

const average = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const singleSourcePatterns = (days: readonly PatternDay[]): DetectedPattern[] => {
  const totals = new Map<string, Map<string, number>>();
  for (const day of days) {
    for (const [nutrient, sources] of Object.entries(day.nutrientSources ?? {})) {
      const nutrientTotals = totals.get(nutrient) ?? new Map<string, number>();
      for (const [source, share] of Object.entries(sources)) {
        nutrientTotals.set(source, (nutrientTotals.get(source) ?? 0) + share);
      }
      totals.set(nutrient, nutrientTotals);
    }
  }
  return [...totals.entries()].flatMap(([nutrient, sources]) => sourcePattern(nutrient, sources));
};

const sourcePattern = (nutrient: string, sources: ReadonlyMap<string, number>): DetectedPattern[] => {
  const total = [...sources.values()].reduce((sum, value) => sum + value, 0);
  const topSource = [...sources.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!topSource) {
    return [];
  }
  const [source, amount] = topSource;
  const share = total > 0 ? amount / total : 0;
  if (share < 0.8) {
    return [];
  }
  return [{ pattern: "single_source_dependency", nutrient, source, confidence: roundConfidence(share) }];
};

const recurringTimingPatterns = (days: readonly PatternDay[]): DetectedPattern[] =>
  mealTypes.flatMap((mealType) => {
    const lateMeals = days
      .map((day) => mealFor(day, mealType))
      .filter((meal): meal is PatternMeal => meal !== undefined && typeof meal.time === "string" && !meal.skipped)
      .filter((meal) => isOutsideExpectedWindow(mealType, meal.time ?? ""));
    if (lateMeals.length / days.length < 0.75 || lateMeals.length === 0) {
      return [];
    }
    const firstLateMeal = lateMeals[0];
    if (!firstLateMeal) {
      return [];
    }
    return [{
      pattern: `recurring_${mealType}_timing`,
      time: firstLateMeal.time,
      confidence: roundConfidence(lateMeals.length / days.length),
    }];
  });

const isOutsideExpectedWindow = (mealType: MealType, time: string): boolean => {
  const minutes = toMinutes(time);
  if (minutes === null) {
    return false;
  }
  const windows: Record<MealType, [number, number]> = {
    breakfast: [6 * 60, 10 * 60],
    lunch: [11 * 60, 14 * 60],
    dinner: [17 * 60, 20 * 60],
  };
  const [start, end] = windows[mealType];
  return minutes < start || minutes > end;
};

const toMinutes = (time: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    return null;
  }
  const [, hoursText, minutesText] = match;
  if (!hoursText || !minutesText) {
    return null;
  }
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
};

export function detectPatterns(days: readonly PatternDay[]): DetectedPattern[] {
  for (const day of days) {
    parseDay(day.date);
  }

  if (days.length < 14) {
    return [];
  }

  return [
    ...skippedMealPatterns(days),
    ...weekendOvereatingPattern(days),
    ...singleSourcePatterns(days),
    ...recurringTimingPatterns(days),
  ];
}
