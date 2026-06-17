import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { createRepository } from "../../src/db/repository.js";
import { loadMealCatalog, loadSeasoningRecords } from "../../src/db/catalog.js";
import { calculateCaloriePlan } from "../../src/engine/calorie.js";
import type { CalorieProfile } from "../../src/engine/types.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("database integration", () => {
  const pool = postgres(DATABASE_URL, { max: 2, prepare: false });
  const db = drizzle(pool, { schema });
  const repo = createRepository(db);
  let userId: string;

  beforeAll(async () => {
    const user = await repo.findOrCreateUser("test-integration-user", { locale: "zh", timezone: "Asia/Shanghai" });
    userId = user.id;
  });

  afterAll(async () => {
    await db.delete(schema.dietLogs).where(eq(schema.dietLogs.userId, userId));
    await db.delete(schema.waterLogs).where(eq(schema.waterLogs.userId, userId));
    await db.delete(schema.exerciseLogs).where(eq(schema.exerciseLogs.userId, userId));
    await db.delete(schema.physicalConditions).where(eq(schema.physicalConditions.userId, userId));
    await db.delete(schema.mealPlanEntries).where(eq(schema.mealPlanEntries.userId, userId));
    await db.delete(schema.bmrProfiles).where(eq(schema.bmrProfiles.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end({ timeout: 3 });
  });

  it("creates and retrieves a user", async () => {
    const user = await repo.getUser(userId);
    expect(user).toBeDefined();
    expect(user!.externalId).toBe("test-integration-user");
    expect(user!.locale).toBe("zh");
  });

  it("findOrCreateUser returns same user on repeat", async () => {
    const again = await repo.findOrCreateUser("test-integration-user");
    expect(again.id).toBe(userId);
  });

  it("upserts BMR profile with correct calorie plan", async () => {
    const profile: CalorieProfile = {
      sex: "male", ageYears: 23, heightCm: 173, weightKg: 70,
      activityLevel: "lightly_active", goal: "fat_loss_moderate",
    };
    const plan = calculateCaloriePlan(profile);

    const bmr = await repo.upsertBmrProfile(userId, {
      sex: "male", ageYears: 23, heightCm: 173, weightKg: 70,
      activityLevel: "lightly_active", goal: "fat_loss_moderate",
      bmrKcal: plan.bmrKcal, tdeeKcal: plan.tdeeKcal, targetKcal: plan.targetKcal,
      proteinTargetGrams: plan.macros.proteinGrams,
      carbsTargetGrams: plan.macros.carbsGrams,
      fatTargetGrams: plan.macros.fatGrams,
    });
    expect(bmr.targetKcal).toBe(1771);
    expect(bmr.proteinTargetGrams).toBe(140);

    const latest = await repo.getLatestBmrProfile(userId);
    expect(latest).toBeDefined();
    expect(latest!.targetKcal).toBe(1771);
  });

  it("logs and retrieves diet entries", async () => {
    const log = await repo.insertDietLog({
      userId, logDate: "2026-06-17", mealType: "lunch",
      description: "葱爆牛肉 + 糙米饭",
      source: "agent",
      ingredientsJson: [{ slug: "beef_tenderloin", grams: 200 }, { slug: "brown_rice", grams: 60 }],
      seasoningsJson: [{ slug: "light_soy_sauce", grams: 10 }],
      caloriesKcal: 580, proteinGrams: 42, carbsGrams: 52, fatGrams: 18, sodiumMg: 800,
    });
    expect(log.id).toBeDefined();

    const logs = await repo.listDietLogs(userId, "2026-06-17");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.some((l) => l.description === "葱爆牛肉 + 糙米饭")).toBe(true);
  });

  it("logs water", async () => {
    const log = await repo.insertWaterLog(userId, "2026-06-17", 300);
    expect(log.amountMl).toBe(300);

    const logs = await repo.listWaterLogs(userId, "2026-06-17");
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("logs exercise", async () => {
    const log = await repo.insertExerciseLog({
      userId, logDate: "2026-06-17",
      activityType: "walking", durationMinutes: 30, caloriesBurnedKcal: 120,
      intensity: "moderate", notes: null,
    });
    expect(log.durationMinutes).toBe(30);
  });

  it("logs weight", async () => {
    const log = await repo.insertWeightLog(userId, {
      weightKg: 69.5, bodyFatPercent: null, waistCm: null, notes: "morning weigh-in",
    });
    expect(log.weightKg).toBe(69.5);
  });

  it("loads meal catalog from seeded data", async () => {
    const catalog = await loadMealCatalog(db);
    expect(catalog.foods.length).toBeGreaterThanOrEqual(32);
    expect(catalog.naturalUnits.length).toBe(35);

    const chicken = catalog.foods.find((f) => f.slug === "chicken_breast");
    expect(chicken).toBeDefined();
    expect(chicken!.kcalPer100g).toBe(118);

    const eggUnit = catalog.naturalUnits.find((u) => u.foodSlug === "egg" && u.unit === "piece");
    expect(eggUnit).toBeDefined();
    expect(eggUnit!.grams).toBe(50);
  });

  it("loads seasoning records from seeded data", async () => {
    const seasonings = await loadSeasoningRecords(db);
    expect(seasonings.length).toBe(20);

    const soy = seasonings.find((s) => s.slug === "light_soy_sauce");
    expect(soy).toBeDefined();
    expect(soy!.sodiumMgPer100g).toBe(5757);
  });

  it("inserts and retrieves meal plan entries", async () => {
    const entry = await repo.insertMealPlanEntry({
      userId, planDate: "2026-06-17", mealType: "dinner",
      dishName: "清蒸鲷鱼片", recipeSlug: "steamed_br", status: "planned",
      ingredientsJson: [{ slug: "sea_bream", grams: 200 }],
      seasoningsJson: [{ slug: "light_soy_sauce", grams: 8 }],
      caloriesKcal: 212, proteinGrams: 35.8, carbsGrams: 0, fatGrams: 6.8, sodiumMg: 460,
    });
    expect(entry.dishName).toBe("清蒸鲷鱼片");

    await repo.updateMealPlanStatus(entry.id, "followed");
    const entries = await repo.listMealPlanEntries(userId, "2026-06-17");
    const updated = entries.find((e) => e.id === entry.id);
    expect(updated?.status).toBe("followed");
  });
});
