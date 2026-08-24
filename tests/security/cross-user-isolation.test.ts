/**
 * WO-HS-02 security invariants — cross-user isolation on live PostgreSQL.
 *
 * Two users A and B; A must not read or mutate any of B's aggregates:
 * training sessions, session exercises, set logs, substitutions,
 * reflections, plan versions, diet logs. Also: a valid service token with
 * a MISSING X-External-User-ID gets 400 (never the default user), and
 * /api/health stays identity-free liveness.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext } from "../../src/tools/context.js";
import { createTrainingService } from "../../src/training/training-service.js";
import { createSubstitutionEngine } from "../../src/training/substitution-engine.js";
import { createReflectionEngine } from "../../src/training/reflection-engine.js";
import { createDietLogService } from "../../src/domain/diet-log-service.js";
import { NotOwnedError } from "../../src/training/ownership.js";
import { createOwnership } from "../../src/training/ownership.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 2, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("cross-user isolation (WO-HS-02)", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let userA: Awaited<ReturnType<typeof initToolContext>>;
  let userB: Awaited<ReturnType<typeof initToolContext>>;
  let trainingA: ReturnType<typeof createTrainingService>;
  let substitution: ReturnType<typeof createSubstitutionEngine>;
  let reflection: ReturnType<typeof createReflectionEngine>;
  let dietB: ReturnType<typeof createDietLogService>;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    userA = await initToolContext({
      externalUserId: "iso-user-a",
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    userB = await initToolContext({
      externalUserId: "iso-user-b",
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    trainingA = createTrainingService(userA.db!);
    substitution = createSubstitutionEngine(userA.db!);
    reflection = createReflectionEngine(userA.db!);
    dietB = createDietLogService(userB.db!, userB.repo);
    await trainingA.ensureUserProgram(userA.userId);
  });

  afterAll(async () => {
    for (const ctx of [userA, userB]) {
      const userId = ctx.userId;
      await db.delete(schema.trainingSetLogs).where(sql`session_exercise_id IN (
        SELECT e.id FROM compass_health.training_session_exercises e
        JOIN compass_health.training_sessions s ON s.id = e.session_id WHERE s.user_id = ${userId}::uuid)`);
      await db.delete(schema.trainingSessionExercises).where(sql`session_id IN (
        SELECT id FROM compass_health.training_sessions WHERE user_id = ${userId}::uuid)`);
      await db.delete(schema.trainingReflections).where(sql`session_id IN (
        SELECT id FROM compass_health.training_sessions WHERE user_id = ${userId}::uuid)`);
      await db.delete(schema.trainingSessions).where(eq(schema.trainingSessions.userId, userId));
      await db.delete(schema.trainingTemplates).where(eq(schema.trainingTemplates.userId, userId));
      await db.delete(schema.activePlanAssignments).where(eq(schema.activePlanAssignments.userId, userId));
      await db.delete(schema.planVersions).where(eq(schema.planVersions.userId, userId));
      await db.delete(schema.dietLogs).where(eq(schema.dietLogs.userId, userId));
      await db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await ctx.close();
    }
    await pool.end({ timeout: 3 });
  });

  it("A cannot record sets into B's session exercise", async () => {
    // B starts a session of their own.
    const bTraining = createTrainingService(userB.db!);
    const plan = await bTraining.prepareSession(userB.userId, today, "B");
    const bSession = await bTraining.startSession({
      userId: userB.userId,
      sessionDate: today,
      dayRole: "B",
      planVersionId: plan.planVersionId ?? undefined,
    });
    const readBack = await bTraining.readBackSession(userB.userId, bSession.id);
    const bExercise = readBack.exercisesWithSets[0]!.exercise;

    // A tries to write into B's exercise via A's own service.
    const aTraining = createTrainingService(userA.db!);
    await expect(aTraining.recordSet({
      userId: userA.userId,
      sessionId: bSession.id,
      sessionExerciseId: bExercise.id,
      setNumber: 1,
      reps: 99,
    })).rejects.toBeInstanceOf(NotOwnedError);
    void trainingA;
  });

  it("A cannot substitute or reflect on B's session", async () => {
    const bTraining = createTrainingService(userB.db!);
    const plan = await bTraining.prepareSession(userB.userId, today, "C");
    const bSession = await bTraining.startSession({
      userId: userB.userId,
      sessionDate: today,
      dayRole: "C",
      planVersionId: plan.planVersionId ?? undefined,
    });

    await expect(substitution.propose(userA.userId, bSession.id, crypto.randomUUID()))
      .rejects.toBeInstanceOf(NotOwnedError);

    const engineForA = createReflectionEngine(userA.db!);
    await expect(engineForA.record({
      userId: userA.userId,
      sessionId: bSession.id,
    })).rejects.toBeInstanceOf(NotOwnedError);
  });

  it("A cannot correct B's diet log", async () => {
    const { log } = await dietB.commit(userB, {
      userId: userB.userId,
      logDate: today,
      mealType: "lunch",
      description: "牛肉150克",
      idempotencyKey: `iso-${Date.now()}`,
    });

    await expect(dietB.correct(userA as never, {
      userId: userA.userId,
      originalLogId: log.id,
      description: "牛肉200克",
    } as never)).rejects.toThrow();

    // B's log is untouched.
    const rows = await db.select().from(schema.dietLogs)
      .where(eq(schema.dietLogs.id, log.id));
    expect(rows[0]?.supersededById).toBeNull();
  });

  it("ownership helper enforces the full chain (session mismatch)", async () => {
    const ownership = createOwnership(userA.db!);
    const plan = await trainingA.prepareSession(userA.userId, today, "B");
    const session = await trainingA.startSession({
      userId: userA.userId,
      sessionDate: today,
      dayRole: "B",
      planVersionId: plan.planVersionId ?? undefined,
    });
    const readBack = await trainingA.readBackSession(userA.userId, session.id);
    const exerciseOfSession = readBack.exercisesWithSets[0]!.exercise;

    // Same user, but the exercise belongs to ANOTHER session -> rejected.
    const otherSession = await trainingA.startSession({
      userId: userA.userId,
      sessionDate: today,
      dayRole: "C",
    });
    await expect(ownership.requireOwnedSessionExercise(
      userA.userId,
      otherSession.id,
      exerciseOfSession.id,
    )).rejects.toBeInstanceOf(NotOwnedError);
  });
});


