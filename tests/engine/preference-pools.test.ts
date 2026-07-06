import { describe, expect, test } from "vitest";

import { generateWeeklyMealPlan } from "../../src/engine/meal-planner.js";
import { selectWeeklyPool } from "../../src/engine/pool-selection.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";

/**
 * CHA-MPV2-6: W2 preference signals set pool slot counts.
 *  - liked mains are seated in the pool and receive >=2 rotation slots/week
 *  - dishes skipped >=2 times (avoidedDishSlugs) are excluded from the pool
 *  - safety beats preference: a liked-but-allergen-tagged main never enters
 */
describe("CHA-MPV2-6 preference-frequency pools (W2)", () => {
  test("a liked main is seated in the pool ahead of better-ranked filler", () => {
    // 8 usable mains fight for 7 seats; the liked main has the WORST fat rank
    // and no preferred-ingredient bonus, so without the liked signal it is the
    // one squeezed out.
    const liked = { ...main("liked_fatty_beef", 40), nutrition: { ...main("x", 40).nutrition, fatGrams: 38 } };
    const result = selectWeeklyPool({
      candidates: [...breakfasts(), liked, ...mains(7), ...sides()],
      preferences: { likedDishSlugs: ["liked_fatty_beef"] },
      fatBudget: { dailyTargetGrams: 49 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.mains.map((dish) => dish.slug)).toContain("liked_fatty_beef");

    const control = selectWeeklyPool({
      candidates: [...breakfasts(), liked, ...mains(7), ...sides()],
      fatBudget: { dailyTargetGrams: 49 },
    });
    expect(control.ok).toBe(true);
    if (!control.ok) throw new Error(control.cannotSatisfy.reason);
    expect(control.pool.mains.map((dish) => dish.slug)).not.toContain("liked_fatty_beef");
  });

  test("a liked main receives >=2 slots in the generated week", () => {
    const liked = main("liked_main", 38);
    const plan = generateWeeklyMealPlan({
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      presetDishes: [...breakfasts(), liked, ...mains(7), ...sides()],
      pools: poolFor([...breakfasts(), liked, ...mains(7), ...sides()], {
        likedDishSlugs: ["liked_main"],
      }),
    });

    const likedUses = plan.entries.filter((entry) => entry.dish.slug === "liked_main").length;
    expect(likedUses).toBeGreaterThanOrEqual(2);
  });

  test("dishes skipped >=2 times are excluded from the pool outright", () => {
    const result = selectWeeklyPool({
      candidates: [...breakfasts(), ...mains(5), ...sides()],
      preferences: { avoidedDishSlugs: ["main_0", "main_1"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    const slugs = result.pool.mains.map((dish) => dish.slug);
    expect(slugs).not.toContain("main_0");
    expect(slugs).not.toContain("main_1");
    expect(slugs.length).toBe(3);
    expect(result.pool.poolNotices?.some((notice) => notice.includes("skipped twice or more"))).toBe(true);
  });

  test("safety beats preference: a liked allergen-tagged main never enters the pool", () => {
    const likedShrimp: RecipeDish = {
      ...main("liked_shrimp_bowl", 46),
      allergenTags: ["seafood", "shellfish"],
    };
    const result = selectWeeklyPool({
      candidates: [...breakfasts(), likedShrimp, ...mains(7), ...sides()],
      preferences: {
        allergens: ["seafood"],
        likedDishSlugs: ["liked_shrimp_bowl"],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.all.map((dish) => dish.slug)).not.toContain("liked_shrimp_bowl");
    expect(result.pool.poolNotices?.some((notice) =>
      notice.includes("liked_shrimp_bowl") && notice.includes("safety"),
    )).toBe(true);
  });

  test("the skip signal outranks the liked signal for the same dish", () => {
    const result = selectWeeklyPool({
      candidates: [...breakfasts(), ...mains(8), ...sides()],
      preferences: {
        likedDishSlugs: ["main_2"],
        avoidedDishSlugs: ["main_2"],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.mains.map((dish) => dish.slug)).not.toContain("main_2");
    expect(result.pool.poolNotices?.some((notice) =>
      notice.includes("main_2") && notice.includes("skip signal wins"),
    )).toBe(true);
  });

  test("a weekly floor starved only by the skip exclusion is waived with the honest reason", () => {
    const redMeat: RecipeDish = { ...main("braised_beef", 41), buckets: ["red_meat"] };
    const result = selectWeeklyPool({
      candidates: [...breakfasts(), redMeat, ...mains(6), ...sides()],
      preferences: { avoidedDishSlugs: ["braised_beef"] },
      weeklyFloors: { red_meat: 1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.mains.map((dish) => dish.slug)).not.toContain("braised_beef");
    expect(result.pool.waivedFloors).toEqual([
      {
        bucket: "red_meat",
        floor: 1,
        reason: "1 candidate(s) carrying red_meat were excluded after being skipped twice or more recently",
      },
    ]);
  });
});

function poolFor(
  candidates: readonly RecipeDish[],
  preferences: Parameters<typeof selectWeeklyPool>[0]["preferences"],
): { breakfasts: readonly RecipeDish[]; mains: readonly RecipeDish[]; sides: readonly RecipeDish[] } {
  const result = selectWeeklyPool({ candidates, ...(preferences === undefined ? {} : { preferences }) });
  if (!result.ok) throw new Error(result.cannotSatisfy.reason);
  return { breakfasts: result.pool.breakfasts, mains: result.pool.mains, sides: result.pool.sides };
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
