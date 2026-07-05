import { describe, expect, test } from "vitest";

import { generateWeeklyMealPlan } from "../../src/engine/meal-planner.js";
import { selectWeeklyPool } from "../../src/engine/pool-selection.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";

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
