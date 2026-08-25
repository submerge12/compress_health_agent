/**
 * WO-HS-11 / M24: J01 final acceptance — diet plan -> actual -> daily stats.
 *
 * Seven layers verified in one journey: input (commit command) -> intent
 * (meal type) -> tool (diet-log-service) -> API shape -> fact (PG row with
 * lineage) -> projection (DailyState totals) -> read-back consistency.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext } from "../../src/tools/context.js";
import {
  createDietLogService,
  NeedsConfirmationError,
} from "../../src/domain/diet-log-service.js";
import { createDailyStateService } from "../../src/domain/daily-state.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 2, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("J01: diet plan -> actual -> stats", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let ctx: Awaited<ReturnType<typeof initToolContext>>;
  let diet: ReturnType<typeof createDietLogService>;
  let state: ReturnType<typeof createDailyStateService>;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId: "j01-final-user",
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    diet = createDietLogService(ctx.db!, ctx.repo);
    state = createDailyStateService(ctx.db!, ctx.repo);
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

  it("high-confidence meal: fact + outbox + projection agree; retry idempotent", async () => {
    // Input -> tool
    const { log, replayed } = await diet.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "lunch",
      description: "牛肉150克",
      idempotencyKey: "j01-final-key",
    });
    expect(replayed).toBe(false);
    expect(log.uncertain).toBe(false);
    const kcalFirst = Number(log.caloriesKcal);
    expect(kcalFirst).toBeGreaterThan(0);

    // Fact layer: exactly one PG row for this key.
    const rows = await db.select({ n: sql<number>`count(*)::int` })
      .from(schema.dietLogs)
      .where(eq(schema.dietLogs.idempotencyKey, "j01-final-key"));
    expect(rows[0]?.n).toBe(1);

    // Outbox layer: receipt exists for the same aggregate.
    const outbox = await db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, log.id));
    expect(outbox.map((o) => o.eventType)).toContain("diet.commit");

    // Projection layer.
    const projected = await state.persistDailyProjection(ctx.userId, today, "Asia/Shanghai");
    expect(projected.dietActualCount).toBeGreaterThanOrEqual(1);

    // Retry: same key returns the same row, no duplicate fact.
    const retry = await diet.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "lunch",
      description: "牛肉150克",
      idempotencyKey: "j01-final-key",
    });
    expect(retry.replayed).toBe(true);
    expect(retry.log.id).toBe(log.id);
  });

  it("uncertain description is refused with candidates; correction lineage works", async () => {
    await expect(diet.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "dinner",
      description: "qqq 完全无法解析 zzz",
    })).rejects.toBeInstanceOf(NeedsConfirmationError);

    // Confirmed-item commit then correct it.
    const { log } = await diet.commit(ctx, {
      userId: ctx.userId,
      logDate: today,
      mealType: "lunch",
      description: "确认牛肉",
      overrideEstimate: {
        description: "确认牛肉", kcal: 200, proteinGrams: 40, carbsGrams: 0,
        fatGrams: 6, sodiumMg: 50,
        micronutrients: {
          fiberGrams: 0, sugarGrams: 0, potassiumMg: 0, calciumMg: 0, ironMg: 0,
          magnesiumMg: 0, zincMg: 0, vitaminAMcg: 0, vitaminCMg: 0, vitaminDMcg: 0,
          vitaminB12Mcg: 0, folateMcg: 0, cholesterolMg: 0,
        },
        items: [{ slug: "beef_tenderloin", grams: 100 }],
      },
      idempotencyKey: "j01-confirm-base",
    });
    const { revised } = await diet.correct(ctx, {
      userId: ctx.userId,
      originalLogId: log.id,
      description: "牛肉200克",
      reason: "称重核实",
      idempotencyKey: "j01-correct-fix",
    });

    // Statistics use the effective revision only.
    const effective = await diet.listEffectiveLogs(ctx.userId, today);
    expect(effective.map((r) => r.id)).toContain(revised.id);
    expect(effective.map((r) => r.id)).not.toContain(log.id);

    const [originalRow] = await db.select().from(schema.dietLogs).where(eq(schema.dietLogs.id, log.id));
    expect(originalRow?.supersededById).toBe(revised.id); // audit preserved
  });
});
