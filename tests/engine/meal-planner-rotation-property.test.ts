import { describe, expect, test } from "vitest";

import {
  generateWeeklyMealPlan,
  MealPlanInfeasibleError,
} from "../../src/engine/meal-planner.js";
import { PROTEIN_FLOOR_RATIO, MAX_ENERGY_TOLERANCE_RATIO } from "../../src/engine/scoring-weights.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import type { FoodCatalogRecord, MealCatalog } from "../../src/tools/nutrition-estimate.js";

/**
 * V2-P3 acceptance: every generated day meets the kcal band and protein floor
 * BY CONSTRUCTION (levers), over randomized pools. Infeasible pools must
 * block-and-explain; a returned plan must never carry an out-of-band or
 * under-floor day.
 */
describe("rotation fill correctness property (randomized pools)", () => {
  test("every planned day is in-band and above the protein floor; rotation rules hold", () => {
    const rand = lcg(20260705);
    let planned = 0;
    let blocked = 0;

    for (let run = 0; run < 40; run += 1) {
      const dailyKcalTarget = 1500 + Math.floor(rand() * 11) * 50; // 1500-2000
      const dailyProteinTarget = 90 + Math.floor(rand() * 7) * 10; // 90-150
      const request = {
        startDate: "2026-07-06",
        dailyKcalTarget,
        dailyProteinTarget,
        presetDishes: randomPool(rand),
        catalog: CATALOG,
      };

      let plan;
      try {
        plan = generateWeeklyMealPlan(request);
      } catch (error) {
        expect(error).toBeInstanceOf(MealPlanInfeasibleError);
        blocked += 1;
        continue;
      }
      planned += 1;

      const floor = Math.round(dailyProteinTarget * PROTEIN_FLOOR_RATIO);
      for (const day of plan.days) {
        expect(Math.abs(day.totals.kcal - dailyKcalTarget))
          .toBeLessThanOrEqual(dailyKcalTarget * MAX_ENERGY_TOLERANCE_RATIO);
        expect(day.totals.proteinGrams).toBeGreaterThanOrEqual(floor);
      }

      const mainsByDay = plan.days.map((day) =>
        day.meals.filter((meal) => meal.mealType !== "breakfast").map((meal) => meal.dish.slug));
      const counts = new Map<string, number>();
      mainsByDay.forEach((slugs, dayIndex) => {
        for (const slug of slugs) {
          counts.set(slug, (counts.get(slug) ?? 0) + 1);
          if (dayIndex > 0) {
            expect(mainsByDay[dayIndex - 1]).not.toContain(slug);
          }
        }
      });
      for (const count of counts.values()) {
        expect(count).toBeLessThanOrEqual(2);
      }

      for (const entry of plan.entries) {
        if (entry.staple !== undefined) {
          expect(entry.staple.grams % 30).toBe(0);
        }
      }
    }

    // The property is vacuous if everything blocks; most random pools must plan.
    expect(planned).toBeGreaterThanOrEqual(20);
    expect(planned + blocked).toBe(40);
  });
});

function randomPool(rand: () => number): RecipeDish[] {
  const breakfasts = Array.from({ length: 3 }, (_, index) =>
    poolDish(`breakfast_${index}`, ["breakfast"], [
      { slug: "egg", grams: 50 + Math.floor(rand() * 6) * 10 },
      { slug: "oats", grams: 40 + Math.floor(rand() * 5) * 10 },
    ]));
  const mains = Array.from({ length: 7 }, (_, index) => {
    const protein = rand() < 0.5 ? "chicken_breast" : "tofu";
    return {
      ...poolDish(`main_${index}`, ["lunch", "dinner"], [
        { slug: protein, grams: 60 + Math.floor(rand() * 15) * 10 },
        { slug: "broccoli", grams: 50 + Math.floor(rand() * 11) * 10 },
        { slug: "olive_oil", grams: Math.floor(rand() * 4) * 5 },
      ].filter((ingredient) => ingredient.grams > 0)),
      role: "main" as const,
      selfContained: rand() < 0.5,
    };
  });
  const sides = Array.from({ length: 3 }, (_, index) => ({
    ...poolDish(`side_${index}`, ["lunch", "dinner"], [
      { slug: "broccoli", grams: 80 + Math.floor(rand() * 5) * 10 },
    ]),
    role: "side" as const,
    sideKind: "vegetable" as const,
  }));
  return [...breakfasts, ...mains, ...sides];
}

function poolDish(
  slug: string,
  mealTypes: RecipeDish["mealTypes"],
  ingredients: RecipeDish["ingredients"],
): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes,
    // Stored blocks are deliberately zero: generation must compute from
    // ingredients via the catalog.
    nutrition: { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 },
    ingredients,
    seasonings: [],
    source: "preset",
  };
}

const CATALOG: MealCatalog = {
  foods: [
    record("egg", 139, 13.1, 2.4, 8.6, 131.5),
    record("oats", 369, 14, 56.2, 6.8, 0),
    record("chicken_breast", 118, 19.4, 2.5, 5, 34.4),
    record("tofu", 84, 6.6, 3.4, 5.3, 5.6),
    record("broccoli", 27, 3.5, 3.7, 0.6, 46.7),
    record("olive_oil", 884, 0, 0, 99.9, 2),
    record("soy_milk", 33, 3, 1.8, 1.6, 3),
    record("yogurt_high_protein", 63, 11, 4.5, 0, 38),
    record("brown_rice", 348, 7.7, 75, 2.7, 5.4),
  ],
  naturalUnits: [],
};

function record(
  slug: string,
  kcalPer100g: number,
  proteinGramsPer100g: number,
  carbsGramsPer100g: number,
  fatGramsPer100g: number,
  sodiumMgPer100g: number,
): FoodCatalogRecord {
  return {
    slug,
    weightType: "raw",
    defaultGrams: null,
    defaultUnit: null,
    kcalPer100g,
    proteinGramsPer100g,
    carbsGramsPer100g,
    fatGramsPer100g,
    sodiumMgPer100g,
  };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
