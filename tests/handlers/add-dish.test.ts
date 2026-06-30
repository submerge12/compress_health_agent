import { describe, expect, test } from "vitest";

import type { UserDishRow } from "../../src/db/repository.js";
import type { ToolContext } from "../../src/tools/context.js";
import { handleProposeDish, handleSaveDish } from "../../src/tools/handlers.js";

function makeContext() {
  const saved: unknown[] = [];
  const ctx: ToolContext = {
    userId: "user-id",
    locale: "zh",
    catalog: {
      foods: [
        {
          slug: "beef_tenderloin",
          name: "Beef tenderloin",
          aliases: ["beef"],
          executionBuckets: ["red_meat"],
          roles: ["iron", "zinc", "b12"],
          weeklyFloor: 2,
          defaultGrams: null,
          defaultUnit: null,
          kcalPer100g: 107,
          proteinGramsPer100g: 22.2,
          carbsGramsPer100g: 2.4,
          fatGramsPer100g: 0.9,
          sodiumMgPer100g: 75,
        },
        {
          slug: "broccoli",
          name: "Broccoli",
          aliases: ["broccoli"],
          category: "vegetable",
          executionBuckets: ["vegetable"],
          roles: [],
          weeklyFloor: 0,
          defaultGrams: null,
          defaultUnit: null,
          kcalPer100g: 35,
          proteinGramsPer100g: 2.4,
          carbsGramsPer100g: 7.2,
          fatGramsPer100g: 0.4,
          sodiumMgPer100g: 41,
        },
      ],
      naturalUnits: [],
    },
    seasoningRecords: [],
    repo: {
      upsertUserDish: async (row: Omit<UserDishRow, "id">) => {
        saved.push(row);
        return { id: "dish-id", ...row };
      },
    } as unknown as ToolContext["repo"],
    close: async () => undefined,
  };
  return { ctx, saved };
}

describe("add-dish handlers", () => {
  test("handleProposeDish returns a reviewed dish and performs no write", async () => {
    const { ctx, saved } = makeContext();

    const result = await handleProposeDish(ctx, {
      draft: {
        name: "Onion beef",
        mealCategory: "main",
        ingredients: [{ name: "beef", grams: 200 }],
        seasonings: [],
        source: "user_nl",
      },
    });

    expect(saved).toEqual([]);
    expect(result).toMatchObject({
      slug: "onion_beef",
      ingredients: [{ slug: "beef_tenderloin", grams: 200 }],
      buckets: ["red_meat"],
      unresolved: [],
    });
  });

  test("handleProposeDish tolerates a draft with no seasonings", async () => {
    const { ctx, saved } = makeContext();

    const result = await handleProposeDish(ctx, {
      draft: {
        name: "Plain beef",
        mealCategory: "main",
        ingredients: [{ name: "beef", grams: 180 }],
        source: "user_nl",
        // seasonings intentionally omitted
      },
    });

    expect(saved).toEqual([]);
    expect(result).toMatchObject({ slug: "plain_beef", seasonings: [] });
  });

  test("handleSaveDish persists an approved resolved dish", async () => {
    const { ctx, saved } = makeContext();
    const resolved = await handleProposeDish(ctx, {
      draft: {
        name: "Onion beef",
        mealCategory: "main",
        ingredients: [{ name: "beef", grams: 200 }],
        seasonings: [],
        source: "user_nl",
      },
    });

    const result = await handleSaveDish(ctx, resolved);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      userId: "user-id",
      slug: "onion_beef",
      caloriesKcal: 214,
      proteinGrams: 44.4,
    });
    expect(result.dish).toMatchObject({ id: "dish-id", slug: "onion_beef" });
  });

  test("handleSaveDish accepts a pi-harness-shaped main payload without role fields", async () => {
    const { ctx, saved } = makeContext();
    const resolved = await handleProposeDish(ctx, {
      draft: {
        name: "Onion beef",
        mealCategory: "main",
        ingredients: [{ name: "beef", grams: 200 }],
        seasonings: [],
        source: "user_nl",
      },
    });
    const { role: _role, selfContained: _selfContained, sideKind: _sideKind, ...schemaPayload } = resolved;

    const result = await handleSaveDish(ctx, schemaPayload);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      userId: "user-id",
      slug: "onion_beef",
      role: "main",
      sideKind: null,
      selfContained: true,
    });
    expect(result.dish).toMatchObject({ id: "dish-id", slug: "onion_beef" });
  });

  test("handleSaveDish persists side role metadata when present", async () => {
    const { ctx, saved } = makeContext();
    const resolved = await handleProposeDish(ctx, {
      draft: {
        name: "Broccoli side",
        mealCategory: "main",
        role: "side",
        sideKind: "vegetable",
        ingredients: [{ name: "broccoli", grams: 100 }],
        seasonings: [],
        source: "user_nl",
      },
    });

    await handleSaveDish(ctx, resolved);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      slug: "broccoli_side",
      role: "side",
      sideKind: "vegetable",
      selfContained: false,
    });
  });
});
