import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { eq, sql } from "drizzle-orm";

import { createEmbeddingClient, getEmbeddingConfig, type EmbeddingClient } from "../embeddings/client.js";
import { db, closeDb } from "./connection.js";
import { foodAliases, foodItems, type compass } from "./schema.js";

export interface FoodEmbeddingSourceRow {
  id: string;
  slug: string;
  name: string;
  nameZh: string | null;
  embeddingText: string | null;
  embeddingModel: string | null;
  embedding: readonly number[] | null;
}

export interface FoodAliasSourceRow {
  slug: string;
  alias: string;
}

export interface FoodEmbeddingJob {
  id: string;
  text: string;
  model: string;
}

export interface EmbeddedFoodJob extends FoodEmbeddingJob {
  embedding: number[];
}

export interface PlanFoodEmbeddingJobsInput {
  model: string;
  foods: readonly FoodEmbeddingSourceRow[];
  aliases: readonly FoodAliasSourceRow[];
}

export interface EmbedFoodCatalogJobsOptions {
  batchSize?: number;
}

type SeedDatabase = Parameters<typeof db.select>[0] extends never ? never : typeof db;

export function buildFoodEmbeddingText(input: {
  slug: string;
  name: string;
  nameZh?: string | null;
  aliases?: readonly string[];
}): string {
  return uniqueNonEmpty([
    input.slug,
    input.name,
    input.nameZh,
    ...(input.aliases ?? []),
  ]).join(" | ");
}

export function planFoodEmbeddingJobs(input: PlanFoodEmbeddingJobsInput): FoodEmbeddingJob[] {
  const aliasesBySlug = new Map<string, string[]>();
  for (const alias of input.aliases) {
    const aliases = aliasesBySlug.get(alias.slug) ?? [];
    aliases.push(alias.alias);
    aliasesBySlug.set(alias.slug, aliases);
  }

  return input.foods
    .map((food): FoodEmbeddingJob | undefined => {
      const text = buildFoodEmbeddingText({
        slug: food.slug,
        name: food.name,
        nameZh: food.nameZh,
        aliases: aliasesBySlug.get(food.slug) ?? [],
      });
      if (food.embedding !== null && food.embeddingText === text && food.embeddingModel === input.model) {
        return undefined;
      }
      return {
        id: food.id,
        text,
        model: input.model,
      };
    })
    .filter((job): job is FoodEmbeddingJob => job !== undefined);
}

export async function embedFoodCatalogJobs(
  jobs: readonly FoodEmbeddingJob[],
  client: EmbeddingClient,
  options: EmbedFoodCatalogJobsOptions = {},
): Promise<EmbeddedFoodJob[]> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 8, 8));
  const embedded: EmbeddedFoodJob[] = [];
  for (let index = 0; index < jobs.length; index += batchSize) {
    const batch = jobs.slice(index, index + batchSize);
    const vectors = await client.embed(batch.map((job) => job.text));
    batch.forEach((job, batchIndex) => {
      const embedding = vectors[batchIndex];
      if (embedding === undefined) {
        throw new Error(`Missing embedding for food catalog job ${job.id}`);
      }
      embedded.push({ ...job, embedding });
    });
  }
  return embedded;
}

export async function embedFoodCatalog(
  database: SeedDatabase,
  client: EmbeddingClient,
  model: string,
): Promise<{ planned: number; embedded: number }> {
  const [foods, aliases] = await Promise.all([
    database.select({
      id: foodItems.id,
      slug: foodItems.slug,
      name: foodItems.name,
      nameZh: foodItems.nameZh,
      embeddingText: foodItems.embeddingText,
      embeddingModel: foodItems.embeddingModel,
      embedding: foodItems.embedding,
    }).from(foodItems),
    database.select({
      slug: foodAliases.slug,
      alias: foodAliases.alias,
    }).from(foodAliases),
  ]);
  const jobs = planFoodEmbeddingJobs({ model, foods, aliases });
  const embedded = await embedFoodCatalogJobs(jobs, client);

  for (const job of embedded) {
    await database.update(foodItems)
      .set({
        embedding: job.embedding,
        embeddingText: job.text,
        embeddingModel: job.model,
        updatedAt: sql`now()`,
      })
      .where(eq(foodItems.id, job.id));
  }

  return { planned: jobs.length, embedded: embedded.length };
}

async function main(): Promise<void> {
  const config = getEmbeddingConfig();
  const client = createEmbeddingClient(config);
  const result = await embedFoodCatalog(db, client, config.model);
  console.log(`Food catalog embeddings: planned=${result.planned} embedded=${result.embedded}`);
  await closeDb();
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href;
}

function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

if (isDirectRun()) {
  main().catch(async (error: unknown) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
}
