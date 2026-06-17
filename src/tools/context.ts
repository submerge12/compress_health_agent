import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../db/schema.js";
import { createRepository, type Repository } from "../db/repository.js";
import { loadMealCatalog, loadSeasoningRecords } from "../db/catalog.js";
import type { MealCatalog } from "./nutrition-estimate.js";
import type { NutritionRecord } from "../engine/types.js";

export interface ToolContext {
  userId: string;
  locale: "zh" | "en";
  repo: Repository;
  catalog: MealCatalog;
  seasoningRecords: NutritionRecord[];
  close: () => Promise<void>;
}

export interface InitContextOptions {
  databaseUrl?: string;
  externalUserId: string;
  locale?: "zh" | "en";
  timezone?: string;
}

export async function initToolContext(options: InitContextOptions): Promise<ToolContext> {
  const url = options.databaseUrl ?? process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

  const pool = postgres(url, { max: 5, prepare: false, idle_timeout: 20, connect_timeout: 10 });
  const db = drizzle(pool, { schema });
  const repo = createRepository(db);

  const user = await repo.findOrCreateUser(options.externalUserId, {
    locale: options.locale ?? "zh",
    timezone: options.timezone ?? "Asia/Shanghai",
  });

  const [catalog, seasoningRows] = await Promise.all([
    loadMealCatalog(db),
    loadSeasoningRecords(db),
  ]);

  const seasoningRecords: NutritionRecord[] = seasoningRows.map((s) => ({
    slug: s.slug,
    kcalPer100g: s.kcalPer100g,
    proteinGramsPer100g: s.proteinGramsPer100g,
    carbsGramsPer100g: s.carbsGramsPer100g,
    fatGramsPer100g: s.fatGramsPer100g,
    sodiumMgPer100g: s.sodiumMgPer100g,
  }));

  return {
    userId: user.id,
    locale: (options.locale ?? user.locale ?? "zh") as "zh" | "en",
    repo,
    catalog,
    seasoningRecords,
    close: () => pool.end({ timeout: 5 }).then(() => undefined),
  };
}
