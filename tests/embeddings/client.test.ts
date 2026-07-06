import { describe, expect, test } from "vitest";

import {
  assertEmbeddingDimensions,
  getEmbeddingConfig,
  type EmbeddingClient,
} from "../../src/embeddings/client.js";

describe("embedding client infrastructure", () => {
  test("getEmbeddingConfig reads the locked OpenAI-compatible embedding env", () => {
    const config = getEmbeddingConfig({
      EMBEDDING_BASE_URL: "https://example.test/v1/",
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "text-embedding-v4",
      EMBEDDING_DIM: "1024",
    });

    expect(config).toEqual({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "text-embedding-v4",
      dimensions: 1024,
      timeoutMs: 30_000,
      maxRetries: 2,
    });
  });

  test("getEmbeddingConfig rejects dimensions that would break pgvector HNSW", () => {
    expect(() =>
      getEmbeddingConfig({
        EMBEDDING_BASE_URL: "https://example.test/v1",
        EMBEDDING_API_KEY: "test-key",
        EMBEDDING_MODEL: "text-embedding-v4",
        EMBEDDING_DIM: "3072",
      }),
    ).toThrow(/EMBEDDING_DIM/);
  });

  test("assertEmbeddingDimensions fails fast when the provider returns the wrong vector size", () => {
    expect(() => assertEmbeddingDimensions([[0.1, 0.2]], 1024)).toThrow(/expected 1024/);
  });

  test("tests can inject a deterministic mock embedding client without network calls", async () => {
    const client: EmbeddingClient = {
      embed: async (texts) => texts.map((text) => (text.includes("tomato") ? [1, 0, 0] : [0, 1, 0])),
    };

    await expect(client.embed(["tomato scrambled eggs", "nonsense"])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });
});
