import { describe, expect, test } from "vitest";

import { buildCoverageReport } from "../../src/engine/plan-advisory.js";
import { buildWeeklyBudgets, type MealPlanEntry, type WeeklyMealPlan } from "../../src/engine/meal-planner.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";

describe("buildCoverageReport", () => {
  test("enumerates unmet weekly floors, protein average, weekly budgets, and diversity terms", () => {
    const beef = dish("beef", 600, 40, 900, ["red_meat"], { red_meat: 2 });
    const plain = dish("plain", 600, 20, 2600);
    const entries = [
      entry(0, "breakfast", plain),
      entry(0, "lunch", beef),
      entry(0, "dinner", plain),
      entry(1, "breakfast", plain),
      entry(1, "lunch", plain),
      entry(1, "dinner", plain),
    ];
    const plan = planWith(entries);

    const report = buildCoverageReport(plan, {
      dailyProteinTarget: 100,
      weeklyFloors: { red_meat: 2, deep_sea_fish: 2 },
    });

    expect(report.unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "weekly_floor", key: "deep_sea_fish", actual: 0, target: 2 }),
        expect.objectContaining({ type: "weekly_floor", key: "red_meat", actual: 1, target: 2 }),
        expect.objectContaining({ type: "protein_average", actual: 70, target: 100 }),
        expect.objectContaining({ type: "diversity", actual: 2, target: 10 }),
      ]),
    );
    // Budgets are ceilings: under-cap sodium is not an unmet item (that would
    // be always-on advisory noise, which v2 deletes structurally).
    expect(report.unmet.some((item) => item.type === "weekly_budget" && item.key === "sodium")).toBe(false);
  });

  test("surfaces over-budget fat as a weekly budget instead of a daily ceiling advisory", () => {
    const fatty = dish("fatty_main", 600, 40, 500, [], {}, undefined, { fatGrams: 130 });
    const plan = planWith([entry(0, "lunch", fatty), entry(1, "lunch", fatty)]);

    const report = buildCoverageReport(plan, { dailyFatTarget: 35 });

    expect(report.unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "weekly_budget",
          key: "fat",
          actual: 260,
          target: 245,
        }),
      ]),
    );
    expect(report.unmet.map((item) => item.message).join(" ")).not.toContain("g/day");
  });

  test("under-budget weeks emit no weekly_budget unmet items at all", () => {
    const lean = dish("lean_main", 600, 40, 500, [], {}, undefined, { fatGrams: 20 });
    const plan = planWith([entry(0, "lunch", lean), entry(1, "lunch", lean)]);

    const report = buildCoverageReport(plan, { dailyFatTarget: 35, dailyCarbsTarget: 200 });

    expect(report.unmet.filter((item) => item.type === "weekly_budget")).toEqual([]);
  });

  test("does not surface per-day fat ceiling advisory inside the old tolerance band", () => {
    const slightlyOver = dish("slightly_over_fat", 600, 40, 500, [], {}, undefined, { fatGrams: 46 });
    const plan = planWith([entry(0, "lunch", slightlyOver)]);

    const report = buildCoverageReport(plan, { dailyFatTarget: 40 });

    expect(report.unmet.map((item) => item.message).join(" ")).not.toContain("tolerated ceiling");
  });

  test("advises when the accepted pool has only staples and no protein sources", () => {
    const staple = dish("brown_rice_bowl", 500, 8, 120, ["staple"]);
    const report = buildCoverageReport(planWith([entry(0, "lunch", staple)]), {
      acceptedCandidates: [staple],
    });

    expect(report.unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "pool_coverage",
          key: "protein_sources",
          actual: 0,
          target: 1,
        }),
      ]),
    );
  });

  test("advises when vegetable choices lack leafy, cruciferous, and mushroom variety", () => {
    const cucumberTomato = dish("cucumber_tomato_side", 40, 2, 40, ["vegetable"], {}, [
      { slug: "cucumber", grams: 100 },
      { slug: "tomato", grams: 100 },
    ]);

    const report = buildCoverageReport(planWith([entry(0, "lunch", cucumberTomato)]), {
      acceptedCandidates: [cucumberTomato],
    });

    expect(report.unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "pool_coverage", key: "leafy_vegetables" }),
        expect.objectContaining({ type: "pool_coverage", key: "cruciferous_vegetables" }),
        expect.objectContaining({ type: "pool_coverage", key: "mushrooms" }),
      ]),
    );
  });

  test("advises when protein pool has no low-fat option", () => {
    const fattyProtein = dish("fatty_pork", 700, 35, 240, ["red_meat"], {}, [{ slug: "pork_belly", grams: 180 }], {
      fatGrams: 45,
    });

    const report = buildCoverageReport(planWith([entry(0, "lunch", fattyProtein)]), {
      acceptedCandidates: [fattyProtein],
    });

    expect(report.unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "pool_balance", key: "low_fat_protein" }),
      ]),
    );
  });

  test("does not count konjac filler as a vegetable coverage source", () => {
    const konjac = {
      ...dish("konjac_bowl", 35, 1, 20, ["filler"], {}, [{ slug: "konjac", grams: 150 }]),
      specialHandlingTags: ["filler", "not_vegetable"],
    };

    const report = buildCoverageReport(planWith([entry(0, "lunch", konjac)]), {
      acceptedCandidates: [konjac],
    });

    expect(report.unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "pool_coverage", key: "vegetable_sources" }),
      ]),
    );
    expect(report.unmet.map((item) => item.key)).not.toContain("leafy_vegetables");
  });

  test("does not count dried shrimp seasoning as a main protein source", () => {
    const driedShrimp = {
      ...dish("dried_shrimp_sauce", 90, 24, 1800, ["seasoning"], {}, [{ slug: "dried_shrimp", grams: 50 }]),
      specialHandlingTags: ["seasoning", "high_sodium", "seasoning_not_main_protein"],
    };

    const report = buildCoverageReport(planWith([entry(0, "lunch", driedShrimp)]), {
      acceptedCandidates: [driedShrimp],
    });

    expect(report.unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "pool_coverage", key: "protein_sources" }),
        expect.objectContaining({ type: "pool_balance", key: "high_sodium_special_ingredient" }),
      ]),
    );
  });

  test("advises when weekly-frequency ingredients are planned more than once", () => {
    const chickenLiver = {
      ...dish("chicken_liver_stir_fry", 260, 30, 420, ["organ_meat"], {}, [{ slug: "chicken_liver", grams: 120 }]),
      frequencyHints: { chicken_liver: "weekly" },
    };
    const report = buildCoverageReport(planWith([
      entry(0, "lunch", chickenLiver),
      entry(1, "dinner", chickenLiver),
    ]));

    expect(report.unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "pool_balance",
          key: "weekly_frequency_chicken_liver",
          actual: 2,
          target: 1,
        }),
      ]),
    );
  });

  test("advises when accepted candidates depend on advanced cooking or specialty availability", () => {
    const specialtyDish = {
      ...dish("specialty_preserved_food", 260, 20, 420, ["protein"]),
      cookingDifficulties: ["advanced"],
      availabilityTags: ["specialty"],
    };

    const report = buildCoverageReport(planWith([entry(0, "lunch", specialtyDish)]), {
      acceptedCandidates: [specialtyDish],
    });

    expect(report.unmet).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "pool_balance", key: "advanced_cooking" }),
        expect.objectContaining({ type: "pool_balance", key: "specialty_availability" }),
      ]),
    );
  });
});

function dish(
  slug: string,
  kcal: number,
  proteinGrams: number,
  sodiumMg: number,
  buckets: string[] = [],
  weeklyFloors: Record<string, number> = {},
  ingredients: RecipeDish["ingredients"] = [{ slug, grams: 100 }],
  macros: Partial<RecipeDish["nutrition"]> = {},
): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes: ["breakfast", "lunch", "dinner"],
    nutrition: { kcal, proteinGrams, carbsGrams: 60, fatGrams: 20, sodiumMg, ...macros },
    ingredients,
    seasonings: [],
    source: "preset",
    buckets,
    weeklyFloors,
  };
}

function entry(dayIndex: number, mealType: MealPlanEntry["mealType"], dish: RecipeDish): MealPlanEntry {
  return {
    id: `${dayIndex}-${mealType}`,
    date: `2026-06-${16 + dayIndex}`,
    dayIndex,
    mealType,
    targetKcal: dish.nutrition.kcal,
    dish,
    nutrition: dish.nutrition,
    status: "planned",
  };
}

function planWith(entries: readonly MealPlanEntry[]): WeeklyMealPlan {
  const days = [
    day("2026-06-16", entries.filter((entry) => entry.dayIndex === 0)),
    day("2026-06-17", entries.filter((entry) => entry.dayIndex === 1)),
  ];
  return {
    startDate: "2026-06-16",
    days,
    entries,
    distinctDishCount: new Set(entries.map((entry) => entry.dish.slug)).size,
    hardViolations: [],
    weeklyBudgets: buildWeeklyBudgets({ days }, {}),
  };
}

function day(date: string, meals: readonly MealPlanEntry[]): WeeklyMealPlan["days"][number] {
  return {
    date,
    meals,
    totals: {
      kcal: meals.reduce((sum, meal) => sum + meal.nutrition.kcal, 0),
      proteinGrams: meals.reduce((sum, meal) => sum + meal.nutrition.proteinGrams, 0),
      carbsGrams: meals.reduce((sum, meal) => sum + meal.nutrition.carbsGrams, 0),
      fatGrams: meals.reduce((sum, meal) => sum + meal.nutrition.fatGrams, 0),
      sodiumMg: meals.reduce((sum, meal) => sum + meal.nutrition.sodiumMg, 0),
    },
  };
}
