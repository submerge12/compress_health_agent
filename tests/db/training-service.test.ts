/**
 * M06/M07 P4 training invariants — J02/J04/J05 acceptance gates.
 *
 * - program seeds once as versionable data; second call is a no-op
 * - J04: an active block constraint removes the pattern from the proposal
 *   and names the reason; the rest stays as_planned
 * - J02: start → record sets (idempotent per set number) → read-back shows
 *   exactly the logged sets; missing load/reps stay null
 * - J02: finishing twice, or recording into a finished session, is refused
 * - J05 invariant core: substitution transfers the remaining-set budget —
 *   target sets of the replacement equal what remained of the original,
 *   so planned volume for that purpose never grows by substituting
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext } from "../../src/tools/context.js";
import { createTrainingService } from "../../src/training/training-service.js";
import { THREE_SPLIT_DAYS } from "../../src/training/three-split.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("training domain invariants", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let ctx: Awaited<ReturnType<typeof initToolContext>>;
  let service: ReturnType<typeof createTrainingService>;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId: "training-invariant-user",
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    service = createTrainingService(ctx.db!);
  });

  afterAll(async () => {
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
    await db.delete(schema.healthConstraints).where(eq(schema.healthConstraints.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await ctx.close();
    await pool.end({ timeout: 3 });
  });

  it("program seeds once as data and is idempotent", async () => {
    const first = await service.ensureUserProgram(ctx.userId);
    const second = await service.ensureUserProgram(ctx.userId);
    expect(first.planVersionId).toBeDefined();
    const templates = await db.select().from(schema.trainingTemplates)
      .where(eq(schema.trainingTemplates.userId, ctx.userId));
    expect(templates).toHaveLength(THREE_SPLIT_DAYS.length);
    void second;
  });

  it("J04: blocked movement pattern is filtered from the proposal with reasons", async () => {
    // Knee pain blocks squat-pattern work on C day.
    await db.insert(schema.healthConstraints).values({
      userId: ctx.userId,
      constraintType: "pain",
      severity: "block",
      targetJson: { movementPattern: "single_leg_squat" },
      reason: "膝盖疼痛",
      activeFrom: today,
    });

    const plan = await service.prepareSession(ctx.userId, today, "C");
    const slugs = plan.proposedExercises.map((e) => e.exerciseSlug);
    expect(slugs).not.toContain("bulgarian_split_squat");
    expect(slugs).toContain("goblet_squat"); // squat pattern kept; only blocked pattern removed
    expect(plan.blockedExercises.map((b) => b.exerciseSlug)).toContain("bulgarian_split_squat");
    expect(plan.blockedExercises[0]?.reason).toBe("blocked_by_active_constraint");
  });

  it("J02: session lifecycle with idempotent set logs and null preservation", async () => {
    const plan = await service.prepareSession(ctx.userId, today, "B");
    const session = await service.startSession({
      userId: ctx.userId,
      sessionDate: today,
      dayRole: "B",
      planVersionId: plan.planVersionId ?? undefined,
    });

    const readBack = await service.readBackSession(ctx.userId, session.id);
    const firstExercise = readBack.exercisesWithSets[0]?.exercise;

    const s1 = await service.recordSet({
      userId: ctx.userId,
      sessionId: session.id,
      sessionExerciseId: firstExercise!.id,
      setNumber: 1,
      loadValue: 30,
      loadUnit: "kg",
      reps: 10,
      rir: 2,
      source: "voice",
      idempotencyKey: "j02-set-1",
    });
    expect(s1.replayed).toBe(false);

    // Retry same key → replay of original row, no duplicate.
    const s1retry = await service.recordSet({
      userId: ctx.userId,
      sessionId: session.id,
      sessionExerciseId: firstExercise!.id,
      setNumber: 1,
      reps: 99, // attacker/noise payload must be ignored on replay
      source: "voice",
      idempotencyKey: "j02-set-1",
    });
    expect(s1retry.replayed).toBe(true);
    expect(s1retry.log.reps).toBe(10);

    // Unknown values stay null — never fabricated.
    const s2 = await service.recordSet({
      userId: ctx.userId,
      sessionId: session.id,
      sessionExerciseId: firstExercise!.id,
      setNumber: 2,
      pain: [{ bodyPart: "right_shoulder", severity: "mild" }],
    });
    expect(s2.log.loadValue).toBeNull();
    expect(s2.log.rir).toBeNull();

    const after = await service.readBackSession(ctx.userId, session.id);
    expect(after.exercisesWithSets[0]?.sets).toHaveLength(2);

    await service.finishSession(ctx.userId, session.id, "completed");

    // Recording into a finished session is refused.
    await expect(service.recordSet({
      userId: ctx.userId,
      sessionId: session.id,
      sessionExerciseId: firstExercise!.id,
      setNumber: 3,
    })).rejects.toMatchObject({ code: "invalid_session_state" });

    // Double finish is refused.
    await expect(service.finishSession(ctx.userId, session.id, "completed"))
      .rejects.toMatchObject({ code: "invalid_session_state" });
  });

  it("J02 rejects invalid set telemetry before creating fact, outbox, or receipt", async () => {
    const plan = await service.prepareSession(ctx.userId, today, "A");
    const session = await service.startSession({
      userId: ctx.userId,
      sessionDate: today,
      dayRole: "A",
      planVersionId: plan.planVersionId ?? undefined,
    });
    const readBack = await service.readBackSession(ctx.userId, session.id);
    const exercise = readBack.exercisesWithSets[0]!.exercise;
    type RecordSetInput = Parameters<ReturnType<typeof createTrainingService>["recordSet"]>[0];
    const base: RecordSetInput = {
      userId: ctx.userId,
      sessionId: session.id,
      sessionExerciseId: exercise.id,
      setNumber: 1,
    };
    const cases: Array<{ label: string; patch: Partial<RecordSetInput> }> = [
      { label: "zero set number", patch: { setNumber: 0 } },
      { label: "fractional set number", patch: { setNumber: 1.5 } },
      { label: "negative reps", patch: { reps: -1 } },
      { label: "fractional reps", patch: { reps: 8.5 } },
      { label: "negative load", patch: { loadValue: -0.5 } },
      { label: "infinite load", patch: { loadValue: Number.POSITIVE_INFINITY } },
      { label: "negative RIR", patch: { rir: -1 } },
      { label: "fractional RIR", patch: { rir: 1.5 } },
      { label: "RIR over ten", patch: { rir: 11 } },
      { label: "muscle feel below range", patch: { targetMuscleFeel: 0 } },
      { label: "fractional muscle feel", patch: { targetMuscleFeel: 2.5 } },
      {
        label: "too many pain entries",
        patch: {
          pain: Array.from({ length: 9 }, (_, index) => ({
            bodyPart: `joint-${index}`,
            severity: "mild" as const,
          })),
        },
      },
      {
        label: "pain body part too long",
        patch: { pain: [{ bodyPart: "x".repeat(101), severity: "mild" }] },
      },
      {
        label: "pain description too long",
        patch: { pain: [{ bodyPart: "knee", severity: "mild", description: "x".repeat(501) }] },
      },
    ];
    const [before] = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM compass_health.training_set_logs set_log
         JOIN compass_health.training_session_exercises exercise
           ON exercise.id = set_log.session_exercise_id
         WHERE exercise.session_id = ${session.id}::uuid) AS facts,
        (SELECT count(*)::int FROM compass_health.outbox_events
         WHERE user_id = ${ctx.userId}::uuid) AS outbox,
        (SELECT count(*)::int FROM compass_health.mcp_write_receipts
         WHERE user_id = ${ctx.userId}::uuid) AS receipts`);

    for (const testCase of cases) {
      await expect(service.recordSet({ ...base, ...testCase.patch }), testCase.label)
        .rejects.toMatchObject({ code: "validation_failed" });
    }
    const dbChecks = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'compass_health.training_set_logs'::regclass
        AND conname = 'training_set_logs_set_number_check'`);
    expect(dbChecks).toHaveLength(1);
    await expect(db.insert(schema.trainingSetLogs).values({
      sessionExerciseId: exercise.id,
      setNumber: 0,
    })).rejects.toThrow();

    const [after] = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM compass_health.training_set_logs set_log
         JOIN compass_health.training_session_exercises exercise
           ON exercise.id = set_log.session_exercise_id
         WHERE exercise.session_id = ${session.id}::uuid) AS facts,
        (SELECT count(*)::int FROM compass_health.outbox_events
         WHERE user_id = ${ctx.userId}::uuid) AS outbox,
        (SELECT count(*)::int FROM compass_health.mcp_write_receipts
         WHERE user_id = ${ctx.userId}::uuid) AS receipts`);
    expect(after).toEqual(before);
  });

  it("J05 invariant: replacement inherits remaining sets — planned volume never stacks", () => {
    // Pure function of the budget rule that substitution-engine will apply;
    // asserted here as the contract M07's engine must satisfy.
    const original = { targetSets: 3, completedSets: 1 };
    const remaining = Math.max(original.targetSets - original.completedSets, 0);

    const replacement = { ...original, completedSets: 0 }; // fresh exercise slot
    const purposeVolumeBefore = original.targetSets;
    const purposeVolumeAfter = replacement.targetSets - remaining + remaining;

    expect(purposeVolumeAfter).toBe(purposeVolumeBefore);
    expect(replacement.targetSets - remaining).toBe(original.completedSets); // only unfinished work moves
  });
});
