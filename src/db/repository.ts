import { and, eq, gte, lte, desc } from "drizzle-orm";
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
  };
}

export type Repository = ReturnType<typeof createRepository>;
