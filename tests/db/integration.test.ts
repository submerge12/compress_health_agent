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
    await db.delete(schema.memoryRecords).where(eq(schema.memoryRecords.userId, userId));
    await db.delete(schema.userDishes).where(eq(schema.userDishes.userId, userId));
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

  it("creates agent-owned tables in the compass_health schema", async () => {
    const rows = await pool.unsafe<{ table_schema: string; table_name: string }[]>(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema IN ('compass_health', 'public')
        AND table_name IN ('users', 'memory_records', 'food_items')
      ORDER BY table_schema, table_name
    `);

    expect(rows).toEqual(expect.arrayContaining([
      { table_schema: "compass_health", table_name: "food_items" },
      { table_schema: "compass_health", table_name: "memory_records" },
      { table_schema: "compass_health", table_name: "users" },
    ]));
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

  it("upserts and lists user dishes for the candidate library", async () => {
    const created = await repo.upsertUserDish({
      userId,
      slug: "test_onion_beef",
      name: "test onion beef",
      mealCategory: "main",
      role: "main",
      sideKind: null,
      selfContained: true,
      ingredientsJson: [{ slug: "beef_tenderloin", grams: 150 }],
      seasoningsJson: [{ slug: "light_soy_sauce" }],
      method: "stir_fry",
      caloriesKcal: 680,
      proteinGrams: 42,
      carbsGrams: 62,
      fatGrams: 20,
      sodiumMg: 640,
      source: "user",
    });

    const updated = await repo.upsertUserDish({
      ...created,
      name: "test onion beef updated",
      caloriesKcal: 700,
    });
    const rows = await repo.listUserDishes(userId);

    expect(updated.id).toBe(created.id);
    expect(rows).toEqual([
      expect.objectContaining({
        slug: "test_onion_beef",
        name: "test onion beef updated",
        mealCategory: "main",
        caloriesKcal: 700,
      }),
    ]);
  });

  it("upserts, supersedes, recalls, and retracts memory records", async () => {
    const first = await repo.upsertMemory({
      userId,
      kind: "dislike",
      subject: "cilantro",
      content: "不吃香菜",
      sourceText: "我不吃香菜",
      confidence: 1,
    });

    const confirmed = await repo.upsertMemory({
      userId,
      kind: "dislike",
      subject: "cilantro",
      content: "不吃香菜",
      sourceText: "我不吃香菜",
      confidence: 1,
    });
    expect(confirmed.id).toBe(first.id);
    expect(confirmed.timesReferenced).toBe(first.timesReferenced + 1);

    const changed = await repo.upsertMemory({
      userId,
      kind: "dislike",
      subject: "cilantro",
      content: "现在可以吃少量香菜",
      sourceText: "现在可以吃一点香菜",
      confidence: 1,
    });
    expect(changed.id).not.toBe(first.id);

    const recalled = await repo.recallMemories(userId, "香菜", { kinds: ["dislike"], limit: 5 });
    expect(recalled).toEqual([
      expect.objectContaining({
        id: changed.id,
        subject: "cilantro",
        status: "active",
      }),
    ]);

    await repo.retractMemory(userId, changed.id);
    await repo.confirmMemory(userId, first.id);
    const afterRetract = await repo.recallMemories(userId, "香菜", { kinds: ["dislike"], limit: 5 });
    expect(afterRetract).toEqual([]);
  });

  it("recalls short Chinese queries through pg_trgm across the full memory table", async () => {
    const oldRelevant = await repo.upsertMemory({
      userId,
      kind: "dislike",
      subject: "pgtrgm-cilantro",
      content: "不吃香菜",
      sourceText: "不吃香菜",
      confidence: 1,
    });
    const oldDate = new Date("2020-01-01T00:00:00.000Z");
    await db.update(schema.memoryRecords)
      .set({ validFrom: oldDate, lastConfirmedAt: oldDate, updatedAt: oldDate })
      .where(eq(schema.memoryRecords.id, oldRelevant.id));

    for (let i = 0; i < 30; i += 1) {
      await repo.upsertMemory({
        userId,
        kind: "dislike",
        subject: `pgtrgm-noise-${i}`,
        content: `最近的不相关记忆 ${i} 喜欢米饭`,
        confidence: 1,
      });
    }

    const recalled = await repo.recallMemories(userId, "香菜", { kinds: ["dislike"], limit: 3 });

    expect(recalled[0]).toEqual(expect.objectContaining({
      id: oldRelevant.id,
      subject: "pgtrgm-cilantro",
      contentNorm: "不吃香菜",
    }));

    const explain = await pool.begin(async (tx) => {
      await tx.unsafe("SET LOCAL pg_trgm.similarity_threshold = 0.08");
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      return tx.unsafe("EXPLAIN SELECT id FROM compass_health.memory_records WHERE content_norm % '香菜'");
    });

    const plan = explain.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Bitmap Index Scan|Index Scan/);
    expect(plan).toContain("memory_records_content_norm_trgm_idx");
  });

  it("recalls a fuzzy non-substring Chinese query via trigram similarity", async () => {
    await repo.upsertMemory({
      userId,
      kind: "dislike",
      subject: "pgtrgm-fuzzy-cilantro",
      content: "我不吃香菜",
      sourceText: "我不吃香菜",
      confidence: 1,
    });

    const query = "不吃香莱";
    expect("我不吃香菜").not.toContain(query);

    const recalled = await repo.recallMemories(userId, query, { kinds: ["dislike"], limit: 3 });

    expect(recalled.some((memory) => memory.subject === "pgtrgm-fuzzy-cilantro")).toBe(true);
  });

  it("hybrid recall returns semantic memories that trigram recall misses", async () => {
    const vector = (axis: number): number[] => {
      const values = Array.from({ length: 1024 }, () => 0);
      values[axis] = 1;
      return values;
    };
    const embeddings = new Map<string, number[]>([
      ["Avoids capsaicin heat.", vector(0)],
      ["Prefers plain rice.", vector(1)],
      ["mild dinner ideas", vector(0)],
    ]);
    const semanticRepo = createRepository(db, {
      embeddingClient: {
        embed: async (texts) => texts.map((text) => embeddings.get(text) ?? vector(2)),
      },
      embeddingModel: "mock-memory-embedding",
    });

    await semanticRepo.upsertMemory({
      userId,
      kind: "dislike",
      subject: "capsaicin",
      content: "Avoids capsaicin heat.",
      confidence: 1,
    });
    await semanticRepo.upsertMemory({
      userId,
      kind: "preference",
      subject: "rice",
      content: "Prefers plain rice.",
      confidence: 1,
    });

    const lexicalOnly = await repo.recallMemories(userId, "mild dinner ideas", { limit: 5 });
    expect(lexicalOnly.some((memory) => memory.subject === "capsaicin")).toBe(false);

    const recalled = await semanticRepo.recallMemories(userId, "mild dinner ideas", { limit: 5 });
    expect(recalled[0]).toEqual(expect.objectContaining({
      subject: "capsaicin",
      content: "Avoids capsaicin heat.",
    }));
  });

  it("hybrid recall dedups by subject and keeps the most recent semantic match", async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
    const semanticRepo = createRepository(db, {
      embeddingClient: {
        embed: async (texts) => texts.map(() => vector),
      },
      embeddingModel: "mock-memory-embedding",
    });
    const oldMemory = await semanticRepo.upsertMemory({
      userId,
      kind: "preference",
      subject: "spice",
      content: "Uses light chili oil.",
      confidence: 1,
    });
    const newMemory = await semanticRepo.upsertMemory({
      userId,
      kind: "note",
      subject: "spice",
      content: "Keeps dinners gentle.",
      confidence: 1,
    });
    await db.update(schema.memoryRecords)
      .set({
        validFrom: new Date("2020-01-01T00:00:00.000Z"),
        lastConfirmedAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      })
      .where(eq(schema.memoryRecords.id, oldMemory.id));
    await db.update(schema.memoryRecords)
      .set({
        validFrom: new Date("2026-07-01T00:00:00.000Z"),
        lastConfirmedAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      })
      .where(eq(schema.memoryRecords.id, newMemory.id));

    const recalled = await semanticRepo.recallMemories(userId, "gentle dinner", { limit: 5 });
    const spiceRows = recalled.filter((memory) => memory.subject === "spice");

    expect(spiceRows).toHaveLength(1);
    expect(spiceRows[0]).toEqual(expect.objectContaining({
      id: newMemory.id,
      content: "Keeps dinners gentle.",
    }));
  });
});
