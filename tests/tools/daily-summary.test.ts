import { describe, expect, test } from "vitest";

import { dailySummary } from "../../src/tools/daily-summary.js";
import { logExercise } from "../../src/tools/log-exercise.js";
import { logMeal } from "../../src/tools/log-meal.js";
import { logWater } from "../../src/tools/log-water.js";
import { logWeight } from "../../src/tools/log-weight.js";
import { createInMemoryHealthRepository } from "../../src/tools/store.js";

const catalog = {
  foods: [
    {
      slug: "chicken_breast",
      name: "chicken breast",
      aliases: ["鸡胸肉"],
      defaultGrams: 120,
      defaultUnit: "serving",
      kcalPer100g: 165,
      proteinGramsPer100g: 31,
      carbsGramsPer100g: 0,
      fatGramsPer100g: 3.6,
      sodiumMgPer100g: 74,
    },
    {
      slug: "brown_rice",
      name: "brown rice",
      aliases: ["糙米"],
      defaultGrams: 150,
      defaultUnit: "bowl",
      kcalPer100g: 112,
      proteinGramsPer100g: 2.6,
      carbsGramsPer100g: 23,
      fatGramsPer100g: 0.9,
      sodiumMgPer100g: 5,
    },
    {
      slug: "broccoli",
      name: "broccoli",
      aliases: ["西兰花"],
      defaultGrams: 100,
      defaultUnit: "serving",
      kcalPer100g: 35,
      proteinGramsPer100g: 2.4,
      carbsGramsPer100g: 7.2,
      fatGramsPer100g: 0.4,
      sodiumMgPer100g: 41,
    },
    {
      slug: "salty_soup",
      name: "salty soup",
      aliases: ["咸汤"],
      defaultGrams: 500,
      defaultUnit: "bowl",
      kcalPer100g: 60,
      proteinGramsPer100g: 3,
      carbsGramsPer100g: 8,
      fatGramsPer100g: 1,
      sodiumMgPer100g: 600,
    },
  ],
  naturalUnits: [
    { foodSlug: "chicken_breast", unit: "piece", grams: 200, aliases: ["块"] },
    { foodSlug: "brown_rice", unit: "bowl", grams: 150, aliases: ["碗"] },
    { foodSlug: "broccoli", unit: "serving", grams: 100, aliases: ["份"] },
    { foodSlug: "salty_soup", unit: "bowl", grams: 500, aliases: ["碗"] },
  ],
};

const target = {
  kcal: 1800,
  proteinGrams: 100,
  carbsGrams: 200,
  fatGrams: 60,
};

describe("dailySummary", () => {
  test("dailySummary_whenDayHasLogs_returnsTotalsRemainingAndWarnings", () => {
    const repository = createInMemoryHealthRepository();

    logMeal(
      { date: "2026-06-17", mealType: "breakfast", description: "1 bowl brown rice" },
      repository,
      catalog,
    );
    logMeal(
      {
        date: "2026-06-17",
        mealType: "lunch",
        description: "1 piece chicken breast + 1 bowl brown rice + 100g broccoli",
      },
      repository,
      catalog,
    );
    logMeal(
      { date: "2026-06-17", mealType: "dinner", description: "1 bowl salty soup" },
      repository,
      catalog,
    );
    logWater({ date: "2026-06-17", description: "one cup" }, repository);
    logWater({ date: "2026-06-17", description: "one glass" }, repository);
    logWater({ date: "2026-06-17", description: "250ml" }, repository);
    logExercise({ date: "2026-06-17", description: "running 30 minutes" }, repository);
    logWeight({ date: "2026-06-17", description: "72.5kg, blood pressure 120/80" }, repository);

    const summary = dailySummary({ date: "2026-06-17", target }, repository);

    expect(summary.eaten).toEqual({
      kcal: 1001,
      proteinGrams: 87.2,
      carbsGrams: 116.2,
      fatGrams: 15.4,
      sodiumMg: 3205,
    });
    expect(summary.remaining).toEqual({
      kcal: 799,
      proteinGrams: 12.8,
      carbsGrams: 83.8,
      fatGrams: 44.6,
    });
    expect(summary.water.totalMl).toBe(750);
    expect(summary.exercise.kcalBurned).toBe(280);
    expect(summary.latestPhysicalCondition).toMatchObject({ weightKg: 72.5 });
    expect(summary.warnings).toEqual(["kcal_under_80pct", "sodium_over_2300mg"]);
  });

  test("dailySummary_whenDayHasNoLogs_returnsZeroTotalsAndFullRemaining", () => {
    const repository = createInMemoryHealthRepository();

    const summary = dailySummary({ date: "2026-06-17", target }, repository);

    expect(summary.eaten).toEqual({
      kcal: 0,
      proteinGrams: 0,
      carbsGrams: 0,
      fatGrams: 0,
      sodiumMg: 0,
    });
    expect(summary.remaining).toEqual(target);
    expect(summary.water.totalMl).toBe(0);
    expect(summary.exercise.kcalBurned).toBe(0);
    expect(summary.latestPhysicalCondition).toBeUndefined();
    expect(summary.warnings).toEqual(["kcal_under_80pct", "protein_under_80pct"]);
  });

  test("dailySummary_whenKcalOrProteinAreHigh_returnsThresholdWarnings", () => {
    const repository = createInMemoryHealthRepository();

    logMeal(
      {
        date: "2026-06-17",
        mealType: "lunch",
        description: "900g chicken breast + 1500g brown rice",
      },
      repository,
      catalog,
    );

    const summary = dailySummary({ date: "2026-06-17", target }, repository);

    expect(summary.warnings).toEqual(["kcal_over_115pct", "protein_over_130pct"]);
  });

  test("dailySummary_whenTargetIsInvalid_throwsRangeError", () => {
    const repository = createInMemoryHealthRepository();

    expect(() =>
      dailySummary(
        {
          date: "2026-06-17",
          target: { kcal: 0, proteinGrams: 100, carbsGrams: 200, fatGrams: 60 },
        },
        repository,
      ),
    ).toThrow(RangeError);
  });

  test("dailySummary_whenDateIsImpossible_throwsRangeError", () => {
    const repository = createInMemoryHealthRepository();

    expect(() => dailySummary({ date: "2026-99-99", target }, repository)).toThrow(RangeError);
  });

  test.each([
    ["null", null as unknown as typeof target],
    ["wrong runtime type", "target" as unknown as typeof target],
    [
      "non numeric fields",
      {
        kcal: "1800",
        proteinGrams: 100,
        carbsGrams: 200,
        fatGrams: 60,
      } as unknown as typeof target,
    ],
  ])("dailySummary_whenTargetIsMalformed_%s_throwsRangeError", (_caseName, malformedTarget) => {
    const repository = createInMemoryHealthRepository();

    expect(() =>
      dailySummary({ date: "2026-06-17", target: malformedTarget }, repository),
    ).toThrow(RangeError);
  });
});
