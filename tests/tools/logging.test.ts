import { describe, expect, test } from "vitest";

import { logExercise } from "../../src/tools/log-exercise.js";
import { logMeal } from "../../src/tools/log-meal.js";
import { logWater } from "../../src/tools/log-water.js";
import { logWeight } from "../../src/tools/log-weight.js";
import { nutritionEstimate } from "../../src/tools/nutrition-estimate.js";
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
  ],
  naturalUnits: [
    { foodSlug: "chicken_breast", unit: "piece", grams: 200, aliases: ["块"] },
    { foodSlug: "brown_rice", unit: "bowl", grams: 150, aliases: ["碗"] },
    { foodSlug: "broccoli", unit: "serving", grams: 100, aliases: ["份"] },
  ],
};

describe("logging tools", () => {
  test("logMeal_whenDescriptionHasNaturalUnits_insertsDietLogWithNutrition", () => {
    const repository = createInMemoryHealthRepository();

    const row = logMeal(
      {
        date: "2026-06-17",
        mealType: "lunch",
        description: "1 piece chicken breast + 1 bowl brown rice + 100g broccoli",
      },
      repository,
      catalog,
    );

    expect(row).toMatchObject({
      date: "2026-06-17",
      mealType: "lunch",
      kcal: 533,
      proteinGrams: 68.3,
      carbsGrams: 41.7,
      fatGrams: 9,
      sodiumMg: 197,
    });
    expect(row.items).toEqual([
      { slug: "chicken_breast", grams: 200 },
      { slug: "brown_rice", grams: 150 },
      { slug: "broccoli", grams: 100 },
    ]);
    expect(repository.listDietLogs("2026-06-17")).toHaveLength(1);
  });

  test("logMeal_whenRequiredTextIsBlank_throwsRangeError", () => {
    const repository = createInMemoryHealthRepository();

    expect(() =>
      logMeal({ date: "", mealType: "lunch", description: "brown rice" }, repository, catalog),
    ).toThrow(RangeError);
    expect(() =>
      logMeal({ date: "2026-06-17", mealType: "", description: "brown rice" }, repository, catalog),
    ).toThrow(RangeError);
    expect(() =>
      logMeal({ date: "2026-06-17", mealType: "lunch", description: "  " }, repository, catalog),
    ).toThrow(RangeError);
  });

  test.each([
    [
      "logMeal",
      () =>
        logMeal(
          { date: "2026-99-99", mealType: "lunch", description: "brown rice" },
          createInMemoryHealthRepository(),
          catalog,
        ),
    ],
    [
      "logWater",
      () =>
        logWater(
          { date: "2026-99-99", description: "water 125 ml" },
          createInMemoryHealthRepository(),
        ),
    ],
    [
      "logExercise",
      () =>
        logExercise(
          { date: "2026-99-99", description: "walking 1 min" },
          createInMemoryHealthRepository(),
        ),
    ],
    [
      "logWeight",
      () =>
        logWeight(
          { date: "2026-99-99", description: "72 kg" },
          createInMemoryHealthRepository(),
        ),
    ],
  ])("%s_whenDateIsImpossible_throwsRangeError", (_toolName, act) => {
    expect(act).toThrow(RangeError);
  });

  test.each([
    [
      "logMeal",
      () =>
        logMeal(
          {
            date: "2026-06-17",
            mealType: "lunch",
            description: null as unknown as string,
          },
          createInMemoryHealthRepository(),
          catalog,
        ),
    ],
    [
      "nutritionEstimate",
      () => nutritionEstimate({ description: null as unknown as string }, catalog),
    ],
    [
      "logWater",
      () =>
        logWater(
          { date: "2026-06-17", description: 42 as unknown as string },
          createInMemoryHealthRepository(),
        ),
    ],
    [
      "logExercise",
      () =>
        logExercise(
          { date: "2026-06-17", description: null as unknown as string },
          createInMemoryHealthRepository(),
        ),
    ],
    [
      "logWeight",
      () =>
        logWeight(
          { date: "2026-06-17", description: { value: "72 kg" } as unknown as string },
          createInMemoryHealthRepository(),
        ),
    ],
  ])("%s_whenTextInputHasWrongRuntimeType_throwsRangeError", (_toolName, act) => {
    expect(act).toThrow(RangeError);
  });

  test("nutritionEstimate_whenDescriptionUsesDefaults_returnsNutritionWithoutWriting", () => {
    const result = nutritionEstimate(
      { description: "200g chicken breast + brown rice" },
      catalog,
    );

    expect(result).toMatchObject({
      kcal: 498,
      proteinGrams: 65.9,
      carbsGrams: 34.5,
      fatGrams: 8.6,
      sodiumMg: 156,
    });
    expect(result.items).toEqual([
      { slug: "chicken_breast", grams: 200 },
      { slug: "brown_rice", grams: 150 },
    ]);
  });

  test("nutritionEstimate_whenFoodIsUnknown_throwsRangeError", () => {
    expect(() => nutritionEstimate({ description: "mystery food" }, catalog)).toThrow(RangeError);
  });

  test("logWater_whenCupPhraseProvided_logsDefaultCupAmount", () => {
    const repository = createInMemoryHealthRepository();

    const row = logWater({ date: "2026-06-17", description: "喝了一杯水" }, repository);

    expect(row).toMatchObject({ date: "2026-06-17", amountMl: 250 });
    expect(repository.listWaterLogs("2026-06-17")).toEqual([row]);
  });

  test("logWater_whenExplicitMlProvided_logsParsedAmount", () => {
    const repository = createInMemoryHealthRepository();

    const row = logWater({ date: "2026-06-17", description: "water 125 ml" }, repository);

    expect(row.amountMl).toBe(125);
  });

  test("logWater_whenExplicitMlIsFractional_throwsRangeErrorWithoutWriting", () => {
    const repository = createInMemoryHealthRepository();

    expect(() => logWater({ date: "2026-06-17", description: "water 0.4 ml" }, repository))
      .toThrow(RangeError);
    expect(repository.listWaterLogs("2026-06-17")).toEqual([]);
  });

  test("logWater_whenAmountIsMissing_throwsRangeError", () => {
    const repository = createInMemoryHealthRepository();

    expect(() => logWater({ date: "2026-06-17", description: "just thirsty" }, repository)).toThrow(
      RangeError,
    );
  });

  test("logExercise_whenRunningDurationProvided_logsDeterministicBurn", () => {
    const repository = createInMemoryHealthRepository();

    const row = logExercise({ date: "2026-06-17", description: "跑步30分钟" }, repository);

    expect(row).toMatchObject({
      date: "2026-06-17",
      type: "running",
      durationMinutes: 30,
      kcalBurned: 280,
    });
  });

  test("logExercise_whenWalkingOneMinute_logsBoundaryBurn", () => {
    const repository = createInMemoryHealthRepository();

    const row = logExercise({ date: "2026-06-17", description: "walking 1 min" }, repository);

    expect(row).toMatchObject({ type: "walking", durationMinutes: 1, kcalBurned: 4 });
  });

  test("logExercise_whenTypeIsUnsupported_throwsRangeError", () => {
    const repository = createInMemoryHealthRepository();

    expect(() => logExercise({ date: "2026-06-17", description: "yoga 20 minutes" }, repository))
      .toThrow(RangeError);
  });

  test("logWeight_whenWeightAndBloodPressureProvided_logsPhysicalCondition", () => {
    const repository = createInMemoryHealthRepository();

    const row = logWeight(
      { date: "2026-06-17", description: "72.5kg, blood pressure 120/80" },
      repository,
    );

    expect(row).toMatchObject({
      date: "2026-06-17",
      weightKg: 72.5,
      bpSystolic: 120,
      bpDiastolic: 80,
    });
  });

  test("logWeight_whenBloodPressureIsOmitted_logsWeightOnly", () => {
    const repository = createInMemoryHealthRepository();

    const row = logWeight({ date: "2026-06-17", description: "72 kg" }, repository);

    expect(row.weightKg).toBe(72);
    expect(row.bpSystolic).toBeUndefined();
    expect(row.bpDiastolic).toBeUndefined();
  });

  test("logWeight_whenWeightIsMissing_throwsRangeError", () => {
    const repository = createInMemoryHealthRepository();

    expect(() =>
      logWeight({ date: "2026-06-17", description: "blood pressure 120/80" }, repository),
    ).toThrow(RangeError);
  });
});
