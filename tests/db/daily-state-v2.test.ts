import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { createRepository } from "../../src/db/repository.js";
import { createDailyStateService } from "../../src/domain/daily-state.js";
import { createProjectionWorker } from "../../src/domain/projection-worker.js";
import { initToolContext } from "../../src/tools/context.js";
import { createCycleEngine } from "../../src/training/cycle-engine.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("DailyHealthState V2", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  const localDate = "2026-08-26";
  let ctx: Awaited<ReturnType<typeof initToolContext>>;

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId: `daily-state-v2-${randomUUID()}`,
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
  });

  afterAll(async () => {
    const userId = ctx.userId;
    await db.delete(schema.dailyHealthStateProjection)
      .where(eq(schema.dailyHealthStateProjection.userId, userId));
    await db.delete(schema.projectionCheckpoints)
      .where(eq(schema.projectionCheckpoints.checkpointKey, `${userId}:${localDate}`));
    await db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.userId, userId));
    await db.delete(schema.healthObservationEvents)
      .where(eq(schema.healthObservationEvents.userId, userId));
    await db.delete(schema.userDecisionEvents)
      .where(eq(schema.userDecisionEvents.userId, userId));
    await db.delete(schema.trainingReflections)
      .where(eq(schema.trainingReflections.userId, userId));
    await db.delete(schema.trainingSetLogs).where(sql`
      ${schema.trainingSetLogs.sessionExerciseId} IN (
        SELECT exercise.id
        FROM ${schema.trainingSessionExercises} exercise
        JOIN ${schema.trainingSessions} session ON session.id = exercise.session_id
        WHERE session.user_id = ${userId}::uuid
      )
    `);
    await db.delete(schema.trainingSessionExercises).where(sql`
      ${schema.trainingSessionExercises.sessionId} IN (
        SELECT id FROM ${schema.trainingSessions} WHERE user_id = ${userId}::uuid
      )
    `);
    await db.delete(schema.trainingSessions).where(eq(schema.trainingSessions.userId, userId));
    await db.delete(schema.mealPlanEntries).where(eq(schema.mealPlanEntries.userId, userId));
    await db.delete(schema.bmrProfiles).where(eq(schema.bmrProfiles.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await ctx.close();
    await pool.end({ timeout: 3 });
  });

  it("uses the latest non-revoked same-day corrections in state and cycle readiness", async () => {
    const service = createDailyStateService(ctx.db!, createRepository(ctx.db!));

    for (const observation of [
      { kind: "sleep" as const, valueJson: { hours: 4.5 } },
      { kind: "sleep" as const, valueJson: { hours: 8 } },
      { kind: "fatigue" as const, valueJson: { level: 5, scope: "general" } },
      { kind: "fatigue" as const, valueJson: { level: 1, scope: "general" } },
      { kind: "weight" as const, valueJson: { kilograms: 82.4 } },
      { kind: "weight" as const, valueJson: { kilograms: 81.8 } },
    ]) {
      await service.recordObservation({
        userId: ctx.userId,
        observedOn: localDate,
        ...observation,
      }, { commandType: "observation.record", aggregateType: "observation" });
    }

    const state = await service.persistDailyProjection(ctx.userId, localDate, "Asia/Shanghai");
    expect(state.schemaVersion).toBe("daily-health-state.v2");
    expect(state.body.effectiveSleep?.valueJson).toEqual({ hours: 8 });
    expect(state.body.effectiveFatigue?.valueJson).toEqual({ level: 1, scope: "general" });
    expect(state.body.effectiveWeight?.valueJson).toEqual({ kilograms: 81.8 });
    expect(state.body.observationHistory).toHaveLength(6);
    expect(state.training.recommendation).toMatchObject({
      decision: "A",
      reasonCodes: expect.arrayContaining(["sleep_8h_ok"]),
    });

    const decision = await createCycleEngine(ctx.db!).decide(ctx.userId, localDate);
    expect(decision.decision).toBe("A");
    expect(decision.reasonCodes).toContain("sleep_8h_ok");
    expect(decision.reasonCodes.some((code) => code.startsWith("fatigue_high_general"))).toBe(false);
  });

  it("selects an in-progress session while preserving every same-day session summary", async () => {
    const [interrupted, completed, inProgress, cancelled] = await db.insert(schema.trainingSessions).values([
      {
        userId: ctx.userId,
        sessionDate: localDate,
        status: "interrupted",
        startedAt: new Date("2026-08-26T01:00:00.000Z"),
        finishedAt: new Date("2026-08-26T01:30:00.000Z"),
      },
      {
        userId: ctx.userId,
        sessionDate: localDate,
        status: "completed",
        startedAt: new Date("2026-08-26T03:00:00.000Z"),
        finishedAt: new Date("2026-08-26T04:00:00.000Z"),
      },
      {
        userId: ctx.userId,
        sessionDate: localDate,
        status: "in_progress",
        startedAt: new Date("2026-08-26T07:00:00.000Z"),
      },
      {
        userId: ctx.userId,
        sessionDate: localDate,
        status: "cancelled",
        startedAt: new Date("2026-08-26T08:00:00.000Z"),
      },
    ]).returning();
    if (!interrupted || !completed || !inProgress || !cancelled) {
      throw new Error("session setup failed");
    }

    const service = createDailyStateService(ctx.db!, createRepository(ctx.db!));
    const state = await service.persistDailyProjection(ctx.userId, localDate, "Asia/Shanghai");

    expect(state.training.activeSessionId).toBe(inProgress.id);
    expect(state.training.sessions.map((session) => session.id)).toEqual([
      interrupted.id,
      completed.id,
      inProgress.id,
      cancelled.id,
    ]);
    expect(state.training.sessions.find((session) => session.id === cancelled.id)?.status)
      .toBe("cancelled");

    await db.update(schema.trainingSessions)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(schema.trainingSessions.id, inProgress.id));
    const completedFallback = await service.persistDailyProjection(
      ctx.userId,
      localDate,
      "Asia/Shanghai",
    );
    expect(completedFallback.training.activeSessionId).toBe(completed.id);

    await db.update(schema.trainingSessions)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(schema.trainingSessions.id, completed.id));
    const interruptedFallback = await service.persistDailyProjection(
      ctx.userId,
      localDate,
      "Asia/Shanghai",
    );
    expect(interruptedFallback.training.activeSessionId).toBe(interrupted.id);
  });

  it("keeps the original set budget across an exercise substitution lineage", async () => {
    const [session] = await db.insert(schema.trainingSessions).values({
      userId: ctx.userId,
      sessionDate: localDate,
      status: "in_progress",
      startedAt: new Date("2026-08-26T09:00:00.000Z"),
    }).returning();
    if (!session) throw new Error("lineage session setup failed");

    const [original] = await db.insert(schema.trainingSessionExercises).values({
      sessionId: session.id,
      exerciseSlug: "barbell_bench_press",
      targetSets: 3,
      orderIndex: 0,
      status: "replaced",
    }).returning();
    if (!original) throw new Error("original exercise setup failed");
    const [replacement] = await db.insert(schema.trainingSessionExercises).values({
      sessionId: session.id,
      exerciseSlug: "dumbbell_bench_press",
      targetSets: 2,
      orderIndex: 0,
      replacementForId: original.id,
      status: "done",
    }).returning();
    if (!replacement) throw new Error("replacement exercise setup failed");
    await db.update(schema.trainingSessionExercises)
      .set({ replacedById: replacement.id })
      .where(eq(schema.trainingSessionExercises.id, original.id));
    await db.insert(schema.trainingSetLogs).values([
      { sessionExerciseId: original.id, setNumber: 1, reps: 8 },
      { sessionExerciseId: replacement.id, setNumber: 1, reps: 8 },
      { sessionExerciseId: replacement.id, setNumber: 2, reps: 8 },
    ]);

    const service = createDailyStateService(ctx.db!, createRepository(ctx.db!));
    const state = await service.persistDailyProjection(ctx.userId, localDate, "Asia/Shanghai");
    const summary = state.training.sessions.find((candidate) => candidate.id === session.id);

    expect(state.training.activeSessionId).toBe(session.id);
    expect(state.training.plannedSetBudget).toBe(3);
    expect(state.training.completedSetBudget).toBe(3);
    expect(summary?.plannedSetBudget).toBe(3);
    expect(summary?.completedSetBudget).toBe(3);
    expect(state.training.substitutions).toEqual([
      expect.objectContaining({
        originalExerciseId: original.id,
        replacementExerciseId: replacement.id,
        inheritedSetBudget: 2,
        originalCompletedSets: 1,
        replacementCompletedSets: 2,
      }),
    ]);
  });

  it("includes structured reflections from every same-day training session", async () => {
    const [session] = await db.insert(schema.trainingSessions).values({
      userId: ctx.userId,
      sessionDate: localDate,
      status: "completed",
      startedAt: new Date("2026-08-26T11:00:00.000Z"),
      finishedAt: new Date("2026-08-26T12:00:00.000Z"),
    }).returning();
    if (!session) throw new Error("reflection session setup failed");
    const [reflection] = await db.insert(schema.trainingReflections).values({
      userId: ctx.userId,
      sessionId: session.id,
      completedVsPlannedJson: { plannedExercises: 2, completedExercises: 2 },
      bestCueRefs: ["cue:brace"],
      unresolvedIssuesJson: [{ issue: "left-side stability" }],
      painSummaryJson: [],
      proposedAdjustmentsJson: [{ kind: "cue_change", target: "squat" }],
      nextValidationQuestions: ["下次左侧是否更稳定？"],
    }).returning();
    if (!reflection) throw new Error("reflection setup failed");

    const service = createDailyStateService(ctx.db!, createRepository(ctx.db!));
    const state = await service.persistDailyProjection(ctx.userId, localDate, "Asia/Shanghai");

    expect(state.training.reflections).toContainEqual(expect.objectContaining({
      id: reflection.id,
      sessionId: session.id,
      bestCueRefs: ["cue:brace"],
      proposedAdjustments: [{ kind: "cue_change", target: "squat" }],
    }));
    expect(state.nextAdjustments).toContainEqual(expect.objectContaining({
      kind: "validate_training_adjustment",
      detail: { question: "下次左侧是否更稳定？" },
    }));
  });

  it("combines planned meals, actual logs, deviations, and uncertain estimates", async () => {
    const [planned] = await db.insert(schema.mealPlanEntries).values({
      userId: ctx.userId,
      planDate: localDate,
      mealType: "breakfast",
      dishName: "燕麦鸡蛋早餐",
      caloriesKcal: 500,
      proteinGrams: 30,
      carbsGrams: 55,
      fatGrams: 16,
    }).returning();
    const [actual] = await db.insert(schema.dietLogs).values({
      userId: ctx.userId,
      logDate: localDate,
      mealType: "breakfast",
      description: "外食燕麦鸡蛋早餐",
      source: "nutrition_estimate",
      caloriesKcal: 620,
      proteinGrams: 25,
      carbsGrams: 70,
      fatGrams: 22,
      uncertain: true,
      estimateConfidence: 0.62,
    }).returning();
    if (!planned || !actual) throw new Error("diet state setup failed");

    const service = createDailyStateService(ctx.db!, createRepository(ctx.db!));
    const state = await service.persistDailyProjection(ctx.userId, localDate, "Asia/Shanghai");

    expect(state.diet.plannedMeals).toContainEqual(expect.objectContaining({
      id: planned.id,
      dishName: "燕麦鸡蛋早餐",
    }));
    expect(state.diet.actualLogs).toContainEqual(expect.objectContaining({
      id: actual.id,
      uncertain: true,
    }));
    expect(state.diet.plannedTotals.caloriesKcal).toBe(500);
    expect(state.diet.actualTotals.caloriesKcal).toBe(620);
    expect(state.diet.deviation.caloriesKcal).toBe(120);
    expect(state.diet.deviation.proteinGrams).toBe(-5);
    expect(state.diet.uncertainEstimates).toEqual([
      expect.objectContaining({ dietLogId: actual.id, confidence: 0.62 }),
    ]);
  });

  it("exposes dated user decisions, deterministic next adjustments, and their evidence basis", async () => {
    const [decision] = await db.insert(schema.userDecisionEvents).values({
      userId: ctx.userId,
      decisionType: "accepted",
      subjectJson: {
        type: "diet_plan_adjustment",
        observedOn: localDate,
        action: "reduce_remaining_meal",
      },
      journeyId: "journey-daily-state-v2",
    }).returning();
    if (!decision) throw new Error("decision setup failed");

    const service = createDailyStateService(ctx.db!, createRepository(ctx.db!));
    const state = await service.persistDailyProjection(ctx.userId, localDate, "Asia/Shanghai");

    expect(state.userDecisions).toContainEqual(expect.objectContaining({
      id: decision.id,
      decisionType: "accepted",
      subject: expect.objectContaining({ action: "reduce_remaining_meal" }),
    }));
    expect(state.nextAdjustments).toContainEqual(expect.objectContaining({
      kind: "rebalance_remaining_diet",
      reasonCode: "diet_actual_above_plan",
    }));
    expect(state.nextAdjustments).toContainEqual(expect.objectContaining({
      kind: "review_uncertain_estimate",
    }));
    expect(state.basis).toContainEqual(expect.objectContaining({
      type: "user_decision",
      id: decision.id,
    }));
  });

  it("reports pending and dead-letter projection events in the authoritative state", async () => {
    const service = createDailyStateService(ctx.db!, createRepository(ctx.db!));
    await service.persistDailyProjection(ctx.userId, localDate, "Asia/Shanghai");
    await db.insert(schema.outboxEvents).values({
      userId: ctx.userId,
      aggregateType: "observation",
      aggregateId: "daily-state-v2-dead-letter",
      eventType: "observation.recorded",
      payloadJson: { observedOn: localDate },
      status: "dead_letter",
      attempts: 5,
      lastError: "forced test failure",
    });

    const state = await service.getDailyProjection(ctx.userId, localDate);

    expect(state?.projection.status).toBe("failed");
    expect(state?.projection.pendingEvents).toBeGreaterThan(0);
    expect(state?.projection.deadLetterEvents).toBe(1);
  });

  it("rebuilds V2 from facts without changing its domain content", async () => {
    const repo = createRepository(ctx.db!);
    const service = createDailyStateService(ctx.db!, repo);
    const first = await service.persistDailyProjection(ctx.userId, localDate, "Asia/Shanghai");

    await createProjectionWorker(ctx.db!, repo).rebuildUserProjection(ctx.userId, localDate);
    const rebuilt = await service.getDailyProjection(ctx.userId, localDate);
    if (!rebuilt) throw new Error("rebuilt state missing");

    const stableContent = (state: typeof rebuilt) => ({
      ...state,
      revision: 0,
      projection: {
        ...state.projection,
        builtAt: "stable",
      },
    });
    expect(rebuilt.revision).toBe(first.revision + 1);
    expect(stableContent(rebuilt)).toEqual(stableContent({
      ...first,
      projection: {
        ...first.projection,
        pendingEvents: rebuilt.projection.pendingEvents,
        pendingOutboxEvents: rebuilt.projection.pendingOutboxEvents,
      },
    }));
  });
});
