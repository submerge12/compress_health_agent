import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { createDisplayServer } from "../../src/server/display-server.js";
import type { MealPlanEntryRow } from "../../src/db/repository.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { FoodCatalogRecord, MealCatalog } from "../../src/tools/nutrition-estimate.js";

describe("display server (P1 contract)", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function boot(ctx: ToolContext, options: Parameters<typeof createDisplayServer>[1] = {}): Promise<string> {
    server = createDisplayServer(ctx, options);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server?.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  test("GET /api/health reports liveness and the bound user", async () => {
    const base = await boot(context({}));
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, userId: "user-id" });
  });

  test("bearer token gates every /api route when configured", async () => {
    const base = await boot(context({}), { bearerToken: "secret" });
    const denied = await fetch(`${base}/api/health`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${base}/api/health`, {
      headers: { Authorization: "Bearer secret" },
    });
    expect(allowed.status).toBe(200);
  });

  test("OPTIONS preflight answers 204 with CORS headers for the configured origin", async () => {
    const base = await boot(context({}), { corsOrigin: "http://localhost:5500" });
    const response = await fetch(`${base}/api/plan`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5500");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  test("GET /api/plan groups stored rows by date across the window", async () => {
    const base = await boot(context({}));
    const response = await fetch(`${base}/api/plan?start=2026-07-08&days=2`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.startDate).toBe("2026-07-08");
    expect(payload.days).toHaveLength(2);
    expect(payload.days[0].date).toBe("2026-07-08");
    expect(payload.days[0].entries.map((entry: MealPlanEntryRow) => entry.mealType))
      .toEqual(["breakfast", "lunch", "dinner"]);
    expect(payload.days[1].entries).toEqual([]);
  });

  test("GET /api/plan without a start date is a 400 with a usable message", async () => {
    const base = await boot(context({}));
    const response = await fetch(`${base}/api/plan`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("start");
  });

  test("POST /api/swap round-trips through handleSwapMeal", async () => {
    const updates: unknown[] = [];
    const base = await boot(context({ updates }));
    const response = await fetch(`${base}/api/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-07-08", mealType: "lunch", alternateSlug: "chaoshan_beef_soup" }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.newDish.slug).toBe("chaoshan_beef_soup");
    expect(payload.meetsProteinFloor).toBe(true);
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  test("a refused swap surfaces as 400 with the refusal copy", async () => {
    const base = await boot(context({
      rows: [
        row("row-breakfast", "breakfast", 950, 40),
        row("row-lunch", "lunch", 520, 32),
        row("row-dinner", "dinner", 950, 45),
      ],
    }));
    const response = await fetch(`${base}/api/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-07-08", mealType: "lunch", alternateSlug: "black_pepper_chicken_breast" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("would break the day");
  });

  test("POST /api/checkin attaches to the plan row and logs the meal", async () => {
    const statusUpdates: { entryId: string; status: string }[] = [];
    const base = await boot(context({ statusUpdates }));
    const response = await fetch(`${base}/api/checkin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-07-08", mealType: "lunch", status: "followed" }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entryId).toBe("row-lunch");
    expect(payload.dietLogId).toBe("diet-log-1");
    expect(statusUpdates).toEqual([{ entryId: "row-lunch", status: "followed" }]);
  });

  test("unknown routes are 404 and malformed JSON bodies are 400", async () => {
    const base = await boot(context({}));
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    const bad = await fetch(`${base}/api/swap`, { method: "POST", body: "not json{" });
    expect(bad.status).toBe(400);
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
  rows?: MealPlanEntryRow[];
  updates?: unknown[];
  statusUpdates?: { entryId: string; status: string }[];
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
      listRejectedSeasoningSlugs: async () => [],
      listMealPlanEntriesRange: async (_userId: string, startDate: string, endDate: string) =>
        rows.filter((item) => item.planDate >= startDate && item.planDate <= endDate),
      listDietLogsRange: async () => [],
      listMealPlanEntries: async (_userId: string, date?: string) =>
        rows.filter((item) => item.planDate === date),
      updateMealPlanEntryDish: async (entryId: string, data: Record<string, unknown>) => {
        options.updates?.push({ entryId, data });
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
