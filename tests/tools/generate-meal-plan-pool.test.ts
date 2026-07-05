import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, test } from "vitest";

import { presetDishes } from "../../src/data/preset-dishes.js";
import { loadFoodItemsFromCsv } from "../../src/db/seed.js";
import { dishBucketsRoles } from "../../src/engine/classification.js";
import { selectWeeklyPool } from "../../src/engine/pool-selection.js";
import type { RecipeDish } from "../../src/engine/recipe-engine.js";
import { generateMealPlan } from "../../src/tools/generate-meal-plan.js";
import { handleSmartGenerateMealPlan } from "../../src/tools/handlers.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { FoodCatalogRecord, MealCatalog } from "../../src/tools/nutrition-estimate.js";

describe("generateMealPlan weekly pool integration", () => {
  test("relaxes default pool minimums for a small-but-workable library and attaches a notice", () => {
    const storedEntries: unknown[] = [];
    const result = generateMealPlan({
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      presetDishes: [
        dish("only_safe_breakfast", ["breakfast"], 450, 30, "egg"),
        ...Array.from({ length: 5 }, (_, index) =>
          dish(`safe_main_${index}`, ["lunch", "dinner"], 675, 45, "chicken_breast", {
            role: "main",
            selfContained: true,
          })
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          dish(`safe_side_${index}`, ["lunch", "dinner"], 20, 2, "broccoli", {
            role: "side",
            sideKind: "vegetable",
          })
        ),
      ],
      store: {
        insertMealPlanEntries(entries: readonly unknown[]) {
          storedEntries.push(...entries);
        },
      },
    });

    // Default minimums are recommendations, not gates: one breakfast is
    // workable, so the plan generates with a pool-quality notice instead of
    // refusing a library v1 served.
    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw new Error(result.cannotSatisfy.reason);
    expect(result.pool.breakfasts).toHaveLength(1);
    expect((result.pool.poolNotices ?? []).join(" ")).toContain("below recommended");
    // Floors whose buckets have no carriers at all are waived, not blocking.
    expect((result.waivedFloors ?? []).map((item) => item.bucket).sort()).toEqual([
      "deep_sea_fish",
      "red_meat",
      "shellfish",
    ]);
    expect(result.storedCount).toBe(result.plan.entries.length);
    expect(storedEntries.length).toBe(21);
  });

  test("waives safety-excluded weekly floors instead of blocking an allergic user", () => {
    const storedEntries: unknown[] = [];
    const result = generateMealPlan({
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      presetDishes: weeklyFloorCandidates(),
      preferences: { allergens: ["seafood"] },
      store: {
        insertMealPlanEntries(entries: readonly unknown[]) {
          storedEntries.push(...entries);
        },
      },
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw new Error(result.cannotSatisfy.reason);
    expect(result.waivedFloors).toEqual([
      expect.objectContaining({ bucket: "shellfish", floor: 1 }),
    ]);
    expect(result.overview).toContain("Waived weekly floors");
    expect(result.plan.entries.map((entry) => entry.dish.slug)).not.toContain("unsafe_shellfish");
    expect(result.storedCount).toBe(result.plan.entries.length);
    expect(storedEntries.length).toBeGreaterThan(0);
  });

  test("keeps the legacy single-main reusable fixture compatibility narrow", () => {
    const result = generateMealPlan({
      startDate: "2026-07-06",
      dailyKcalTarget: 1800,
      dailyProteinTarget: 100,
      presetDishes: [
        dish("legacy_breakfast", ["breakfast"], 450, 30, "egg"),
        dish("legacy_single_main", ["lunch", "dinner"], 675, 45, "chicken_breast", {
          role: "main",
          selfContained: true,
        }),
      ],
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw new Error("expected legacy single-main fixture to plan");
    expect(new Set(result.plan.entries.map((entry) => entry.dish.slug))).toEqual(
      new Set(["legacy_breakfast", "legacy_single_main"]),
    );
  });

  test("uses the selected weekly pool as the planner candidate set", () => {
    const breakfast = dish("pool_breakfast", ["breakfast"], 450, 30, "egg");
    const main = dish("pool_main", ["lunch", "dinner"], 675, 45, "chicken_breast");
    const result = generateMealPlan(
      {
        startDate: "2026-07-06",
        dailyKcalTarget: 1800,
        dailyProteinTarget: 100,
        presetDishes: [breakfast, main, dangerousDish("unpooled_candidate")],
      },
      {
        selectWeeklyPool: () => ({
          ok: true,
          pool: { breakfasts: [breakfast], mains: [main], sides: [], all: [breakfast, main] },
        }),
      },
    );

    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw new Error("expected selected pool to plan");
    expect(new Set(result.plan.entries.map((entry) => entry.dish.slug))).toEqual(
      new Set(["pool_breakfast", "pool_main"]),
    );
  });

  test("surfaces pool-time cannotSatisfy through the smart handler without storing a plan", async () => {
    const cannotSatisfy = {
      reason: "Cannot satisfy weekly floor quotas after safety filters: shellfish 0/1",
      suggestions: ["add safe candidates for the missing weekly-floor buckets"],
    };
    const inserted: unknown[] = [];

    const result = await handleSmartGenerateMealPlan(
      smartContext({
        inserted,
        bmrProfile: {
          targetKcal: 1771,
          proteinTargetGrams: 140,
          fatTargetGrams: 42,
          carbsTargetGrams: 208,
        },
      }),
      { startDate: "2026-07-06" },
      { selectWeeklyPool: () => ({ ok: false, cannotSatisfy }) },
    );

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected pool-time block");
    expect(result.cannotSatisfy.reason).toBe(cannotSatisfy.reason);
    expect(result.cannotSatisfy.suggestions).toEqual(cannotSatisfy.suggestions);
    expect(result.overview).toContain(cannotSatisfy.reason);
    expect(result.storedCount).toBe(0);
    expect(inserted).toEqual([]);
  });

  // Scenario tests use the REAL preset dishes classified against the REAL seed
  // catalog - no either/or branches: both scenarios MUST plan.

  test("plans the seafood-allergy default profile with real presets (no seafood, floors waived)", async () => {
    const { catalog, candidates } = await realClassifiedPresets();
    const result = generateMealPlan({
      startDate: "2026-07-06",
      dailyKcalTarget: 1771,
      dailyProteinTarget: 140,
      dailyFatTarget: 42,
      dailyCarbsTarget: 208,
      presetDishes: candidates,
      catalog,
      preferences: { allergens: ["seafood"] },
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw new Error(result.cannotSatisfy.reason);
    const plannedDishes = result.plan.entries.flatMap((entry) =>
      [entry.dish, entry.side].filter((candidate): candidate is RecipeDish => candidate !== undefined)
    );
    expect(plannedDishes.length).toBeGreaterThan(0);
    expect(plannedDishes.every((candidate) => !containsSeafood(candidate))).toBe(true);
    expect((result.waivedFloors ?? []).map((item) => item.bucket).sort()).toEqual([
      "deep_sea_fish",
      "shellfish",
    ]);
  }, 30_000);

  test("plans the default profile with real presets and records wall time on the SUCCESSFUL generation", async () => {
    const { catalog, candidates } = await realClassifiedPresets();
    const startedAt = performance.now();
    const result = generateMealPlan({
      startDate: "2026-07-06",
      dailyKcalTarget: 1771,
      dailyProteinTarget: 140,
      dailyFatTarget: 42,
      dailyCarbsTarget: 208,
      presetDishes: candidates,
      catalog,
    });
    const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;

    const evidenceDir = path.resolve("evidence/CHA-MPV2-3");
    const command = "node_modules/.bin/vitest.CMD run tests/tools/generate-meal-plan-pool.test.ts";
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.join(evidenceDir, "default-profile-generation.json"),
      `${JSON.stringify({
        node: "CHA-MPV2-3",
        command,
        measuredMs: elapsedMs,
        thresholdMs: 5000,
        status: result.status,
        reason: result.status === "blocked" ? result.cannotSatisfy.reason : undefined,
      }, null, 2)}\n`,
      "utf8",
    );

    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw new Error(result.cannotSatisfy.reason);
    expect(result.plan.entries.length).toBe(21);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 30_000);
});

let cachedRealPresets: Promise<{ catalog: MealCatalog; candidates: readonly RecipeDish[] }> | undefined;

function realClassifiedPresets(): Promise<{ catalog: MealCatalog; candidates: readonly RecipeDish[] }> {
  cachedRealPresets ??= (async () => {
    const foods = loadFoodItemsFromCsv(await readFile(path.resolve("seed/ingredients.csv"), "utf8"));
    const catalog: MealCatalog = {
      foods: foods.map((food): FoodCatalogRecord => ({
        slug: food.slug,
        name: food.nameZh ?? food.name,
        nameZh: food.nameZh ?? null,
        aliases: [food.name, ...(food.nameZh ? [food.nameZh] : [])],
        category: food.category ?? null,
        executionBuckets: food.executionBuckets,
        roles: food.roles,
        weeklyFloor: food.weeklyFloor,
        allergenTags: food.allergenTags,
        weightType: food.weightType,
        specialHandlingTags: food.specialHandlingTags,
        defaultGrams: null,
        defaultUnit: null,
        kcalPer100g: food.caloriesKcal,
        proteinGramsPer100g: food.proteinGrams,
        carbsGramsPer100g: food.carbsGrams,
        fatGramsPer100g: food.fatGrams,
        sodiumMgPer100g: food.sodiumMg,
      })),
      naturalUnits: [],
    };
    const candidates = presetDishes.map((dish) => ({ ...dish, ...dishBucketsRoles(dish, catalog) }));
    return { catalog, candidates };
  })();
  return cachedRealPresets;
}

function smartContext(options: {
  inserted: unknown[];
  bmrProfile?: {
    targetKcal: number;
    proteinTargetGrams: number;
    fatTargetGrams: number;
    carbsTargetGrams: number;
  };
}): ToolContext {
  return {
    userId: "user-id",
    locale: "en",
    catalog: { foods: [], naturalUnits: [] },
    seasoningRecords: [],
    repo: {
      getLatestBmrProfile: async () => options.bmrProfile,
      listUserDishes: async () => [],
      listActiveMemories: async () => [],
      listRejectedSeasoningSlugs: async () => [],
      listMealPlanEntriesRange: async () => [],
      listDietLogsRange: async () => [],
      insertMealPlanEntry: async (entry: unknown) => {
        options.inserted.push(entry);
        return entry;
      },
    } as unknown as ToolContext["repo"],
    close: async () => undefined,
  };
}

function defaultProfileCandidates(): readonly RecipeDish[] {
  return [
    dish("egg_oat_breakfast", ["breakfast"], 450, 30, "egg"),
    dish("soy_milk_oat_breakfast", ["breakfast"], 445, 28, "soy_milk"),
    dish("yogurt_sweet_potato_breakfast", ["breakfast"], 455, 29, "yogurt_high_protein"),
    dish("lean_chicken_plate", ["lunch", "dinner"], 660, 47, "chicken_breast", { role: "main", selfContained: true }),
    dish("beef_egg_plate", ["lunch", "dinner"], 655, 46, "beef_tenderloin", { role: "main", selfContained: true }),
    dish("turkey_rice_plate", ["lunch", "dinner"], 650, 45, "turkey", { role: "main", selfContained: true }),
    dish("tofu_chicken_plate", ["lunch", "dinner"], 645, 44, "tofu", { role: "main", selfContained: true }),
    dish("pork_egg_plate", ["lunch", "dinner"], 640, 43, "pork", { role: "main", selfContained: true }),
    dish("shrimp_power_plate", ["lunch", "dinner"], 670, 60, "shrimp_jiweixia", {
      role: "main",
      selfContained: true,
      allergenTags: ["seafood", "shellfish", "shrimp"],
    }),
    { ...dish("oyster_sauce_beef", ["lunch", "dinner"], 650, 46, "beef_tenderloin", { role: "main", selfContained: true }), seasonings: ["oyster_sauce"] },
    dish("garlic_broccoli_side", ["lunch", "dinner"], 20, 2, "broccoli", { role: "side", sideKind: "vegetable" }),
    dish("bok_choy_side", ["lunch", "dinner"], 20, 2, "bok_choy", { role: "side", sideKind: "vegetable" }),
    dish("spinach_soup_side", ["lunch", "dinner"], 20, 2, "spinach", { role: "side", sideKind: "soup" }),
  ];
}

function weeklyFloorCandidates(): readonly RecipeDish[] {
  return [
    dish("floor_breakfast_1", ["breakfast"], 450, 30, "egg"),
    dish("floor_breakfast_2", ["breakfast"], 450, 30, "soy_milk"),
    dish("floor_breakfast_3", ["breakfast"], 450, 30, "yogurt_high_protein"),
    dish("red_meat_1", ["lunch", "dinner"], 675, 45, "beef_tenderloin", {
      role: "main",
      selfContained: true,
      buckets: ["red_meat"],
    }),
    dish("red_meat_2", ["lunch", "dinner"], 675, 45, "beef_tenderloin", {
      role: "main",
      selfContained: true,
      buckets: ["red_meat"],
    }),
    dish("safe_deep_bucket_1", ["lunch", "dinner"], 675, 45, "chicken_breast", {
      role: "main",
      selfContained: true,
      buckets: ["deep_sea_fish"],
    }),
    dish("safe_deep_bucket_2", ["lunch", "dinner"], 675, 45, "chicken_breast", {
      role: "main",
      selfContained: true,
      buckets: ["deep_sea_fish"],
    }),
    dish("neutral_main", ["lunch", "dinner"], 675, 45, "tofu", {
      role: "main",
      selfContained: true,
    }),
    dish("unsafe_shellfish", ["lunch", "dinner"], 675, 50, "shrimp_jiweixia", {
      role: "main",
      selfContained: true,
      buckets: ["shellfish"],
      allergenTags: ["seafood", "shellfish", "shrimp"],
    }),
    dish("floor_side_1", ["lunch", "dinner"], 20, 2, "broccoli", { role: "side", sideKind: "vegetable" }),
    dish("floor_side_2", ["lunch", "dinner"], 20, 2, "bok_choy", { role: "side", sideKind: "vegetable" }),
    dish("floor_side_3", ["lunch", "dinner"], 20, 2, "spinach", { role: "side", sideKind: "soup" }),
  ];
}

function dish(
  slug: string,
  mealTypes: RecipeDish["mealTypes"],
  kcal: number,
  proteinGrams: number,
  ingredientSlug: string,
  options: Partial<RecipeDish> = {},
): RecipeDish {
  return {
    slug,
    name: slug,
    mealTypes,
    nutrition: {
      kcal,
      proteinGrams,
      carbsGrams: Math.round(kcal / 7),
      fatGrams: Math.round(kcal / 32),
      sodiumMg: 300,
    },
    ingredients: [{ slug: ingredientSlug, grams: 150 }],
    seasonings: [],
    source: "preset",
    ...options,
  };
}

function dangerousDish(slug: string): RecipeDish {
  const candidate = { slug, name: slug, source: "preset" } as Partial<RecipeDish>;
  for (const field of ["mealTypes", "nutrition", "ingredients", "seasonings"] as const) {
    Object.defineProperty(candidate, field, {
      get() {
        throw new Error(`${slug} entered meal-plan generation through ${field}`);
      },
    });
  }
  return candidate as RecipeDish;
}

function containsSeafood(dish: RecipeDish): boolean {
  return dish.ingredients.some((ingredient) => /shrimp|fish|bream|cod|hairtail|sea/i.test(ingredient.slug)) ||
    dish.seasonings.some((seasoning) => /oyster|fish|shrimp/i.test(seasoning)) ||
    (dish.allergenTags ?? []).some((tag) => ["seafood", "fish", "shellfish", "shrimp"].includes(tag));
}
