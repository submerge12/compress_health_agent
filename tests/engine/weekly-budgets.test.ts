import { describe, expect, test } from "vitest";

import { validateWeeklyMealPlan, type WeeklyMealPlan } from "../../src/engine/meal-planner.js";
import { generateMealPlan } from "../../src/tools/generate-meal-plan.js";
import { generateWeeklyReport, type WeeklyReportDay } from "../../src/tools/weekly-report.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";

describe("weekly budgets", () => {
  test("plan result exposes weekly fat, sodium, and carb budgets against seven daily targets", () => {
    const result = generateMealPlan({
      startDate: "2026-06-16",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      dailyFatTarget: 35,
      dailyCarbsTarget: 210,
      presetDishes: [
        dish("fatty_breakfast", ["breakfast"], {
          kcal: 450,
          proteinGrams: 30,
          carbsGrams: 40,
          fatGrams: 28,
          sodiumMg: 350,
        }),
        dish("fatty_main", ["lunch", "dinner"], {
          kcal: 675,
          proteinGrams: 45,
          carbsGrams: 70,
          fatGrams: 32,
          sodiumMg: 600,
        }),
      ],
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;

    expect(result.plan.weeklyBudgets).toEqual({
      fat: expect.objectContaining({
        actual: 644,
        target: 245,
        difference: 399,
        status: "over",
      }),
      sodium: expect.objectContaining({
        actual: 10850,
        target: 16100,
        difference: -5250,
        status: "under",
      }),
      carbs: expect.objectContaining({
        actual: 1260,
        target: 1470,
        difference: -210,
        status: "under",
      }),
    });
    expect(result.plan.weeklyBudgets.fat.percentDifference).toBe(162.9);
    expect(result.overview).toContain("Weekly budgets:");
    expect(result.overview).toContain("fat 644g / 245g, 162.9% over");
  });

  test("validateWeeklyMealPlan consumers no longer emit per-day fat advisory strings", () => {
    const plan = planWithDailyFat(65);

    const validation = validateWeeklyMealPlan(plan, { dailyKcalTarget: 1800, dailyFatTarget: 35 });

    expect(validation.ok).toBe(true);
    expect(validation.violations.join(" ")).not.toContain("fat");
    expect(validation.violations.join(" ")).not.toContain("ceiling");
  });
});

describe("weekly report weekly budgets", () => {
  test("includes a weekly budget line for fat, sodium, and carbs", () => {
    const days = Array.from({ length: 7 }, (_, index) =>
      reportDay(`2026-06-${10 + index}`, {
        fatGrams: 50,
        carbsGrams: 190,
        sodiumMg: 2100,
      }),
    );

    const report = generateWeeklyReport({
      days,
      dailyFatTarget: 45,
      dailyCarbsTarget: 200,
      sodiumLimitMg: 2000,
    });

    expect(report.weeklyBudgetLine).toBe(
      "Weekly budgets: fat 350g / 315g, 11.1% over; sodium 14700mg / 14000mg, 5% over; carbs 1330g / 1400g, 5% under.",
    );
  });
});

function dish(
  slug: string,
  mealTypes: RecipeDish["mealTypes"],
  nutrition: RecipeDish["nutrition"],
): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes,
    nutrition,
    ingredients: [{ slug, grams: 100 }],
    seasonings: [],
    source: "preset",
  };
}

function planWithDailyFat(fatGrams: number): WeeklyMealPlan {
  const days = Array.from({ length: 7 }, (_, dayIndex) => ({
    date: `2026-06-${16 + dayIndex}`,
    meals: [
      entry(dayIndex, "breakfast", fatGrams / 3),
      entry(dayIndex, "lunch", fatGrams / 3),
      entry(dayIndex, "dinner", fatGrams / 3),
    ],
    totals: {
      kcal: 1800,
      proteinGrams: 100,
      carbsGrams: 180,
      fatGrams,
      sodiumMg: 1800,
    },
  }));
  return {
    startDate: "2026-06-16",
    days,
    entries: days.flatMap((day) => day.meals),
    distinctDishCount: 10,
    hardViolations: [],
    weeklyBudgets: {
      fat: { actual: fatGrams * 7, target: 245, difference: fatGrams * 7 - 245, percentDifference: 85.7, status: "over" },
      sodium: { actual: 12600, target: 16100, difference: -3500, percentDifference: 21.7, status: "under" },
      carbs: { actual: 1260, target: 0, difference: 1260, percentDifference: 0, status: "no_target" },
    },
  };
}

function entry(
  dayIndex: number,
  mealType: "breakfast" | "lunch" | "dinner",
  fatGrams: number,
): WeeklyMealPlan["entries"][number] {
  const nutrition = {
    kcal: mealType === "breakfast" ? 450 : 675,
    proteinGrams: mealType === "breakfast" ? 30 : 35,
    carbsGrams: mealType === "breakfast" ? 40 : 70,
    fatGrams,
    sodiumMg: 600,
  };
  const dish = {
    slug: `${mealType}_${dayIndex}`,
    name: mealType,
    mealTypes: [mealType],
    nutrition,
    ingredients: [{ slug: mealType, grams: 100 }],
    seasonings: [],
    source: "preset",
  } satisfies RecipeDish;
  return {
    id: `${dayIndex}-${mealType}`,
    date: `2026-06-${16 + dayIndex}`,
    dayIndex,
    mealType,
    targetKcal: nutrition.kcal,
    dish,
    nutrition,
    status: "planned",
  };
}

function reportDay(date: string, overrides: Partial<WeeklyReportDay> = {}): WeeklyReportDay {
  return {
    date,
    targetKcal: 1800,
    kcal: 1800,
    proteinGrams: 100,
    carbsGrams: 200,
    fatGrams: 45,
    sodiumMg: 1800,
    micronutrients: {},
    nutrientTargets: {},
    ...overrides,
  };
}
