import { describe, expect, test } from "vitest";

import { selectWeeklyPool } from "../../src/engine/pool-selection.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";

describe("selectWeeklyPool kcal viability screen", () => {
  test("drops mains that cannot reach the energy band and says so in a notice", () => {
    const result = selectWeeklyPool({
      candidates: [
        ...breakfasts(),
        main("solid_a", 675),
        main("solid_b", 675),
        main("solid_c", 675),
        main("solid_d", 675),
        main("solid_e", 675),
        main("thin_soup", 200),
        ...sides(),
      ],
      // No catalog: no staple lever, so a 200-kcal main can never make a
      // 1800-kcal day with this pool.
      kcalScreen: { dailyKcalTarget: 1800 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.mains.map((dish) => dish.slug)).not.toContain("thin_soup");
    expect((result.pool.poolNotices ?? []).join(" ")).toContain("thin_soup");
  });

  test("fails fast with a dialog when every main is kcal-infeasible", () => {
    const result = selectWeeklyPool({
      candidates: [
        ...breakfasts(),
        main("thin_a", 200),
        main("thin_b", 210),
        main("thin_c", 190),
        main("thin_d", 220),
        main("thin_e", 205),
        ...sides(),
      ],
      kcalScreen: { dailyKcalTarget: 1800 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected kcal-infeasible pool to fail fast");
    expect(result.cannotSatisfy.reason).toContain("kcal-infeasible");
    expect(result.cannotSatisfy.suggestions.length).toBeGreaterThan(0);
  });

  test("drops a main when the actual rotation pairing would break the band, even if each main passes alone", () => {
    // Each 700-kcal main passes against its best-case partner (the 300-kcal
    // main), but the fixed rotation pairs the two 700s on one day.
    const result = selectWeeklyPool({
      candidates: [
        ...smallBreakfasts(400),
        main("heavy_a", 700),
        main("heavy_b", 700),
        main("light", 300),
        ...sides(),
      ],
      kcalScreen: { dailyKcalTarget: 1500 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    // One heavy main is dropped so no rotation day can exceed the band.
    expect(result.pool.mains.filter((dish) => dish.slug.startsWith("heavy")).length).toBe(1);
    expect((result.pool.poolNotices ?? []).join(" ")).toContain("kcal-infeasible");
  });

  test("no screen configured: mains pass through untouched", () => {
    const result = selectWeeklyPool({
      candidates: [...breakfasts(), main("thin_soup", 200), ...mains5(), ...sides()],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.mains.map((dish) => dish.slug)).toContain("thin_soup");
  });
});

function main(slug: string, kcal: number): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes: ["lunch", "dinner"],
    role: "main",
    selfContained: true,
    nutrition: { kcal, proteinGrams: 40, carbsGrams: 60, fatGrams: 18, sodiumMg: 500 },
    ingredients: [{ slug: "chicken_breast", grams: 150 }],
    seasonings: [],
    source: "preset",
  };
}

function mains5(): RecipeDish[] {
  return ["m_a", "m_b", "m_c", "m_d", "m_e"].map((slug) => main(slug, 675));
}

function breakfasts(): RecipeDish[] {
  return smallBreakfasts(450);
}

function smallBreakfasts(kcal: number): RecipeDish[] {
  return ["b_0", "b_1", "b_2"].map((slug) => ({
    slug,
    name: slug,
    mealTypes: ["breakfast"] as const,
    nutrition: { kcal, proteinGrams: 25, carbsGrams: 50, fatGrams: 12, sodiumMg: 200 },
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
