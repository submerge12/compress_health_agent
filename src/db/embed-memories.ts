import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { createEmbeddingClient, getEmbeddingConfig, type EmbeddingClient } from "../embeddings/client.js";
import { db, closeDb } from "./connection.js";
import { memoryRecords } from "./schema.js";
import * as schema from "./schema.js";

export interface MemoryEmbeddingSourceRow {
  id: string;
  content: string;
  status: string;
  embedding: readonly number[] | null;
  embeddingModel: string | null;
}

export interface MemoryEmbeddingJob {
  id: string;
  text: string;
  model: string;
}

export interface EmbeddedMemoryJob extends MemoryEmbeddingJob {
  embedding: number[];
}

export interface PlanMemoryEmbeddingJobsInput {
  model: string;
  memories: readonly MemoryEmbeddingSourceRow[];
}

export interface EmbedMemoryJobsOptions {
  batchSize?: number;
}

type SeedDatabase = PostgresJsDatabase<typeof schema>;

export function planMemoryEmbeddingJobs(input: PlanMemoryEmbeddingJobsInput): MemoryEmbeddingJob[] {
  return input.memories
    .filter((memory) =>
      memory.status === "active" &&
      (memory.embedding === null || memory.embeddingModel !== input.model)
    )
    .map((memory) => ({
      id: memory.id,
      text: memory.content,
      model: input.model,
    }));
}

export async function embedMemoryJobs(
  jobs: readonly MemoryEmbeddingJob[],
  client: EmbeddingClient,
  options: EmbedMemoryJobsOptions = {},
): Promise<EmbeddedMemoryJob[]> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 8, 8));
  const embedded: EmbeddedMemoryJob[] = [];
  for (let index = 0; index < jobs.length; index += batchSize) {
    const batch = jobs.slice(index, index + batchSize);
    const vectors = await client.embed(batch.map((job) => job.text));
    batch.forEach((job, batchIndex) => {
      const embedding = vectors[batchIndex];
      if (embedding === undefined) {
        throw new Error(`Missing embedding for memory job ${job.id}`);
      }
      embedded.push({ ...job, embedding });
    });
  }
  return embedded;
}

export async function embedActiveMemories(
  database: SeedDatabase,
  client: EmbeddingClient,
  model: string,
): Promise<{ planned: number; embedded: number }> {
  const memories = await database.select({
    id: memoryRecords.id,
    content: memoryRecords.content,
    status: memoryRecords.status,
    embedding: memoryRecords.embedding,
    embeddingModel: memoryRecords.embeddingModel,
  }).from(memoryRecords).where(eq(memoryRecords.status, "active"));
  const jobs = planMemoryEmbeddingJobs({ model, memories });
  const embedded = await embedMemoryJobs(jobs, client);

  for (const job of embedded) {
    await database.update(memoryRecords)
      .set({
        embedding: job.embedding,
        embeddingModel: job.model,
        updatedAt: sql`now()`,
      })
      .where(eq(memoryRecords.id, job.id));
  }

  return { planned: jobs.length, embedded: embedded.length };
}

async function main(): Promise<void> {
  const config = getEmbeddingConfig();
  const client = createEmbeddingClient(config);
  const result = await embedActiveMemories(db, client, config.model);
  console.log(`Memory embeddings: planned=${result.planned} embedded=${result.embedded}`);
  await closeDb();
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href;
}

if (isDirectRun()) {
  main().catch(async (error: unknown) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
}
