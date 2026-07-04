import { describe, expect, test } from "vitest";

import { presetDishes } from "../../src/data/preset-dishes.js";
import type { DietLogRow, MealPlanEntryRow, MemoryKind, MemoryRecordRow, UserDishRow } from "../../src/db/repository.js";
import type { FoodCatalogRecord } from "../../src/tools/nutrition-estimate.js";
import type { ToolContext } from "../../src/tools/context.js";
import { loadCandidateDishes, loadUserPreferences } from "../../src/tools/candidate-loader.js";

function userDish(overrides: Partial<UserDishRow>): UserDishRow {
  return {
    id: "dish-id",
    userId: "user-id",
    slug: "user_beef_bowl",
    name: "User beef bowl",
    mealCategory: "main",
    ingredientsJson: [{ slug: "beef_tenderloin", grams: 150 }],
    seasoningsJson: [{ slug: "light_soy_sauce" }],
    method: "stir_fry",
    role: "main",
    sideKind: null,
    selfContained: true,
    caloriesKcal: 680,
    proteinGrams: 42,
    carbsGrams: 62,
    fatGrams: 20,
    sodiumMg: 640,
    source: "user",
    ...overrides,
  };
}

function makeContext(userDishes: UserDishRow[]): ToolContext {
  return {
    userId: "user-id",
    locale: "zh",
    catalog: { foods: [], naturalUnits: [] },
    seasoningRecords: [],
    repo: {
      listUserDishes: async (userId: string) => {
        expect(userId).toBe("user-id");
        return userDishes;
      },
      listCookingRecords: async () => {
        throw new Error("loadCandidateDishes must not read cooking_records");
      },
    } as unknown as ToolContext["repo"],
    close: async () => undefined,
  };
}

function makeClassifiedContext(userDishes: UserDishRow[]): ToolContext {
  return {
    ...makeContext(userDishes),
    catalog: {
      foods: [
        food("shrimp_jiweixia", [], {
          executionBuckets: ["shellfish"],
          roles: ["b12"],
          weeklyFloor: 1,
          allergenTags: ["seafood", "shellfish", "shrimp"],
        }),
        food("konjac", [], {
          executionBuckets: ["filler"],
          specialHandlingTags: ["filler", "not_vegetable"],
        }),
      ],
      naturalUnits: [],
    },
  };
}

describe("loadCandidateDishes", () => {
  test("returns exactly the curated presets when user_dishes is empty", async () => {
    const candidates = await loadCandidateDishes(makeContext([]));

    expect(candidates).toHaveLength(presetDishes.length);
    expect(candidates.map((dish) => dish.slug)).toEqual(presetDishes.map((dish) => dish.slug));
    expect(candidates[0]).toMatchObject(presetDishes[0]!);
    expect(candidates[0]).toMatchObject({ buckets: [], roles: [], weeklyFloors: {} });
  });

  test("maps user_dishes meal_category to planner mealTypes", async () => {
    const candidates = await loadCandidateDishes(makeContext([
      userDish({ mealCategory: "main" }),
      userDish({
        id: "breakfast-id",
        slug: "user_oat_bowl",
        name: "User oat bowl",
        mealCategory: "breakfast",
        caloriesKcal: 430,
        proteinGrams: 24,
      }),
    ]));

    expect(candidates.find((dish) => dish.slug === "user_beef_bowl")).toMatchObject({
      mealTypes: ["lunch", "dinner"],
      source: "user",
    });
    expect(candidates.find((dish) => dish.slug === "user_oat_bowl")).toMatchObject({
      mealTypes: ["breakfast"],
      source: "user",
    });
  });

  test("maps user side dishes to side candidates", async () => {
    const candidates = await loadCandidateDishes(makeContext([
      userDish({
        slug: "user_broccoli_side",
        name: "User broccoli side",
        role: "side",
        sideKind: "vegetable",
        selfContained: false,
        ingredientsJson: [{ slug: "broccoli", grams: 100 }],
        caloriesKcal: 35,
        proteinGrams: 2.4,
        carbsGrams: 7.2,
        fatGrams: 0.4,
        sodiumMg: 41,
      }),
    ]));

    expect(candidates.find((dish) => dish.slug === "user_broccoli_side")).toMatchObject({
      mealTypes: ["lunch", "dinner"],
      role: "side",
      sideKind: "vegetable",
      source: "user",
    });
  });

  test("dedupes user_dishes by preset slug and filters invalid nutrition", async () => {
    const candidates = await loadCandidateDishes(makeContext([
      userDish({ slug: presetDishes[0]!.slug, name: "Duplicate preset" }),
      userDish({ slug: "zero_kcal", name: "Zero kcal", caloriesKcal: 0 }),
      userDish({ slug: "valid_extra", name: "Valid extra" }),
    ]));

    expect(candidates.map((dish) => dish.slug)).not.toContain("zero_kcal");
    expect(candidates.filter((dish) => dish.slug === presetDishes[0]!.slug)).toHaveLength(1);
    expect(candidates.map((dish) => dish.slug)).toContain("valid_extra");
  });

  test("derives allergen and special handling tags for loaded candidates", async () => {
    const candidates = await loadCandidateDishes(makeClassifiedContext([
      userDish({
        slug: "user_konjac_shrimp",
        name: "User konjac shrimp",
        ingredientsJson: [
          { slug: "shrimp_jiweixia", grams: 80 },
          { slug: "konjac", grams: 120 },
        ],
      }),
    ]));

    expect(candidates.find((dish) => dish.slug === "user_konjac_shrimp")).toMatchObject({
      buckets: ["filler", "shellfish"],
      roles: ["b12"],
      weeklyFloors: { shellfish: 1 },
      allergenTags: ["seafood", "shellfish", "shrimp", "soy"],
      specialHandlingTags: ["filler", "not_vegetable"],
    });
  });
});

function food(
  slug: string,
  aliases: string[] = [],
  overrides: Partial<FoodCatalogRecord> = {},
): FoodCatalogRecord {
  return {
    slug,
    name: slug,
    executionBuckets: [],
    roles: [],
    weeklyFloor: 0,
    aliases,
    defaultGrams: null,
    defaultUnit: null,
    kcalPer100g: 100,
    proteinGramsPer100g: 10,
    carbsGramsPer100g: 10,
    fatGramsPer100g: 5,
    sodiumMgPer100g: 50,
    ...overrides,
  };
}

function dislike(subject: string): MemoryRecordRow {
  return {
    id: `mem-${subject}`,
    userId: "user-id",
    kind: "dislike" as MemoryKind,
    subject,
    content: `dislikes ${subject}`,
    contentNorm: subject,
    sourceText: null,
    confidence: 1,
    status: "active",
    supersededBy: null,
    validFrom: new Date(),
    validTo: null,
    lastConfirmedAt: null,
    timesReferenced: 0,
  };
}

function preference(subject: string): MemoryRecordRow {
  return { ...dislike(subject), id: `pref-${subject}`, kind: "preference" as MemoryKind };
}

function makePreferenceContext(opts: {
  dislikes?: MemoryRecordRow[];
  likes?: MemoryRecordRow[];
  tableRejected?: string[];
  planEntries?: MealPlanEntryRow[];
  dietLogs?: DietLogRow[];
}): ToolContext {
  return {
    userId: "user-id",
    locale: "zh",
    catalog: { foods: [food("mushroom", ["蘑菇"]), food("beef"), food("chicken_breast")], naturalUnits: [] },
    seasoningRecords: [],
    seasoningCatalog: [{ slug: "light_soy_sauce", name: "生抽" }],
    repo: {
      listActiveMemories: async (userId: string, kinds?: readonly MemoryKind[]) => {
        expect(userId).toBe("user-id");
        if (kinds?.includes("preference")) return opts.likes ?? [];
        return opts.dislikes ?? [];
      },
      listRejectedSeasoningSlugs: async () => opts.tableRejected ?? [],
      listMealPlanEntriesRange: async () => opts.planEntries ?? [],
      listDietLogsRange: async () => opts.dietLogs ?? [],
    } as unknown as ToolContext["repo"],
    close: async () => undefined,
  };
}

describe("loadUserPreferences", () => {
  test("resolves disliked foods to rejected ingredients and seasonings to rejected seasonings", async () => {
    const prefs = await loadUserPreferences(makePreferenceContext({
      dislikes: [dislike("mushroom"), dislike("生抽")],
    }));

    expect(prefs.rejectedIngredients).toContain("mushroom");
    expect(prefs.rejectedSeasonings).toContain("light_soy_sauce");
  });

  test("resolves liked foods to preferred ingredients", async () => {
    const prefs = await loadUserPreferences(makePreferenceContext({
      likes: [preference("chicken_breast")],
    }));

    expect(prefs.preferredIngredients).toContain("chicken_breast");
  });

  test("resolves liked cooking methods to preferred methods", async () => {
    const prefs = await loadUserPreferences(makePreferenceContext({
      likes: [preference("stir fry")],
    }));

    expect(prefs.preferredMethods).toContain("stir_fry");
  });

  test("resolves liked seasonings to preferred seasonings", async () => {
    const prefs = await loadUserPreferences(makePreferenceContext({
      likes: [preference("light_soy_sauce")],
    }));

    expect(prefs.preferredSeasonings).toContain("light_soy_sauce");
  });

  test("resolves disliked allergen groups without adding a new memory kind", async () => {
    const prefs = await loadUserPreferences(makePreferenceContext({
      dislikes: [dislike("seafood"), dislike("lactose intolerance"), dislike("nuts")],
    }));

    expect(prefs.allergens).toEqual(expect.arrayContaining(["seafood", "dairy", "nuts"]));
    expect(prefs.rejectedIngredients).toEqual([]);
  });

  test("does not promote unresolved specific sauce dislikes into allergen groups", async () => {
    const prefs = await loadUserPreferences(makePreferenceContext({
      dislikes: [dislike("soy sauce")],
    }));

    expect(prefs.allergens).toEqual([]);
  });

  test("unions table-stored rejected seasonings and ignores unresolvable dislikes", async () => {
    const prefs = await loadUserPreferences(makePreferenceContext({
      dislikes: [dislike("a_food_not_in_any_catalog")],
      tableRejected: ["chili_oil"],
    }));

    expect(prefs.rejectedSeasonings).toContain("chili_oil");
    expect(prefs.rejectedIngredients).toEqual([]);
  });

  test("returns empty preferences when there are no memories", async () => {
    const prefs = await loadUserPreferences(makePreferenceContext({}));

    expect(prefs.rejectedSeasonings).toEqual([]);
    expect(prefs.rejectedIngredients).toEqual([]);
    expect(prefs.preferredIngredients).toEqual([]);
  });

  test("mines recent check-ins into preference and recency planning signals", async () => {
    const prefs = await loadUserPreferences(makePreferenceContext({
      planEntries: [
        mealPlanEntry({ id: "skip-1", planDate: "2026-07-02", recipeSlug: "boiled_chicken", status: "skipped" }),
        mealPlanEntry({ id: "skip-2", planDate: "2026-07-04", recipeSlug: "boiled_chicken", status: "skipped" }),
        mealPlanEntry({ id: "followed-1", planDate: "2026-07-05", recipeSlug: "scallion_beef", status: "followed" }),
        mealPlanEntry({ id: "old-1", planDate: "2026-06-20", recipeSlug: "old_dish", status: "followed" }),
      ],
      dietLogs: [
        dietLog({
          id: "subst-1",
          logDate: "2026-07-06",
          source: "substituted",
          ingredientsJson: [{ slug: "chicken_breast", grams: 180 }],
        }),
        dietLog({
          id: "planned-1",
          logDate: "2026-07-06",
          source: "planned",
          ingredientsJson: [{ slug: "mushroom", grams: 100 }],
        }),
        dietLog({
          id: "fallback-1",
          logDate: "2026-07-06",
          source: "substituted",
          ingredientsJson: [{
            slug: "unknown_food",
            grams: 200,
            estimateSource: "fallback",
            segment: "mystery food 200g",
          }],
        }),
      ],
    }), { asOfDate: "2026-07-08" });

    expect(prefs.recentDishSlugs).toEqual(expect.arrayContaining(["boiled_chicken", "scallion_beef"]));
    expect(prefs.recentDishSlugs).not.toContain("old_dish");
    expect(prefs.avoidedDishSlugs).toEqual(["boiled_chicken"]);
    expect(prefs.preferredIngredients).toContain("chicken_breast");
    expect(prefs.preferredIngredients).not.toContain("mushroom");
    expect(prefs.preferredIngredients).not.toContain("unknown_food");
  });
});

function mealPlanEntry(overrides: Partial<MealPlanEntryRow>): MealPlanEntryRow {
  return {
    id: "entry-id",
    userId: "user-id",
    planDate: "2026-07-01",
    mealType: "lunch",
    dishName: "Dish",
    recipeSlug: "dish_slug",
    status: "planned",
    ingredientsJson: [],
    seasoningsJson: [],
    caloriesKcal: 500,
    proteinGrams: 30,
    carbsGrams: 50,
    fatGrams: 10,
    sodiumMg: 400,
    ...overrides,
  };
}

function dietLog(overrides: Partial<DietLogRow>): DietLogRow {
  return {
    id: "diet-log-id",
    userId: "user-id",
    logDate: "2026-07-01",
    mealType: "lunch",
    description: "meal",
    source: "planned",
    ingredientsJson: [],
    seasoningsJson: [],
    caloriesKcal: 500,
    proteinGrams: 30,
    carbsGrams: 50,
    fatGrams: 10,
    sodiumMg: 400,
    ...overrides,
  };
}
