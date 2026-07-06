import { describe, expect, test } from "vitest";

import { handleMealCheckin, handleSwapMeal } from "../../src/tools/handlers.js";
import type { MealPlanEntryRow } from "../../src/db/repository.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { FoodCatalogRecord, MealCatalog } from "../../src/tools/nutrition-estimate.js";

describe("handleSwapMeal (V2-P5)", () => {
  test("swaps the lunch main, re-levers the day, keeps a side for a non-self-contained alternate", async () => {
    const updates: { entryId: string; data: Record<string, unknown> }[] = [];
    const ctx = context({ updates });

    const result = await handleSwapMeal(ctx, {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "chaoshan_beef_soup",
    });

    expect(result.entryId).toBe("row-lunch");
    expect(result.previousDishSlug).toBe("chicken_carrot_rice");
    expect(result.newDish.slug).toBe("chaoshan_beef_soup");
    expect(result.withinEnergyBand).toBe(true);
    expect(result.meetsProteinFloor).toBe(true);
    // chaoshan_beef_soup is not self-contained: a vegetable side rides along.
    expect(result.sideSlug).toBeDefined();
    expect(result.stapleGrams).toBeDefined();
    expect((result.stapleGrams ?? 0) % 30).toBe(0);

    expect(updates).toHaveLength(1);
    const update = updates[0];
    expect(update?.entryId).toBe("row-lunch");
    expect(update?.data["recipeSlug"]).toBe("chaoshan_beef_soup");
    const ingredientSlugs = (update?.data["ingredientsJson"] as { slug: string }[]).map((item) => item.slug);
    expect(ingredientSlugs).toContain("beef_tenderloin");
    expect(ingredientSlugs).toContain("brown_rice");
    expect(ingredientSlugs).toContain("broccoli");
  });

  test("refuses alternates that conflict with saved exclusions (safety boundary)", async () => {
    const ctx = context({ updates: [], rejectedSeasonings: ["ginger"] });
    // chaoshan_beef_soup carries the ginger seasoning tag.
    await expect(handleSwapMeal(ctx, {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "chaoshan_beef_soup",
    })).rejects.toThrow("conflicts with saved allergies or exclusions");
  });

  test("refuses swaps that would break the day instead of persisting them", async () => {
    // The rest of the day is already so heavy that no lever can keep the
    // day inside the hard band after adding another main.
    const updates: { entryId: string; data: Record<string, unknown> }[] = [];
    const ctx = context({
      updates,
      rows: [
        row("row-breakfast", "breakfast", 950, 40),
        row("row-lunch", "lunch", 520, 32),
        row("row-dinner", "dinner", 950, 45),
      ],
    });

    await expect(handleSwapMeal(ctx, {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "black_pepper_chicken_breast",
    })).rejects.toThrow("would break the day");
    expect(updates).toEqual([]);
  });

  test("rejects days with duplicate planned entries and advises regeneration", async () => {
    const ctx = context({
      updates: [],
      rows: [
        row("row-breakfast", "breakfast", 450, 28),
        row("row-lunch-a", "lunch", 520, 32),
        row("row-lunch-b", "lunch", 540, 30),
        row("row-dinner", "dinner", 560, 35),
      ],
    });
    await expect(handleSwapMeal(ctx, {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "chaoshan_beef_soup",
    })).rejects.toThrow("regenerate the plan");
  });

  test("rejects unknown alternate dishes", async () => {
    await expect(handleSwapMeal(context({ updates: [] }), {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "not_a_dish",
    })).rejects.toThrow("unknown alternate main dish");
  });

  test("rejects dates without a planned entry for the meal type", async () => {
    await expect(handleSwapMeal(context({ updates: [] }), {
      date: "2026-07-09",
      mealType: "dinner",
      alternateSlug: "chaoshan_beef_soup",
    })).rejects.toThrow("no planned dinner meal-plan entry");
  });

  test("rejects breakfast swaps", async () => {
    await expect(handleSwapMeal(context({ updates: [] }), {
      date: "2026-07-08",
      mealType: "breakfast",
      alternateSlug: "chaoshan_beef_soup",
    })).rejects.toThrow("lunch or dinner");
  });
});

describe("handleSwapMeal bounded semantics (CHA-MPV2-8: alternates-only)", () => {
  test("rejects a safe, collision-free, lever-valid main that is NOT in the week's selected pool (A2)", async () => {
    // black_pepper_chicken_breast is a real catalog main and lever-valid on
    // the light default day, but the lean-tilt weekly pool (7 mains) does not
    // select it — pool membership, not day validity, must gate the swap.
    const updates: { entryId: string; data: Record<string, unknown> }[] = [];
    const ctx = context({ updates });

    await expect(handleSwapMeal(ctx, {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "black_pepper_chicken_breast",
    })).rejects.toThrow(/not one of this entry's pre-vetted alternates: it is outside this week's selected pool/);
    expect(updates).toEqual([]);
  });

  test("rejects a dish skipped >=2 times even when otherwise valid (A2)", async () => {
    const updates: { entryId: string; data: Record<string, unknown> }[] = [];
    const ctx = context({
      updates,
      rangeRows: [
        // Two skipped check-ins inside the W2 lookback window make
        // chaoshan_beef_soup an avoidedDishSlugs signal; selectWeeklyPool
        // excludes it from the pool, so the swap must reject it.
        { ...row("skip-1", "lunch", 520, 32), planDate: "2026-07-02", recipeSlug: "chaoshan_beef_soup", status: "skipped" },
        { ...row("skip-2", "lunch", 520, 32), planDate: "2026-07-04", recipeSlug: "chaoshan_beef_soup", status: "skipped" },
      ],
    });

    await expect(handleSwapMeal(ctx, {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "chaoshan_beef_soup",
    })).rejects.toThrow(/skipped twice or more recently and is excluded from this week's pool/);
    expect(updates).toEqual([]);
  });

  test("rejects a target already planned on an adjacent day (not a pre-vetted alternate)", async () => {
    const updates: { entryId: string; data: Record<string, unknown> }[] = [];
    const ctx = context({
      updates,
      rangeRows: [
        { ...row("row-next-lunch", "lunch", 520, 32), planDate: "2026-07-09", recipeSlug: "chaoshan_beef_soup" },
      ],
    });

    await expect(handleSwapMeal(ctx, {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "chaoshan_beef_soup",
    })).rejects.toThrow("not one of this entry's pre-vetted alternates");
    expect(updates).toEqual([]);
  });

  test("rejects a target already planned the same day", async () => {
    const rows = [
      row("row-breakfast", "breakfast", 450, 28),
      row("row-lunch", "lunch", 520, 32),
      { ...row("row-dinner", "dinner", 560, 35), recipeSlug: "chaoshan_beef_soup" },
    ];
    const updates: { entryId: string; data: Record<string, unknown> }[] = [];

    await expect(handleSwapMeal(context({ updates, rows }), {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "chaoshan_beef_soup",
    })).rejects.toThrow(/pre-vetted alternates.*already planned on 2026-07-08/);
    expect(updates).toEqual([]);
  });

  test("rejects a target at a higher weekly use count when a less-used alternate exists", async () => {
    const updates: { entryId: string; data: Record<string, unknown> }[] = [];
    const ctx = context({
      updates,
      rangeRows: [
        // chaoshan_beef_soup already served two days ago: use count 1 in the
        // surrounding week, while other lever-valid mains sit at 0.
        { ...row("row-past-lunch", "lunch", 520, 32), planDate: "2026-07-06", recipeSlug: "chaoshan_beef_soup" },
      ],
    });

    await expect(handleSwapMeal(ctx, {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "chaoshan_beef_soup",
    })).rejects.toThrow(/less-used alternates exist — currently pre-vetted:/);
    expect(updates).toEqual([]);
  });

  test("swap round-trips through the repository layer and meal_checkin attaches to the swapped entry", async () => {
    const updates: { entryId: string; data: Record<string, unknown> }[] = [];
    const statusUpdates: { entryId: string; status: string }[] = [];
    const ctx = context({ updates, statusUpdates, mutateRowsOnUpdate: true });

    const swap = await handleSwapMeal(ctx, {
      date: "2026-07-08",
      mealType: "lunch",
      alternateSlug: "chaoshan_beef_soup",
    });
    expect(swap.entryId).toBe("row-lunch");
    expect(updates.some((update) => update.entryId === "row-lunch")).toBe(true);

    const checkin = await handleMealCheckin(ctx, {
      date: "2026-07-08",
      mealType: "lunch",
      status: "followed",
    });
    expect(checkin.entryId).toBe("row-lunch");
    expect(checkin.dietLogId).toBe("diet-log-1");
    expect(statusUpdates).toEqual([{ entryId: "row-lunch", status: "followed" }]);
    // The check-in logged the SWAPPED dish, not the original one.
    const lunchUpdate = updates.find((update) => update.entryId === "row-lunch");
    expect(String(lunchUpdate?.data["dishName"])).toContain(String(swap.newDish.name));
  });
});

function row(id: string, mealType: string, kcal: number, proteinGrams: number): MealPlanEntryRow {
  return {
    id,
    userId: "user-id",
    planDate: "2026-07-08",
    mealType,
    dishName: mealType,
    recipeSlug: mealType === "lunch" ? "chicken_carrot_rice" : `${mealType}_dish`,
    status: "planned",
    ingredientsJson: [],
    seasoningsJson: [],
    caloriesKcal: kcal,
    proteinGrams,
    carbsGrams: 50,
    fatGrams: 15,
    sodiumMg: 500,
  };
}

function context(options: {
  updates: { entryId: string; data: Record<string, unknown> }[];
  rows?: MealPlanEntryRow[];
  rangeRows?: MealPlanEntryRow[];
  rejectedSeasonings?: string[];
  statusUpdates?: { entryId: string; status: string }[];
  mutateRowsOnUpdate?: boolean;
}): ToolContext {
  const rows = options.rows ?? [
    row("row-breakfast", "breakfast", 450, 28),
    row("row-lunch", "lunch", 520, 32),
    row("row-dinner", "dinner", 560, 35),
  ];
  return {
    userId: "user-id",
    locale: "en",
    catalog: CATALOG,
    seasoningRecords: [],
    repo: {
      getLatestBmrProfile: async () => ({
        targetKcal: 1771,
        proteinTargetGrams: 140,
        fatTargetGrams: 49,
        carbsTargetGrams: 192,
      }),
      listUserDishes: async () => [],
      listActiveMemories: async () => [],
      listRejectedSeasoningSlugs: async () => options.rejectedSeasonings ?? [],
      listMealPlanEntriesRange: async (_userId: string, startDate: string, endDate: string) =>
        (options.rangeRows ?? []).filter((item) => item.planDate >= startDate && item.planDate <= endDate),
      listDietLogsRange: async () => [],
      listMealPlanEntries: async (_userId: string, date?: string) =>
        rows.filter((item) => item.planDate === date),
      updateMealPlanEntryDish: async (entryId: string, data: Record<string, unknown>) => {
        options.updates.push({ entryId, data });
        if (options.mutateRowsOnUpdate === true) {
          const stored = rows.find((item) => item.id === entryId);
          if (stored !== undefined) Object.assign(stored, data);
        }
      },
      updateMealPlanStatus: async (entryId: string, status: string) => {
        options.statusUpdates?.push({ entryId, status });
      },
      insertDietLog: async () => ({ id: "diet-log-1" }),
    } as unknown as ToolContext["repo"],
    close: async () => undefined,
  };
}

const CATALOG: MealCatalog = {
  foods: [
    record("beef_tenderloin", 107, 22.2, 2.4, 0.9, 75.1),
    record("scallion", 32, 1.8, 7.3, 0.2, 16),
    record("chicken_breast", 118, 19.4, 2.5, 5, 34.4),
    record("onion", 40, 1.1, 9.3, 0.1, 4),
    record("egg", 139, 13.1, 2.4, 8.6, 131.5),
    record("tofu", 84, 6.6, 3.4, 5.3, 5.6),
    record("soy_milk", 33, 3, 1.8, 1.6, 3),
    record("yogurt_high_protein", 63, 11, 4.5, 0, 38),
    record("brown_rice", 348, 7.7, 75, 2.7, 5.4),
    record("broccoli", 27, 3.5, 3.7, 0.6, 46.7),
    record("bok_choy", 14, 1.4, 2.4, 0.3, 132.2),
    record("shiitake_fresh", 26, 2.2, 5.2, 0.3, 1.4),
    record("olive_oil", 884, 0, 0, 99.9, 2),
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
