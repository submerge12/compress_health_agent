import { describe, expect, test } from "vitest";
import { generateWeeklyReport, type WeeklyReportDay } from "../../src/tools/weekly-report.js";

const baseDay = (date: string, overrides: Partial<WeeklyReportDay> = {}): WeeklyReportDay => ({
  date,
  targetKcal: 1800,
  kcal: 1800,
  proteinGrams: 100,
  carbsGrams: 200,
  fatGrams: 67,
  sodiumMg: 1800,
  micronutrients: {
    calciumMg: 650,
    ironMg: 10,
    vitaminCMg: 60,
  },
  nutrientTargets: {
    calciumMg: 1000,
    ironMg: 12,
    vitaminCMg: 100,
  },
  ...overrides,
});

describe("weekly report", () => {
  test("test_generateWeeklyReport_sevenDays_returnsAggregatesAndDeterministicSuggestions", () => {
    const days: WeeklyReportDay[] = [
      baseDay("2026-06-10", { kcal: 1700, sodiumMg: 1700 }),
      baseDay("2026-06-11", { kcal: 1810, sodiumMg: 1900 }),
      baseDay("2026-06-12", { kcal: 1900, sodiumMg: 2100 }),
      baseDay("2026-06-13", { kcal: 1760, sodiumMg: 2300 }),
      baseDay("2026-06-14", { kcal: 1880, sodiumMg: 2400 }),
      baseDay("2026-06-15", { kcal: 1790, sodiumMg: 1950 }),
      baseDay("2026-06-16", { kcal: 1830, sodiumMg: 2050 }),
    ];

    const report = generateWeeklyReport({ days, sodiumLimitMg: 2000 });

    expect(report.averageKcal).toBe(1810);
    expect(report.macroSplit).toEqual({ proteinPct: 22, carbsPct: 44, fatPct: 33 });
    expect(report.adherencePct).toBe(100);
    expect(report.topNutrientGaps).toEqual([
      { nutrient: "vitaminCMg", average: 60, target: 100, gapPct: 40 },
      { nutrient: "calciumMg", average: 650, target: 1000, gapPct: 35 },
      { nutrient: "ironMg", average: 10, target: 12, gapPct: 17 },
    ]);
    expect(report.sodiumTrend).toBe("up");
    expect(report.sodiumOverLimitDays).toEqual(["2026-06-12", "2026-06-13", "2026-06-14", "2026-06-16"]);
    expect(report.suggestions).toEqual([
      "Reduce high-sodium seasonings on over-limit days and use vinegar, herbs, or citrus for flavor.",
      "Prioritize vitaminCMg-rich foods next week; it averaged 40% below target.",
      "Keep calorie portions steady; all 7 days landed within 10% of target.",
    ]);
  });

  test("test_generateWeeklyReport_zeroTargetsAndMacros_returnsZeroSafeBoundaryValues", () => {
    const days = Array.from({ length: 7 }, (_, index) =>
      baseDay(`2026-06-${10 + index}`, {
        targetKcal: 0,
        kcal: 0,
        proteinGrams: 0,
        carbsGrams: 0,
        fatGrams: 0,
        sodiumMg: 0,
        micronutrients: {},
        nutrientTargets: {},
      }),
    );

    const report = generateWeeklyReport({ days, sodiumLimitMg: 2000 });

    expect(report.averageKcal).toBe(0);
    expect(report.macroSplit).toEqual({ proteinPct: 0, carbsPct: 0, fatPct: 0 });
    expect(report.adherencePct).toBe(0);
    expect(report.topNutrientGaps).toEqual([]);
    expect(report.sodiumTrend).toBe("flat");
    expect(report.suggestions).toEqual(["Log complete meals for the next 7 days to unlock more specific guidance."]);
  });

  test("test_generateWeeklyReport_lessThanSevenDays_throwsHelpfulError", () => {
    const days = Array.from({ length: 6 }, (_, index) => baseDay(`2026-06-${10 + index}`));

    expect(() => generateWeeklyReport({ days, sodiumLimitMg: 2000 })).toThrow(
      "Weekly report requires exactly 7 days of data.",
    );
  });
});
