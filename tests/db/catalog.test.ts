import { describe, expect, test } from "vitest";

import { loadMealCatalog } from "../../src/db/catalog.js";
import * as schema from "../../src/db/schema.js";

function createCatalogDb(rowsByTable: ReadonlyMap<unknown, unknown[]>) {
  return {
    select() {
      return {
        from(table: unknown) {
          return Promise.resolve(rowsByTable.get(table) ?? []);
        },
      };
    },
  } as unknown as Parameters<typeof loadMealCatalog>[0];
}

describe("loadMealCatalog", () => {
  test("merges food aliases with English and Chinese names", async () => {
    const db = createCatalogDb(new Map<unknown, unknown[]>([
      [
        schema.foodItems,
        [{
          slug: "tomato_scrambled_eggs",
          name: "tomato egg scramble",
          nameZh: "番茄炒蛋",
          category: "prepared",
          executionBuckets: ["egg"],
          roles: ["b12"],
          weeklyFloor: 1,
          caloriesKcal: 120,
          proteinGrams: 7,
          carbsGrams: 4,
          fatGrams: 8,
          sodiumMg: 280,
        }],
      ],
      [
        schema.foodAliases,
        [
          { slug: "tomato_scrambled_eggs", alias: "西红柿炒鸡蛋", locale: "zh" },
          { slug: "tomato_scrambled_eggs", alias: "tomato scrambled eggs", locale: "en" },
        ],
      ],
      [schema.naturalUnits, []],
    ]));

    const catalog = await loadMealCatalog(db);

    expect(catalog.foods).toEqual([
      expect.objectContaining({
        slug: "tomato_scrambled_eggs",
        name: "番茄炒蛋",
        nameZh: "番茄炒蛋",
        executionBuckets: ["egg"],
        roles: ["b12"],
        weeklyFloor: 1,
        aliases: expect.arrayContaining([
          "tomato egg scramble",
          "番茄炒蛋",
          "西红柿炒鸡蛋",
          "tomato scrambled eggs",
        ]),
      }),
    ]);
  });
});
