/**
 * M00 / P0 journey baseline — J01..J12 characterization of the CURRENT system.
 *
 * Purpose: freeze today's behavior as executable evidence before P1+ changes.
 * - "schema baseline" tests run without a database and record which columns /
 *   tables are missing (each missing item maps to a plan work package).
 * - "live" tests run only against PostgreSQL and characterize actual handler
 *   behavior, including known gaps such as duplicate submits creating
 *   duplicate rows (no idempotency key yet — fixed by M05/P3).
 * - describe.todo blocks mark journeys whose domains do not exist yet.
 *
 * These are NOT the final acceptance tests. As P1+ lands, each todo /
 * characterization block is replaced by the real journey assertion tracked in
 * compass-health/docs/health-journeys (M00 registry).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import * as handlers from "../../src/tools/handlers.js";
import { initToolContext, type ToolContext } from "../../src/tools/context.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const BASELINE_USER = "journey-baseline-user";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

const tableNames = new Set(
  Object.values(schema)
    .filter((value) => typeof value === "function" && "getSQL" in (value as object))
    .map((table) => getTableName(table as Parameters<typeof getTableName>[0])),
);

const columnsOf = (table: (typeof schema)[keyof typeof schema]): string[] => Object.keys(table);

// ── Schema baselines (no DB required) ──────────────────────────────────────

describe("J01 baseline: diet plan vs actual (M05/P3 gaps)", () => {
  it("diet_logs now carries M05 metadata (flipped from P0 gap assertion)", () => {
    // P0 recorded these columns as missing; M05 added them. Kept as a
    // positive invariant so a future refactor cannot silently drop them.
    const cols = columnsOf(schema.dietLogs);
    for (const present of ["idempotencyKey", "estimateConfidence", "uncertain", "correctionOfId", "supersededById"]) {
      expect(cols).toContain(present);
    }
  });

  it("meal_plan_entries has no plan_version_id column (plans mutate in place)", () => {
    const cols = columnsOf(schema.mealPlanEntries);
    expect(cols).not.toContain("planVersionId");
  });
});

describe("J02 baseline: structured training (M06/P4 gaps)", () => {
  it("exercise_logs only stores coarse activity fields", () => {
    const cols = columnsOf(schema.exerciseLogs);
    for (const missing of ["exerciseId", "setNumber", "loadKg", "reps", "rir", "sessionId"]) {
      expect(cols).not.toContain(missing);
    }
  });

  it("no training domain tables exist", () => {
    for (const table of [
      "training_plan_items",
      "training_sessions",
      "training_set_logs",
      "plan_versions",
    ]) {
      expect(tableNames.has(table)).toBe(false);
    }
  });
});

describe("J03/J04 baseline: body state, fatigue, pain (M03/P2 gaps)", () => {
  it("physical_conditions has no fatigue/recovery/pain columns", () => {
    const cols = columnsOf(schema.physicalConditions);
    for (const missing of ["fatigueLevel", "recoveryLevel", "painJson"]) {
      expect(cols).not.toContain(missing);
    }
  });

  it("no observation event or constraint tables exist", () => {
    for (const table of ["health_observation_events", "health_constraints", "daily_availability_events"]) {
      expect(tableNames.has(table)).toBe(false);
    }
  });
});

describe("J09 baseline: projection/outbox (M04/P2 gaps)", () => {
  it("no outbox, checkpoint, or daily-state projection tables exist", () => {
    for (const table of ["outbox_events", "projection_checkpoints", "daily_health_state_projection"]) {
      expect(tableNames.has(table)).toBe(false);
    }
  });
});

// ── Live handler characterization (PostgreSQL required) ────────────────────

describe.skipIf(!isDbAvailable)("live journey probes", () => {
  const pool = postgres(DATABASE_URL, { max: 2, prepare: false });
  const db = drizzle(pool, { schema });
  let ctx: ToolContext;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId: BASELINE_USER,
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
  });

  afterAll(async () => {
    const userId = ctx.userId;
    await ctx.close();
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

  it("J01: agent-side plan→log→summary loop writes and reads back the same row", async () => {
    await handlers.handleSetProfile(ctx, {
      sex: "male",
      ageYears: 30,
      heightCm: 175,
      weightKg: 70,
      activityLevel: "strength_training",
      goal: "body_recomp",
    });

    const logged = await handlers.handleLogMeal(ctx, {
      date: today,
      mealType: "lunch",
      description: "牛肉 150 克",
    });
    expect(logged.source).toBe("agent");
    expect(logged.caloriesKcal).toBeGreaterThan(0);

    const summary = await handlers.handleDailySummary(ctx, { date: today });
    expect(summary.mealCount).toBe(1);
    expect(summary.eaten.kcal).toBeGreaterThan(0);
    // Known hardcoded targets in current summary (documents M03 gap).
    expect(summary.water.targetMl).toBe(2000);
    expect(summary.exercise.targetMinutes).toBe(30);
  });

  it("J01 gap: identical duplicate submit creates a duplicate fact (no idempotency)", async () => {
    const input = {
      date: today,
      mealType: "dinner",
      description: "牛肉 150 克",
    };
    await handlers.handleLogMeal(ctx, input);
    await handlers.handleLogMeal(ctx, input);

    const logs = await ctx.repo.listDietLogs(ctx.userId, today);
    const dinners = logs.filter((log) => log.mealType === "dinner");
    // Baseline documents the defect: a retry (network echo, voice repeat, double
    // tap) is indistinguishable from two meals. M05 adds Idempotency-Key.
    expect(dinners.length).toBe(2);
  });

  it("J03 baseline: only weight logging exists for body state; no sleep/fatigue/pain handler", () => {
    expect(typeof handlers.handleLogWeight).toBe("function");
    for (const absent of ["handleLogSleep", "handleLogFatigue", "handleLogPain", "handleLogCondition"]) {
      expect((handlers as Record<string, unknown>)[absent]).toBeUndefined();
    }
  });
});

// ── Journeys whose domains do not exist yet (flip to real tests in P3+) ────

describe.todo("J02: three-split session with per-set logging — training domain missing (M06/P4)");
describe.todo("J03: poor sleep adjusts the active training plan — readiness policy missing (M07/P4, needs M03 state)");
describe.todo("J04: knee pain blocks incompatible exercises — constraints missing (M03/P2 + M07/P4)");
describe.todo("J05: equipment occupied → substitution without volume stacking — engine missing (M07/P4)");
describe.todo("J06: bench-press cue retrieval from curated videos — media domain missing (M08/P5)");
describe.todo("J07: post-session reflection produces child plan version — versioning missing (M03/P2 + M07)");
describe.todo("J08: ASR mis-recognition corrected before commit — voice domain missing (M09/P6)");
describe.todo("J09: saved-but-stale dashboard located to projection stage — outbox missing (M04/P2)");
describe.todo("J10: teacher blind review catches ignored constraint — teacher profile missing (M12/P7)");
describe.todo("J11: manager sees ignored recommendations — manager projections missing (M13/P7)");
describe.todo("J12: primary-agent failure fails over to legacy agent — routing in pi_harness (M11/P3)");
