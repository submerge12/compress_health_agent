import { describe, expect, test } from "vitest";

import {
  buildFoodEmbeddingText,
  embedFoodCatalogJobs,
  planFoodEmbeddingJobs,
  type FoodEmbeddingJob,
} from "../../src/db/embed-catalog.js";
import type { EmbeddingClient } from "../../src/embeddings/client.js";

describe("offline food catalog embedding", () => {
  test("buildFoodEmbeddingText joins stable canonical labels and aliases", () => {
    expect(buildFoodEmbeddingText({
      slug: "tomato_scrambled_eggs",
      name: "tomato egg scramble",
      nameZh: "番茄炒蛋",
      aliases: ["tomato scrambled eggs", "番茄鸡蛋"],
    })).toBe("tomato_scrambled_eggs | tomato egg scramble | 番茄炒蛋 | tomato scrambled eggs | 番茄鸡蛋");
  });

  test("planFoodEmbeddingJobs only includes foods whose text or model changed", () => {
    const jobs = planFoodEmbeddingJobs({
      model: "text-embedding-v4",
      foods: [
        {
          id: "same",
          slug: "broccoli",
          name: "broccoli",
          nameZh: "西兰花",
          embeddingText: "broccoli | 西兰花",
          embeddingModel: "text-embedding-v4",
          embedding: [0, 1, 0],
        },
        {
          id: "changed-text",
          slug: "beef_stew",
          name: "beef stew",
          nameZh: "红烧牛腩",
          embeddingText: "old text",
          embeddingModel: "text-embedding-v4",
          embedding: [1, 0, 0],
        },
        {
          id: "missing",
          slug: "tomato_scrambled_eggs",
          name: "tomato egg scramble",
          nameZh: "番茄炒蛋",
          embeddingText: null,
          embeddingModel: null,
          embedding: null,
        },
      ],
      aliases: [
        { slug: "tomato_scrambled_eggs", alias: "tomato scrambled eggs" },
      ],
    });

    expect(jobs.map((job) => job.id)).toEqual(["changed-text", "missing"]);
    expect(jobs[1]).toEqual(expect.objectContaining({
      text: "tomato_scrambled_eggs | tomato egg scramble | 番茄炒蛋 | tomato scrambled eggs",
    }));
  });

  test("embedFoodCatalogJobs uses an injected deterministic client in batches", async () => {
    const jobs: FoodEmbeddingJob[] = [
      { id: "a", text: "alpha", model: "text-embedding-v4" },
      { id: "b", text: "beta", model: "text-embedding-v4" },
    ];
    const client: EmbeddingClient = {
      embed: async (texts) => texts.map((text) => (text === "alpha" ? [1, 0, 0] : [0, 1, 0])),
    };

    await expect(embedFoodCatalogJobs(jobs, client, { batchSize: 1 })).resolves.toEqual([
      { id: "a", text: "alpha", model: "text-embedding-v4", embedding: [1, 0, 0] },
      { id: "b", text: "beta", model: "text-embedding-v4", embedding: [0, 1, 0] },
    ]);
  });
});
