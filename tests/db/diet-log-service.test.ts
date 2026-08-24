/**
 * M05 / P3 diet logging invariants — J01 acceptance path on real PostgreSQL.
 *
 * - high-confidence description commits directly (status ok, uncertain=false)
 * - unresolved description is refused for direct commit (needs_confirmation
 *   with candidates) and never becomes a silent zero/low-confidence fact
 * - an explicit confirmed-items override commits as a reviewed fact
 * - identical idempotency key replays return the original row, no duplicate
 * - correction creates a linked revision and supersedes the original;
 *   effective-day listing excludes superseded rows
 * - expectedRevision mismatch throws state_conflict
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { createRepository } from "../../src/db/repository.js";
import { initToolContext } from "../../src/tools/context.js";
import {
  createDietLogService,
  NeedsConfirmationError,
  StateConflict,
} from "../../src/domain/diet-log-service.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("diet log v2 invariants", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  const repo = createRepository(db);
  let ctx: Awaited<ReturnType<typeof initToolContext>>;
  let service: ReturnType<typeof createDietLogService>;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId: "diet-v2-invariant-user",
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    service = createDietLogService(ctx.db!, repo);
  });

  afterAll(async () => {
    const userId = ctx.userId;
    await db.delete(schema.dietLogs).where(eq(schema.dietLogs.userId, userId));
    await db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.userId, userId));
    await db.delete(schema.dailyHealthStateProjection).where(eq(schema.dailyHealthStateProjection.userId, userId));
    await db.delete(schema.bmrProfiles).where(eq(schema.bmrProfiles.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await ctx.close();
    await pool.end({ timeout: 3 });
  });

  it("high-confidence commit persists a fact with confidence metadata and outbox event", async () => {
    const { log, replayed } = await service.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "lunch",
      description: "牛肉150克",
      source: "web",
      idempotencyKey: "j01-commit-1",
    });
    expect(replayed).toBe(false);
    expect(log.uncertain).toBe(false);
    expect(log.caloriesKcal).toBeGreaterThan(0);
    expect(log.idempotencyKey).toBe("j01-commit-1");

    const outbox = await db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, log.id));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe("diet.commit");
  });

  it("identical idempotency key replay returns the original row without duplicating", async () => {
    const first = await service.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "dinner",
      description: "牛肉150克",
      idempotencyKey: "j01-retry-key",
    });
    const second = await service.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "dinner",
      description: "牛肉150克",
      idempotencyKey: "j01-retry-key",
    });
    expect(second.replayed).toBe(true);
    expect(second.log.id).toBe(first.log.id);

    const dinners = await db.select().from(schema.dietLogs)
      .where(eq(schema.dietLogs.idempotencyKey, "j01-retry-key"));
    expect(dinners).toHaveLength(1);
  });

  it("unresolved description is refused with candidates instead of becoming a fake fact", async () => {
    await expect(service.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "snack",
      description: "zxq 完全无法理解的描述 qqp",
    })).rejects.toBeInstanceOf(NeedsConfirmationError);
  });

  it("confirmed items override commits as a reviewed fact", async () => {
    const estimate = {
      description: "确认后的食物",
      kcal: 300,
      proteinGrams: 20,
      carbsGrams: 30,
      fatGrams: 8,
      sodiumMg: 400,
      micronutrients: {
        fiberGrams: 0,
        sugarGrams: 0,
        potassiumMg: 0,
        calciumMg: 0,
        ironMg: 0,
        magnesiumMg: 0,
        zincMg: 0,
        vitaminAMcg: 0,
        vitaminCMg: 0,
        vitaminDMcg: 0,
        vitaminB12Mcg: 0,
        folateMcg: 0,
        cholesterolMg: 0,
      },
      items: [{ slug: "beef_tenderloin", grams: 100 }],
    };
    const { log } = await service.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "lunch",
      description: "确认后的食物",
      overrideEstimate: estimate,
      idempotencyKey: "j01-confirm-key",
    });
    expect(log.uncertain).toBe(false);
    expect(log.caloriesKcal).toBe(300);
  });

  it("correction creates a linked revision; effective listing excludes superseded", async () => {
    const { log } = await service.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "breakfast",
      description: "牛肉150克",
      idempotencyKey: "j01-correct-base",
    });

    const { original, revised } = await service.correct(ctx, {
      userId: ctx.userId,
      originalLogId: log.id,
      description: "牛肉200克",
      reason: "实际更多",
      idempotencyKey: "j01-correct-fix",
    });
    expect(original.id).toBe(log.id);
    expect(revised.correctionOfId).toBe(log.id);
    expect(revised.caloriesKcal).toBeGreaterThan(log.caloriesKcal);

    // Correction replay returns the same revised row.
    const replay = await service.correct(ctx, {
      userId: ctx.userId,
      originalLogId: log.id,
      description: "牛肉200克",
      idempotencyKey: "j01-correct-fix",
    });
    expect(replay.revised.id).toBe(revised.id);

    const [originalRow] = await db.select().from(schema.dietLogs).where(eq(schema.dietLogs.id, log.id));
    expect(originalRow?.supersededById).toBe(revised.id);

    const effective = await service.listEffectiveLogs(ctx.userId, today);
    const ids = effective.map((row) => row.id);
    expect(ids).toContain(revised.id);
    expect(ids).not.toContain(log.id);
  });

  it("expectedRevision mismatch raises state_conflict instead of overwriting", async () => {
    await expect(service.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "snack",
      description: "牛肉 50 克",
      expectedRevision: 999,
    })).rejects.toBeInstanceOf(StateConflict);
  });
});
