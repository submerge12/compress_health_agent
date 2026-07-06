import { describe, expect, test } from "vitest";

import {
  embedMemoryJobs,
  planMemoryEmbeddingJobs,
  type MemoryEmbeddingJob,
} from "../../src/db/embed-memories.js";
import type { EmbeddingClient } from "../../src/embeddings/client.js";

describe("offline memory embedding backfill", () => {
  test("planMemoryEmbeddingJobs includes only active memories missing the current model embedding", () => {
    const jobs = planMemoryEmbeddingJobs({
      model: "text-embedding-v4",
      memories: [
        {
          id: "ready",
          content: "Ready memory",
          status: "active",
          embedding: Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0),
          embeddingModel: "text-embedding-v4",
        },
        {
          id: "missing",
          content: "Missing embedding",
          status: "active",
          embedding: null,
          embeddingModel: null,
        },
        {
          id: "superseded",
          content: "Old memory",
          status: "superseded",
          embedding: null,
          embeddingModel: null,
        },
      ],
    });

    expect(jobs).toEqual([
      { id: "missing", text: "Missing embedding", model: "text-embedding-v4" },
    ]);
  });

  test("embedMemoryJobs uses an injected deterministic client in batches", async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
    const jobs: MemoryEmbeddingJob[] = [
      { id: "a", text: "alpha", model: "text-embedding-v4" },
      { id: "b", text: "beta", model: "text-embedding-v4" },
    ];
    const client: EmbeddingClient = {
      embed: async (texts) => texts.map(() => vector),
    };

    await expect(embedMemoryJobs(jobs, client, { batchSize: 1 })).resolves.toEqual([
      { id: "a", text: "alpha", model: "text-embedding-v4", embedding: vector },
      { id: "b", text: "beta", model: "text-embedding-v4", embedding: vector },
    ]);
  });
});
