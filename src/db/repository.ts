import { and, eq, gte, lte, desc, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";

type Db = PostgresJsDatabase<typeof schema>;

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

export interface UserDishRow {
  id: string;
  userId: string;
  slug: string;
  name: string;
  mealCategory: UserDishMealCategory;
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

// ---------- Repository ----------

export function createRepository(db: Db) {
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

    async setSeasoningPreference(userId: string, seasoningSlug: string, avoid: boolean): Promise<void> {
      const [seasoning] = await db.select({ id: schema.seasonings.id })
        .from(schema.seasonings)
        .where(eq(schema.seasonings.slug, seasoningSlug))
        .limit(1);
      if (!seasoning) return;

      const existing = await db.select().from(schema.userSeasoningPreferences)
        .where(and(
          eq(schema.userSeasoningPreferences.userId, userId),
          eq(schema.userSeasoningPreferences.seasoningId, seasoning.id),
        ))
        .limit(1);

      if (existing[0]) {
        await db.update(schema.userSeasoningPreferences)
          .set({ avoid, preference: avoid ? "rejected" : "neutral", updatedAt: new Date() })
          .where(eq(schema.userSeasoningPreferences.id, existing[0].id));
      } else {
        await db.insert(schema.userSeasoningPreferences).values({
          userId,
          seasoningId: seasoning.id,
          avoid,
          preference: avoid ? "rejected" : "neutral",
        });
      }
    },

    // 鈹€鈹€ Memory Records 鈹€鈹€
    async upsertMemory(input: UpsertMemoryInput): Promise<MemoryRecordRow> {
      const subject = input.subject.trim();
      const content = input.content.trim();
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
        const [updated] = await db.update(schema.memoryRecords)
          .set({
            lastConfirmedAt: now,
            timesReferenced: existing.timesReferenced + 1,
            updatedAt: now,
          })
          .where(eq(schema.memoryRecords.id, existing.id))
          .returning();
        return updated as unknown as MemoryRecordRow;
      }

      const [created] = await db.insert(schema.memoryRecords).values({
        userId: input.userId,
        kind: input.kind,
        subject,
        content,
        sourceText: input.sourceText ?? null,
        confidence: input.confidence ?? 1,
        status: "active",
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
      const conditions = [
        eq(schema.memoryRecords.userId, userId),
        eq(schema.memoryRecords.status, "active"),
      ];
      if (options.kinds !== undefined && options.kinds.length > 0) {
        conditions.push(inArray(schema.memoryRecords.kind, [...options.kinds]));
      }

      const rows = await db.select().from(schema.memoryRecords)
        .where(and(...conditions))
        .orderBy(desc(schema.memoryRecords.lastConfirmedAt), desc(schema.memoryRecords.updatedAt))
        .limit(Math.max(limit * 4, limit));

      const scored = (rows as unknown as MemoryRecordRow[])
        .map((row) => ({ row, score: memoryRecallScore(row, query) }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score);

      const bySubject = new Map<string, MemoryRecordRow>();
      for (const candidate of scored) {
        if (!bySubject.has(candidate.row.subject)) {
          bySubject.set(candidate.row.subject, candidate.row);
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

function memoryRecallScore(row: MemoryRecordRow, query: string): number {
  const lexical = Math.max(
    textSimilarity(row.subject, query),
    textSimilarity(row.content, query),
  );
  if (lexical <= 0) return 0;

  const confirmedAt = row.lastConfirmedAt?.getTime() ?? row.validFrom.getTime();
  const ageDays = Math.max(0, (Date.now() - confirmedAt) / 86_400_000);
  const recencyBoost = 1 / (1 + ageDays / 90);
  return lexical * (1 + recencyBoost * 0.1);
}

function textSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeMemoryText(left);
  const normalizedRight = normalizeMemoryText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 1;

  const leftSet = ngrams(normalizedLeft);
  const rightSet = ngrams(normalizedRight);
  let intersection = 0;
  for (const gram of leftSet) {
    if (rightSet.has(gram)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function normalizeMemoryText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s_]+/gu, "");
}

function ngrams(value: string): Set<string> {
  if (value.length <= 3) return new Set([value]);
  const grams = new Set<string>();
  for (let index = 0; index <= value.length - 3; index += 1) {
    grams.add(value.slice(index, index + 3));
  }
  return grams;
}
