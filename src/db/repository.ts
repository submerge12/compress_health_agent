import { and, eq, gte, lte, desc, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { EmbeddingClient } from "../embeddings/client.js";
import * as schema from "./schema.js";

type Db = PostgresJsDatabase<typeof schema>;
const MEMORY_TRGM_THRESHOLD = "0.08";
const MEMORY_VECTOR_THRESHOLD = 0.5;

export interface UserRow {
  id: string;
  externalId: string;
  email: string | null;
  displayName: string | null;
  locale: string;
  timezone: string;
}

export interface BmrProfileRow {
  id: string;
  userId: string;
  sex: string;
  ageYears: number;
  heightCm: number;
  weightKg: number;
  activityLevel: string;
  goal: string;
  bmrKcal: number;
  tdeeKcal: number;
  targetKcal: number;
  proteinTargetGrams: number;
  carbsTargetGrams: number;
  fatTargetGrams: number;
}

export interface DietLogRow {
  id: string;
  userId: string;
  logDate: string;
  mealType: string;
  description: string;
  source: string;
  ingredientsJson: Record<string, unknown>[];
  seasoningsJson: Record<string, unknown>[];
  caloriesKcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
}

export interface WaterLogRow {
  id: string;
  userId: string;
  logDate: string;
  amountMl: number;
}

export interface ExerciseLogRow {
  id: string;
  userId: string;
  logDate: string;
  activityType: string;
  durationMinutes: number;
  caloriesBurnedKcal: number;
  intensity: string | null;
  notes: string | null;
}

export interface WeightLogRow {
  id: string;
  userId: string;
  weightKg: number | null;
  bodyFatPercent: number | null;
  waistCm: number | null;
  notes: string | null;
}

export interface MealPlanEntryRow {
  id: string;
  userId: string;
  planDate: string;
  mealType: string;
  dishName: string;
  recipeSlug: string | null;
  status: string;
  ingredientsJson: Record<string, unknown>[];
  seasoningsJson: Record<string, unknown>[];
  caloriesKcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
}

export interface CookingRecordRow {
  id: string;
  userId: string;
  dishName: string;
  description: string | null;
  ingredientsJson: Record<string, unknown>[];
  seasoningsJson: Record<string, unknown>[];
  timesCooked: number;
  lastCookedAt: Date | null;
  rating: number | null;
  notes: string | null;
  caloriesKcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
}

export type UserDishMealCategory = "breakfast" | "main";
export type UserDishRole = "main" | "side";
export type UserDishSideKind = "vegetable" | "soup";

export interface UserDishRow {
  id: string;
  userId: string;
  slug: string;
  name: string;
  mealCategory: UserDishMealCategory;
  role: UserDishRole;
  sideKind: UserDishSideKind | null;
  selfContained: boolean;
  ingredientsJson: Record<string, unknown>[];
  seasoningsJson: Record<string, unknown>[];
  method: string | null;
  caloriesKcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
  source: string;
}

export type MemoryKind = "preference" | "dislike" | "routine" | "note";
export type MemoryStatus = "active" | "superseded" | "retracted";

export interface MemoryRecordRow {
  id: string;
  userId: string;
  kind: MemoryKind;
  subject: string;
  content: string;
  contentNorm: string;
  sourceText: string | null;
  confidence: number;
  status: MemoryStatus;
  supersededBy: string | null;
  validFrom: Date;
  validTo: Date | null;
  lastConfirmedAt: Date | null;
  timesReferenced: number;
}

export interface UpsertMemoryInput {
  userId: string;
  kind: MemoryKind;
  subject: string;
  content: string;
  sourceText?: string | null;
  confidence?: number;
}

export interface RecallMemoryOptions {
  kinds?: readonly MemoryKind[];
  limit?: number;
}

export interface FoodEmbeddingCandidateRow {
  slug: string;
  label: string;
  score: number;
}

export interface RepositoryOptions {
  embeddingClient?: EmbeddingClient;
  embeddingModel?: string;
}

interface RankedMemoryRecordRow extends MemoryRecordRow {
  rankScore: number;
  updatedAt: Date;
}

// ---------- Repository ----------

export function createRepository(db: Db, repositoryOptions: RepositoryOptions = {}) {
  const embeddingModel = repositoryOptions.embeddingModel ?? process.env.EMBEDDING_MODEL ?? null;

  async function embedMemoryContent(content: string): Promise<number[] | undefined> {
    if (repositoryOptions.embeddingClient === undefined) return undefined;
    const [embedding] = await repositoryOptions.embeddingClient.embed([content]);
    return embedding;
  }

  return {
    // ── Users ──
    async findOrCreateUser(externalId: string, defaults?: { locale?: string; timezone?: string }): Promise<UserRow> {
      const existing = await db.select().from(schema.users).where(eq(schema.users.externalId, externalId)).limit(1);
      if (existing[0]) return existing[0] as unknown as UserRow;

      const [created] = await db.insert(schema.users).values({
        externalId,
        locale: defaults?.locale ?? "zh",
        timezone: defaults?.timezone ?? "Asia/Shanghai",
      }).returning();
      return created as unknown as UserRow;
    },

    async getUser(userId: string): Promise<UserRow | undefined> {
      const rows = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
      return rows[0] as unknown as UserRow | undefined;
    },

    // ── BMR Profiles ──
    async upsertBmrProfile(userId: string, data: Omit<BmrProfileRow, "id" | "userId">): Promise<BmrProfileRow> {
      const existing = await db.select().from(schema.bmrProfiles)
        .where(eq(schema.bmrProfiles.userId, userId))
        .orderBy(desc(schema.bmrProfiles.createdAt))
        .limit(1);

      if (existing[0]) {
        const [updated] = await db.update(schema.bmrProfiles)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(schema.bmrProfiles.id, existing[0].id))
          .returning();
        return updated as unknown as BmrProfileRow;
      }

      const [created] = await db.insert(schema.bmrProfiles).values({
        userId,
        ...data,
        effectiveDate: new Date().toISOString().slice(0, 10),
      }).returning();
      return created as unknown as BmrProfileRow;
    },

    async getLatestBmrProfile(userId: string): Promise<BmrProfileRow | undefined> {
      const rows = await db.select().from(schema.bmrProfiles)
        .where(eq(schema.bmrProfiles.userId, userId))
        .orderBy(desc(schema.bmrProfiles.createdAt))
        .limit(1);
      return rows[0] as unknown as BmrProfileRow | undefined;
    },

    // ── Diet Logs ──
    async insertDietLog(data: Omit<DietLogRow, "id">): Promise<DietLogRow> {
      const [created] = await db.insert(schema.dietLogs).values({
        userId: data.userId,
        logDate: data.logDate,
        mealType: data.mealType,
        description: data.description,
        source: data.source,
        ingredientsJson: data.ingredientsJson,
        seasoningsJson: data.seasoningsJson,
        caloriesKcal: data.caloriesKcal,
        proteinGrams: data.proteinGrams,
        carbsGrams: data.carbsGrams,
        fatGrams: data.fatGrams,
        sodiumMg: data.sodiumMg,
      }).returning();
      return created as unknown as DietLogRow;
    },

    async listDietLogs(userId: string, date?: string): Promise<DietLogRow[]> {
      const conditions = [eq(schema.dietLogs.userId, userId)];
      if (date) conditions.push(eq(schema.dietLogs.logDate, date));
      const rows = await db.select().from(schema.dietLogs).where(and(...conditions)).orderBy(schema.dietLogs.loggedAt);
      return rows as unknown as DietLogRow[];
    },

    async listDietLogsRange(userId: string, startDate: string, endDate: string): Promise<DietLogRow[]> {
      const rows = await db.select().from(schema.dietLogs).where(and(
        eq(schema.dietLogs.userId, userId),
        gte(schema.dietLogs.logDate, startDate),
        lte(schema.dietLogs.logDate, endDate),
      )).orderBy(schema.dietLogs.logDate, schema.dietLogs.loggedAt);
      return rows as unknown as DietLogRow[];
    },

    // ── Water Logs ──
    async insertWaterLog(userId: string, logDate: string, amountMl: number): Promise<WaterLogRow> {
      const [created] = await db.insert(schema.waterLogs).values({ userId, logDate, amountMl }).returning();
      return created as unknown as WaterLogRow;
    },

    async listWaterLogs(userId: string, date?: string): Promise<WaterLogRow[]> {
      const conditions = [eq(schema.waterLogs.userId, userId)];
      if (date) conditions.push(eq(schema.waterLogs.logDate, date));
      const rows = await db.select().from(schema.waterLogs).where(and(...conditions)).orderBy(schema.waterLogs.loggedAt);
      return rows as unknown as WaterLogRow[];
    },

    // ── Exercise Logs ──
    async insertExerciseLog(data: Omit<ExerciseLogRow, "id">): Promise<ExerciseLogRow> {
      const [created] = await db.insert(schema.exerciseLogs).values({
        userId: data.userId,
        logDate: data.logDate,
        activityType: data.activityType,
        durationMinutes: data.durationMinutes,
        caloriesBurnedKcal: data.caloriesBurnedKcal,
        intensity: data.intensity,
        notes: data.notes,
      }).returning();
      return created as unknown as ExerciseLogRow;
    },

    async listExerciseLogs(userId: string, date?: string): Promise<ExerciseLogRow[]> {
      const conditions = [eq(schema.exerciseLogs.userId, userId)];
      if (date) conditions.push(eq(schema.exerciseLogs.logDate, date));
      const rows = await db.select().from(schema.exerciseLogs).where(and(...conditions)).orderBy(schema.exerciseLogs.loggedAt);
      return rows as unknown as ExerciseLogRow[];
    },

    // ── Physical Conditions (weight) ──
    async insertWeightLog(userId: string, data: Omit<WeightLogRow, "id" | "userId">): Promise<WeightLogRow> {
      const [created] = await db.insert(schema.physicalConditions).values({
        userId,
        weightKg: data.weightKg,
        bodyFatPercent: data.bodyFatPercent,
        waistCm: data.waistCm,
        notes: data.notes,
      }).returning();
      return created as unknown as WeightLogRow;
    },

    async listWeightLogs(userId: string, limit = 30): Promise<WeightLogRow[]> {
      const rows = await db.select().from(schema.physicalConditions)
        .where(eq(schema.physicalConditions.userId, userId))
        .orderBy(desc(schema.physicalConditions.measuredAt))
        .limit(limit);
      return rows as unknown as WeightLogRow[];
    },

    // ── Meal Plan Entries ──
    async insertMealPlanEntry(data: Omit<MealPlanEntryRow, "id">): Promise<MealPlanEntryRow> {
      const [created] = await db.insert(schema.mealPlanEntries).values({
        userId: data.userId,
        planDate: data.planDate,
        mealType: data.mealType,
        dishName: data.dishName,
        recipeSlug: data.recipeSlug,
        status: data.status,
        ingredientsJson: data.ingredientsJson,
        seasoningsJson: data.seasoningsJson,
        caloriesKcal: data.caloriesKcal,
        proteinGrams: data.proteinGrams,
        carbsGrams: data.carbsGrams,
        fatGrams: data.fatGrams,
        sodiumMg: data.sodiumMg,
      }).returning();
      return created as unknown as MealPlanEntryRow;
    },

    async listMealPlanEntries(userId: string, date?: string): Promise<MealPlanEntryRow[]> {
      const conditions = [eq(schema.mealPlanEntries.userId, userId)];
      if (date) conditions.push(eq(schema.mealPlanEntries.planDate, date));
      const rows = await db.select().from(schema.mealPlanEntries).where(and(...conditions)).orderBy(schema.mealPlanEntries.planDate);
      return rows as unknown as MealPlanEntryRow[];
    },

    async listMealPlanEntriesRange(userId: string, startDate: string, endDate: string): Promise<MealPlanEntryRow[]> {
      const rows = await db.select().from(schema.mealPlanEntries).where(and(
        eq(schema.mealPlanEntries.userId, userId),
        gte(schema.mealPlanEntries.planDate, startDate),
        lte(schema.mealPlanEntries.planDate, endDate),
      )).orderBy(schema.mealPlanEntries.planDate);
      return rows as unknown as MealPlanEntryRow[];
    },

    async updateMealPlanStatus(entryId: string, status: string): Promise<void> {
      await db.update(schema.mealPlanEntries)
        .set({ status, updatedAt: new Date() })
        .where(eq(schema.mealPlanEntries.id, entryId));
    },

    // ── Cooking Records ──
    async listCookingRecords(userId: string): Promise<CookingRecordRow[]> {
      const rows = await db.select().from(schema.cookingRecords)
        .where(eq(schema.cookingRecords.userId, userId))
        .orderBy(desc(schema.cookingRecords.lastCookedAt));
      return rows as unknown as CookingRecordRow[];
    },

    async upsertCookingRecord(userId: string, dishName: string, data: {
      description?: string;
      ingredientsJson?: Record<string, unknown>[];
      seasoningsJson?: Record<string, unknown>[];
      rating?: number;
      notes?: string;
    }): Promise<void> {
      const existing = await db.select().from(schema.cookingRecords)
        .where(and(eq(schema.cookingRecords.userId, userId), eq(schema.cookingRecords.dishName, dishName)))
        .limit(1);

      if (existing[0]) {
        await db.update(schema.cookingRecords).set({
          ...data,
          timesCooked: existing[0].timesCooked + 1,
          lastCookedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(schema.cookingRecords.id, existing[0].id));
      } else {
        await db.insert(schema.cookingRecords).values({
          userId,
          dishName,
          ...data,
          timesCooked: 1,
          lastCookedAt: new Date(),
        });
      }
    },
    // ── Seasoning Preferences ──
    async upsertUserDish(data: Omit<UserDishRow, "id">): Promise<UserDishRow> {
      const existing = await db.select().from(schema.userDishes)
        .where(and(
          eq(schema.userDishes.userId, data.userId),
          eq(schema.userDishes.slug, data.slug),
        ))
        .limit(1);

      const values = {
        userId: data.userId,
        slug: data.slug,
        name: data.name,
        mealCategory: data.mealCategory,
        role: data.role ?? "main",
        sideKind: data.sideKind ?? null,
        selfContained: data.selfContained ?? true,
        ingredientsJson: data.ingredientsJson,
        seasoningsJson: data.seasoningsJson,
        method: data.method,
        caloriesKcal: data.caloriesKcal,
        proteinGrams: data.proteinGrams,
        carbsGrams: data.carbsGrams,
        fatGrams: data.fatGrams,
        sodiumMg: data.sodiumMg,
        source: data.source,
        updatedAt: new Date(),
      };

      if (existing[0]) {
        const [updated] = await db.update(schema.userDishes)
          .set(values)
          .where(eq(schema.userDishes.id, existing[0].id))
          .returning();
        return updated as unknown as UserDishRow;
      }

      const [created] = await db.insert(schema.userDishes).values(values).returning();
      if (!created) {
        throw new Error("Failed to create user dish");
      }
      return created as unknown as UserDishRow;
    },

    async listUserDishes(userId: string): Promise<UserDishRow[]> {
      const rows = await db.select().from(schema.userDishes)
        .where(eq(schema.userDishes.userId, userId))
        .orderBy(desc(schema.userDishes.createdAt));
      return rows as unknown as UserDishRow[];
    },

    async listRejectedSeasoningSlugs(userId: string): Promise<string[]> {
      const rows = await db
        .select({ slug: schema.seasonings.slug })
        .from(schema.userSeasoningPreferences)
        .innerJoin(schema.seasonings, eq(schema.seasonings.id, schema.userSeasoningPreferences.seasoningId))
        .where(and(
          eq(schema.userSeasoningPreferences.userId, userId),
          eq(schema.userSeasoningPreferences.avoid, true),
        ));
      return rows.map((r) => r.slug);
    },

    async findFoodCandidatesByEmbedding(
      queryEmbedding: readonly number[],
      limit = 5,
    ): Promise<FoodEmbeddingCandidateRow[]> {
      const vector = vectorLiteral(queryEmbedding);
      const safeLimit = Math.max(1, Math.min(limit, 20));
      const rows = await db.execute(sql<FoodEmbeddingCandidateRow>`
        SELECT
          "slug",
          COALESCE("name_zh", "name", "slug") AS "label",
          (1 - ("embedding" <=> ${vector}::vector))::float8 AS "score"
        FROM ${schema.foodItems}
        WHERE "embedding" IS NOT NULL
        ORDER BY "embedding" <=> ${vector}::vector
        LIMIT ${safeLimit}
      `);
      return rows as unknown as FoodEmbeddingCandidateRow[];
    },

    async listActiveMemories(
      userId: string,
      kinds?: readonly MemoryKind[],
    ): Promise<MemoryRecordRow[]> {
      const filters = [
        eq(schema.memoryRecords.userId, userId),
        eq(schema.memoryRecords.status, "active"),
      ];
      if (kinds !== undefined && kinds.length > 0) {
        filters.push(inArray(schema.memoryRecords.kind, [...kinds]));
      }
      const rows = await db.select().from(schema.memoryRecords)
        .where(and(...filters))
        .orderBy(desc(schema.memoryRecords.updatedAt));
      return rows as unknown as MemoryRecordRow[];
    },

    // 鈹€鈹€ Memory Records 鈹€鈹€
    async upsertMemory(input: UpsertMemoryInput): Promise<MemoryRecordRow> {
      const subject = input.subject.trim();
      const content = input.content.trim();
      const contentNorm = normalizeMemoryText(content);
      const now = new Date();
      const [existing] = await db.select().from(schema.memoryRecords)
        .where(and(
          eq(schema.memoryRecords.userId, input.userId),
          eq(schema.memoryRecords.kind, input.kind),
          eq(schema.memoryRecords.subject, subject),
          eq(schema.memoryRecords.status, "active"),
        ))
        .limit(1);

      if (existing && existing.content === content) {
        const missingEmbedding = existing.embedding === null;
        const embedding = missingEmbedding ? await embedMemoryContent(content) : undefined;
        const [updated] = await db.update(schema.memoryRecords)
          .set({
            contentNorm,
            ...(embedding !== undefined ? { embedding, embeddingModel } : {}),
            lastConfirmedAt: now,
            timesReferenced: existing.timesReferenced + 1,
            updatedAt: now,
          })
          .where(eq(schema.memoryRecords.id, existing.id))
          .returning();
        return updated as unknown as MemoryRecordRow;
      }

      const embedding = await embedMemoryContent(content);
      const [created] = await db.insert(schema.memoryRecords).values({
        userId: input.userId,
        kind: input.kind,
        subject,
        content,
        contentNorm,
        sourceText: input.sourceText ?? null,
        confidence: input.confidence ?? 1,
        status: "active",
        ...(embedding !== undefined ? { embedding, embeddingModel } : {}),
      }).returning();
      if (!created) {
        throw new Error("Failed to create memory record");
      }

      if (existing) {
        await db.update(schema.memoryRecords)
          .set({
            status: "superseded",
            supersededBy: created.id,
            validTo: now,
            updatedAt: now,
          })
          .where(eq(schema.memoryRecords.id, existing.id));
      }

      return created as unknown as MemoryRecordRow;
    },

    async recallMemories(
      userId: string,
      query: string,
      options: RecallMemoryOptions = {},
    ): Promise<MemoryRecordRow[]> {
      const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
      const candidateLimit = Math.max(limit * 4, limit);
      const normalizedQuery = normalizeMemoryText(query);
      if (!normalizedQuery) return [];
      const normalizedQueryPattern = `%${normalizedQuery}%`;

      const kindFilter = options.kinds !== undefined && options.kinds.length > 0
        ? sql`AND "kind" IN (${sql.join(options.kinds.map((kind) => sql`${kind}`), sql`, `)})`
        : sql``;
      const lexicalRows = await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT
            set_config('pg_trgm.similarity_threshold', ${MEMORY_TRGM_THRESHOLD}, true)
        `);
        return tx.execute(sql<RankedMemoryRecordRow>`
          WITH ranked AS (
            SELECT
              "id",
              "user_id" AS "userId",
              "kind",
              "subject",
              "content",
              "content_norm" AS "contentNorm",
              "source_text" AS "sourceText",
              "confidence",
              "status",
              "superseded_by" AS "supersededBy",
              "valid_from" AS "validFrom",
              "valid_to" AS "validTo",
              "last_confirmed_at" AS "lastConfirmedAt",
              "times_referenced" AS "timesReferenced",
              "updated_at" AS "updatedAt",
              GREATEST(
                word_similarity(${normalizedQuery}, "content_norm"),
                word_similarity("content_norm", ${normalizedQuery}),
                similarity(${normalizedQuery}, "content_norm"),
                CASE WHEN "content_norm" LIKE ${normalizedQueryPattern} THEN 1 ELSE 0 END
              ) AS "lexicalScore",
              1 / (
                1 + GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (now() - COALESCE("last_confirmed_at", "valid_from"))) / 86400
                ) / 90
              ) AS "recencyBoost"
            FROM ${schema.memoryRecords}
            WHERE
              "user_id" = ${userId}
              AND "status" = 'active'
              ${kindFilter}
              AND "content_norm" <> ''
              AND (
                "content_norm" % ${normalizedQuery}
                OR "content_norm" LIKE ${normalizedQueryPattern}
              )
          )
          SELECT
            "id",
            "userId",
            "kind",
            "subject",
            "content",
            "contentNorm",
            "sourceText",
            "confidence",
            "status",
            "supersededBy",
            "validFrom",
            "validTo",
            "lastConfirmedAt",
            "timesReferenced",
            "updatedAt",
            ("lexicalScore" * (1 + "recencyBoost" * 0.1))::float8 AS "rankScore"
          FROM ranked
          ORDER BY "rankScore" DESC, "updatedAt" DESC
          LIMIT ${candidateLimit}
        `);
      });

      const rankedRows = [...(lexicalRows as unknown as RankedMemoryRecordRow[])];
      if (repositoryOptions.embeddingClient !== undefined) {
        const [queryEmbedding] = await repositoryOptions.embeddingClient.embed([query]);
        if (queryEmbedding !== undefined) {
          const vector = vectorLiteral(queryEmbedding);
          const vectorRows = await db.execute(sql<RankedMemoryRecordRow>`
            WITH ranked AS (
              SELECT
                "id",
                "user_id" AS "userId",
                "kind",
                "subject",
                "content",
                "content_norm" AS "contentNorm",
                "source_text" AS "sourceText",
                "confidence",
                "status",
                "superseded_by" AS "supersededBy",
                "valid_from" AS "validFrom",
                "valid_to" AS "validTo",
                "last_confirmed_at" AS "lastConfirmedAt",
                "times_referenced" AS "timesReferenced",
                "updated_at" AS "updatedAt",
                (1 - ("embedding" <=> ${vector}::vector))::float8 AS "semanticScore",
                1 / (
                  1 + GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (now() - COALESCE("last_confirmed_at", "valid_from"))) / 86400
                  ) / 90
                ) AS "recencyBoost"
              FROM ${schema.memoryRecords}
              WHERE
                "user_id" = ${userId}
                AND "status" = 'active'
                ${kindFilter}
                AND "embedding" IS NOT NULL
                AND (1 - ("embedding" <=> ${vector}::vector)) >= ${MEMORY_VECTOR_THRESHOLD}
              ORDER BY "embedding" <=> ${vector}::vector
              LIMIT ${candidateLimit}
            )
            SELECT
              "id",
              "userId",
              "kind",
              "subject",
              "content",
              "contentNorm",
              "sourceText",
              "confidence",
              "status",
              "supersededBy",
              "validFrom",
              "validTo",
              "lastConfirmedAt",
              "timesReferenced",
              "updatedAt",
              ("semanticScore" * (1 + "recencyBoost" * 0.1))::float8 AS "rankScore"
            FROM ranked
            ORDER BY "rankScore" DESC, "updatedAt" DESC
          `);
          rankedRows.push(...(vectorRows as unknown as RankedMemoryRecordRow[]));
        }
      }

      rankedRows.sort((left, right) =>
        right.rankScore - left.rankScore ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );

      const bySubject = new Map<string, MemoryRecordRow>();
      for (const row of rankedRows) {
        if (!bySubject.has(row.subject)) {
          bySubject.set(row.subject, stripMemoryRank(row));
        }
        if (bySubject.size >= limit) break;
      }

      return [...bySubject.values()];
    },

    async confirmMemory(userId: string, memoryId: string): Promise<MemoryRecordRow | undefined> {
      const [updated] = await db.update(schema.memoryRecords)
        .set({ lastConfirmedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(schema.memoryRecords.userId, userId),
          eq(schema.memoryRecords.id, memoryId),
        ))
        .returning();
      return updated as unknown as MemoryRecordRow | undefined;
    },

    async retractMemory(userId: string, memoryId: string): Promise<void> {
      const now = new Date();
      await db.update(schema.memoryRecords)
        .set({ status: "retracted", validTo: now, updatedAt: now })
        .where(and(
          eq(schema.memoryRecords.userId, userId),
          eq(schema.memoryRecords.id, memoryId),
        ));
    },
  };
}

export type Repository = ReturnType<typeof createRepository>;

function normalizeMemoryText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s_]+/gu, "");
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length === 0) {
    throw new RangeError("embedding vector must not be empty");
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new RangeError("embedding vector must contain only finite numbers");
    }
  }
  return `[${vector.join(",")}]`;
}

function stripMemoryRank(row: RankedMemoryRecordRow): MemoryRecordRow {
  const { rankScore: _rankScore, updatedAt: _updatedAt, ...memory } = row;
  return memory;
}
