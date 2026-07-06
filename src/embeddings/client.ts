import "dotenv/config";

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  maxRetries: number;
}

export interface EmbeddingClient {
  embed(texts: readonly string[]): Promise<number[][]>;
}

type EmbeddingEnv = Record<string, string | undefined>;

const DEFAULT_EMBEDDING_DIM = 1024;
const MAX_HNSW_DIM = 2000;

export function getEmbeddingConfig(env: EmbeddingEnv = process.env): EmbeddingConfig {
  const baseUrl = requiredEnv(env, "EMBEDDING_BASE_URL").replace(/\/+$/, "");
  const apiKey = requiredEnv(env, "EMBEDDING_API_KEY");
  const model = requiredEnv(env, "EMBEDDING_MODEL");
  const dimensions = getEmbeddingDimensions(env);

  return {
    baseUrl,
    apiKey,
    model,
    dimensions,
    timeoutMs: positiveIntegerEnv(env, "EMBEDDING_TIMEOUT_MS", 30_000),
    maxRetries: positiveIntegerEnv(env, "EMBEDDING_MAX_RETRIES", 2),
  };
}

export function getEmbeddingDimensions(env: EmbeddingEnv = process.env): number {
  const dimensions = positiveIntegerEnv(env, "EMBEDDING_DIM", DEFAULT_EMBEDDING_DIM);
  if (dimensions > MAX_HNSW_DIM) {
    throw new RangeError(`EMBEDDING_DIM must be <= ${MAX_HNSW_DIM} for pgvector HNSW indexes`);
  }
  return dimensions;
}

export function createEmbeddingClient(config: EmbeddingConfig = getEmbeddingConfig()): EmbeddingClient {
  return {
    embed: (texts) => embedTexts(config, texts),
  };
}

export function assertEmbeddingDimensions(vectors: readonly (readonly number[])[], expected: number): void {
  vectors.forEach((vector, index) => {
    if (vector.length !== expected) {
      throw new RangeError(`Embedding vector ${index} expected ${expected} dimensions, got ${vector.length}`);
    }
  });
}

async function embedTexts(config: EmbeddingConfig, texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const body = JSON.stringify({
    model: config.model,
    input: [...texts],
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      const response = await postEmbeddingRequest(config, body);
      const vectors = vectorsFromResponse(response);
      assertEmbeddingDimensions(vectors, config.dimensions);
      return vectors;
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === config.maxRetries) {
        break;
      }
      await delay(100 * 2 ** attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Embedding request failed");
}

async function postEmbeddingRequest(config: EmbeddingConfig, body: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new EmbeddingHttpError(response.status, `Embedding request failed with status ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function vectorsFromResponse(response: unknown): number[][] {
  if (typeof response !== "object" || response === null || !("data" in response)) {
    throw new Error("Embedding response is missing data");
  }
  const data = (response as { data: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("Embedding response data must be an array");
  }

  return data
    .map((item, index) => {
      if (typeof item !== "object" || item === null || !("embedding" in item)) {
        throw new Error(`Embedding response item ${index} is missing embedding`);
      }
      const embedding = (item as { embedding: unknown }).embedding;
      if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`Embedding response item ${index} has an invalid embedding`);
      }
      return {
        index: typeof (item as { index?: unknown }).index === "number" ? (item as { index: number }).index : index,
        embedding,
      };
    })
    .sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);
}

function requiredEnv(env: EmbeddingEnv, name: string): string {
  const value = stripOuterQuotes(env[name]?.trim() ?? "");
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveIntegerEnv(env: EmbeddingEnv, name: string, fallback: number): number {
  const rawValue = stripOuterQuotes(env[name]?.trim() ?? "");
  if (!rawValue) return fallback;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function stripOuterQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof EmbeddingHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof Error && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class EmbeddingHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "EmbeddingHttpError";
  }
}
