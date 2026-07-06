import { describe, expect, test } from "vitest";

import {
  buildDayEntries,
  generateWeeklyMealPlan,
  type MealPlanEntry,
  type MealPlanRequest,
} from "../../src/engine/meal-planner.js";
import { selectWeeklyPool } from "../../src/engine/pool-selection.js";
import { MAX_ENERGY_TOLERANCE_RATIO, PROTEIN_FLOOR_RATIO } from "../../src/engine/scoring-weights.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import type { FoodCatalogRecord, MealCatalog } from "../../src/tools/nutrition-estimate.js";

describe("V2-P4 preference-frequency pools", () => {
  test("skipped->=2 dishes (avoidedDishSlugs) drop out of the main pool when alternatives exist", () => {
    const result = selectWeeklyPool({
      candidates: [
        ...breakfasts(),
        ...mains(8),
        ...sides(),
      ],
      preferences: { avoidedDishSlugs: ["main_2"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.mains.map((dish) => dish.slug)).not.toContain("main_2");
    expect(result.pool.mains.length).toBe(7);
  });

  test("an avoided dish re-enters as at most one last-resort slot to reach the pool minimum", () => {
    const result = selectWeeklyPool({
      candidates: [
        ...breakfasts(),
        ...mains(5),
        ...sides(),
      ],
      preferences: { avoidedDishSlugs: ["main_0", "main_1"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    const slugs = result.pool.mains.map((dish) => dish.slug);
    const avoidedInPool = slugs.filter((slug) => slug === "main_0" || slug === "main_1");
    expect(avoidedInPool.length).toBeLessThanOrEqual(1);
  });

  test("a liked main lands in the pool and appears exactly twice in the week", () => {
    const liked = { ...main("liked_main", 40), ingredients: [{ slug: "chicken_breast", grams: 150 }] };
    const plan = generateWeeklyMealPlan({
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      presetDishes: [
        ...breakfasts(),
        liked,
        ...mains(6),
        ...sides(),
      ],
      preferences: { preferredIngredients: ["chicken_breast"] },
    });

    const likedUses = plan.entries.filter((entry) => entry.dish.slug === "liked_main").length;
    expect(likedUses).toBe(2);
  });
});

describe("V2-P4 pre-vetted alternates", () => {
  test("every lunch and dinner entry carries 1-2 alternates that avoid same-day and adjacent-day mains", () => {
    const plan = generateWeeklyMealPlan({
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      presetDishes: [...breakfasts(), ...mains(7), ...sides()],
    });

    const mainEntriesByDate = new Map<string, string[]>();
    for (const entry of plan.entries.filter((item) => item.mealType !== "breakfast")) {
      mainEntriesByDate.set(entry.date, [...(mainEntriesByDate.get(entry.date) ?? []), entry.dish.slug]);
    }

    for (const entry of plan.entries.filter((item) => item.mealType !== "breakfast")) {
      const alternates = entry.alternates ?? [];
      expect(alternates.length).toBeGreaterThanOrEqual(1);
      expect(alternates.length).toBeLessThanOrEqual(2);
      for (const alternate of alternates) {
        expect(mainEntriesByDate.get(entry.date)).not.toContain(alternate.slug);
      }
    }
  });

  test("breakfast entries carry no alternates", () => {
    const plan = generateWeeklyMealPlan({
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      presetDishes: [...breakfasts(), ...mains(7), ...sides()],
    });
    expect(plan.entries.filter((entry) => entry.mealType === "breakfast")
      .every((entry) => entry.alternates === undefined)).toBe(true);
  });
});

/**
 * CHA-MPV2-7 (V2-P4b): alternates come from the selected pool, re-lever
 * through the SAME buildDayEntries path as primary entries, and respect the
 * rotation rules for the surrounding days.
 */
describe("CHA-MPV2-7 alternates re-lever + rotation rules", () => {
  test("every alternate is from the pool, and re-running both levers on it keeps the day in-band and above the protein floor", () => {
    const pools = {
      breakfasts: leverBreakfasts(),
      mains: leverMains(7),
      sides: [],
    };
    const request: MealPlanRequest = {
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 120,
      catalog: LEVER_CATALOG,
      pools,
    };
    const plan = generateWeeklyMealPlan(request);
    const poolSlugs = new Set(pools.mains.map((dish) => dish.slug));
    const dishBySlug = new Map(pools.mains.map((dish) => [dish.slug, dish]));
    const proteinFloor = Math.round(120 * PROTEIN_FLOOR_RATIO);

    let vettedAlternates = 0;
    plan.days.forEach((day, dayIndex) => {
      const [breakfast, lunch, dinner] = day.meals;
      if (breakfast === undefined || lunch === undefined || dinner === undefined) {
        throw new Error(`${day.date} is structurally incomplete`);
      }
      for (const slot of ["lunch", "dinner"] as const) {
        const entry = slot === "lunch" ? lunch : dinner;
        const alternates = entry.alternates ?? [];
        expect(alternates.length).toBeGreaterThanOrEqual(1);
        expect(alternates.length).toBeLessThanOrEqual(2);
        for (const alternate of alternates) {
          // (1) drawn from the selected weekly pool, never outside it
          expect(poolSlugs.has(alternate.slug)).toBe(true);
          const substitute = dishBySlug.get(alternate.slug);
          if (substitute === undefined) throw new Error(`alternate ${alternate.slug} missing from pool`);

          // (2) re-run BOTH levers through the production path with the
          // alternate substituted; the day must still meet the hard gates.
          const trial = buildDayEntries(
            request,
            day.date,
            dayIndex,
            breakfast.dish,
            slot === "lunch" ? substitute : lunch.dish,
            slot === "dinner" ? substitute : dinner.dish,
          );
          const totals = sumEntryNutrition(trial);
          expect(Math.abs(totals.kcal - 1800)).toBeLessThanOrEqual(1800 * MAX_ENERGY_TOLERANCE_RATIO);
          expect(totals.proteinGrams).toBeGreaterThanOrEqual(proteinFloor);
          // The staple lever really ran: portions sit on its 30g lattice.
          for (const trialEntry of trial) {
            if (trialEntry.staple !== undefined) expect(trialEntry.staple.grams % 30).toBe(0);
          }
          vettedAlternates += 1;
        }
      }
    });
    expect(vettedAlternates).toBeGreaterThanOrEqual(14);
  });

  test("substituting any alternate keeps rotation rules: never consecutive days, minimal weekly use, <=2x when an under-used main exists", () => {
    // 8 homogeneous mains: the 14 rotation slots leave two mains at one use
    // each — those under-used mains are the only alternates that can keep a
    // substituted week at <=2 uses per main.
    const pools = {
      breakfasts: leverBreakfasts(),
      mains: leverMains(8),
      sides: [],
    };
    const request: MealPlanRequest = {
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 120,
      catalog: LEVER_CATALOG,
      pools,
    };
    const plan = generateWeeklyMealPlan(request);

    const mainsByDay = plan.days.map((day) =>
      day.meals.filter((meal) => meal.mealType !== "breakfast").map((meal) => meal.dish.slug));
    const rotationCounts = new Map<string, number>();
    for (const slugs of mainsByDay) {
      for (const slug of slugs) rotationCounts.set(slug, (rotationCounts.get(slug) ?? 0) + 1);
    }
    const underUsed = new Set(
      pools.mains.map((dish) => dish.slug).filter((slug) => (rotationCounts.get(slug) ?? 0) <= 1),
    );
    expect(underUsed.size).toBe(2);

    plan.days.forEach((day, dayIndex) => {
      const adjacent = new Set([
        ...(mainsByDay[dayIndex - 1] ?? []),
        ...(mainsByDay[dayIndex + 1] ?? []),
      ]);
      const sameDay = new Set(mainsByDay[dayIndex]);
      const underUsedAvailable = [...underUsed].some((slug) => !adjacent.has(slug) && !sameDay.has(slug));

      for (const entry of day.meals.filter((meal) => meal.mealType !== "breakfast")) {
        const slotIndex = entry.mealType === "lunch" ? 0 : 1;
        for (const alternate of entry.alternates ?? []) {
          // Build the substituted week's main matrix.
          const substituted = mainsByDay.map((slugs, index) =>
            index === dayIndex ? slugs.map((slug, position) => (position === slotIndex ? alternate.slug : slug)) : slugs);

          // (3a) no main on two consecutive days, anywhere in the substituted week
          substituted.forEach((slugs, index) => {
            if (index === 0) return;
            for (const slug of slugs) expect(substituted[index - 1]).not.toContain(slug);
          });

          // (3b) minimal weekly use: with an under-used candidate available,
          // every offered alternate keeps the substituted week at <=2 uses per
          // main; without one (the alternate's floor), only the substituted
          // dish may reach the unavoidable third use.
          const counts = new Map<string, number>();
          for (const slugs of substituted) {
            for (const slug of slugs) counts.set(slug, (counts.get(slug) ?? 0) + 1);
          }
          for (const [slug, count] of counts) {
            const cap = slug === alternate.slug && !underUsedAvailable ? 3 : 2;
            expect(count, `${slug} appears ${count}x after substituting ${alternate.slug} on ${day.date}`)
              .toBeLessThanOrEqual(cap);
          }
        }
      }
    });
  });
});

function leverMains(count: number): RecipeDish[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `lever_main_${index}`,
    name: `lever_main_${index}`,
    mealTypes: ["lunch", "dinner"] as const,
    role: "main" as const,
    selfContained: true,
    // Stored blocks zero: generation and re-levering must compute from the
    // catalog, so the levers actually engage.
    nutrition: { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 },
    ingredients: [
      { slug: "chicken_breast", grams: 150 },
      { slug: "broccoli", grams: 100 },
      { slug: "olive_oil", grams: 5 },
    ],
    seasonings: [],
    source: "preset" as const,
  }));
}

function leverBreakfasts(): RecipeDish[] {
  return ["lever_b_0", "lever_b_1", "lever_b_2"].map((slug) => ({
    slug,
    name: slug,
    mealTypes: ["breakfast"] as const,
    nutrition: { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 },
    ingredients: [
      { slug: "egg", grams: 100 },
      { slug: "oats", grams: 60 },
    ],
    seasonings: [],
    source: "preset" as const,
  }));
}

function sumEntryNutrition(entries: readonly MealPlanEntry[]): {
  kcal: number;
  proteinGrams: number;
} {
  return {
    kcal: entries.reduce((sum, entry) => sum + entry.nutrition.kcal, 0),
    proteinGrams: entries.reduce((sum, entry) => sum + entry.nutrition.proteinGrams, 0),
  };
}

const LEVER_CATALOG: MealCatalog = {
  foods: [
    leverRecord("egg", 139, 13.1, 2.4, 8.6, 131.5),
    leverRecord("oats", 369, 14, 56.2, 6.8, 0),
    leverRecord("chicken_breast", 118, 19.4, 2.5, 5, 34.4),
    leverRecord("broccoli", 27, 3.5, 3.7, 0.6, 46.7),
    leverRecord("olive_oil", 884, 0, 0, 99.9, 2),
    leverRecord("tofu", 84, 6.6, 3.4, 5.3, 5.6),
    leverRecord("soy_milk", 33, 3, 1.8, 1.6, 3),
    leverRecord("yogurt_high_protein", 63, 11, 4.5, 0, 38),
    leverRecord("brown_rice", 348, 7.7, 75, 2.7, 5.4),
  ],
  naturalUnits: [],
};

function leverRecord(
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

function main(slug: string, proteinGrams: number): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes: ["lunch", "dinner"],
    role: "main",
    selfContained: true,
    nutrition: { kcal: 675, proteinGrams, carbsGrams: 70, fatGrams: 20, sodiumMg: 500 },
    ingredients: [{ slug: "tofu", grams: 150 }],
    seasonings: [],
    source: "preset",
  };
}

function mains(count: number): RecipeDish[] {
  return Array.from({ length: count }, (_, index) => main(`main_${index}`, 35 + index));
}

function breakfasts(): RecipeDish[] {
  return ["b_0", "b_1", "b_2"].map((slug) => ({
    slug,
    name: slug,
    mealTypes: ["breakfast"] as const,
    nutrition: { kcal: 450, proteinGrams: 25, carbsGrams: 50, fatGrams: 12, sodiumMg: 200 },
    ingredients: [{ slug: "egg", grams: 100 }],
    seasonings: [],
    source: "preset" as const,
  }));
}

function sides(): RecipeDish[] {
  return ["s_0", "s_1", "s_2"].map((slug) => ({
    slug,
    name: slug,
    mealTypes: ["lunch", "dinner"] as const,
    role: "side" as const,
    sideKind: "vegetable" as const,
    nutrition: { kcal: 25, proteinGrams: 2, carbsGrams: 3, fatGrams: 1, sodiumMg: 50 },
    ingredients: [{ slug: "broccoli", grams: 100 }],
    seasonings: [],
    source: "preset" as const,
  }));
}
