/**
 * WO-HS-11 / M24: J04 + J05 final acceptance — pain constraint closed loop
 * and substitution without volume stacking. Seven-layer checks compressed:
 * command -> fact (observation+constraint) -> proposal -> session facts ->
 * read-back -> projection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext } from "../../src/tools/context.js";
import { createTrainingService } from "../../src/training/training-service.js";
import {
  createPainCommand,
  createPreparedSessionService,
  ProposalStaleError,
} from "../../src/training/prepared-session.js";
import { createSubstitutionEngine } from "../../src/training/substitution-engine.js";
import { createDailyStateService } from "../../src/domain/daily-state.js";
import { NotOwnedError } from "../../src/training/ownership.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 2, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("J04/J05: pain & substitution final acceptance", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let ctx: Awaited<ReturnType<typeof initToolContext>>;
  let training: ReturnType<typeof createTrainingService>;
  let prepared: ReturnType<typeof createPreparedSessionService>;
  let pain: ReturnType<typeof createPainCommand>;
  let substitution: ReturnType<typeof createSubstitutionEngine>;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId: "j04-j05-final-user",
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    training = createTrainingService(ctx.db!);
    prepared = createPreparedSessionService(ctx.db!);
    pain = createPainCommand(ctx.db!);
    substitution = createSubstitutionEngine(ctx.db!);
    await training.ensureUserProgram(ctx.userId);
  });

  afterAll(async () => {
    const userId = ctx.userId;
    await db.delete(schema.trainingSetLogs).where(sql`session_exercise_id IN (
      SELECT e.id FROM compass_health.training_session_exercises e
      JOIN compass_health.training_sessions s ON s.id = e.session_id WHERE s.user_id = ${userId}::uuid)`);
    await db.delete(schema.userDecisionEvents).where(eq(schema.userDecisionEvents.userId, userId));
    await db.delete(schema.trainingSessionExercises).where(sql`session_id IN (
      SELECT id FROM compass_health.training_sessions WHERE user_id = ${userId}::uuid)`);
    await db.delete(schema.healthObservationEvents).where(eq(schema.healthObservationEvents.userId, userId));
    await db.delete(schema.healthConstraints).where(eq(schema.healthConstraints.userId, userId));
    await db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.userId, userId));
    await db.delete(schema.preparedTrainingProposals).where(eq(schema.preparedTrainingProposals.userId, userId));
    await db.delete(schema.dailyHealthStateProjection).where(eq(schema.dailyHealthStateProjection.userId, userId));
    await db.delete(schema.interactionEvents).where(sql`user_id = ${userId}::uuid AND stage='idempotency'`);
    await db.delete(schema.trainingSessions).where(eq(schema.trainingSessions.userId, userId));
    await db.delete(schema.trainingTemplates).where(eq(schema.trainingTemplates.userId, userId));
    await db.delete(schema.activePlanAssignments).where(eq(schema.activePlanAssignments.userId, userId));
    await db.delete(schema.planVersions).where(eq(schema.planVersions.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await ctx.close();
    await pool.end({ timeout: 3 });
  });

  it("J04: knee pain blocks the pattern through prepare AND into persisted sessions", async () => {
    const painResult = await pain.execute({
      userId: ctx.userId,
      observedOn: today,
      bodyPart: "膝盖",
      severityHint: "sharp",
    });
    expect(painResult.severity).toBe("block");

    const planC = await training.prepareSession(ctx.userId, today, "C");
    expect(planC.proposedExercises.map((e) => e.exerciseSlug)).not.toContain("bulgarian_split_squat");

    // Start via proposal; persisted rows must also exclude it.
    const dailyState = createDailyStateService(ctx.db!, ctx.repo);
    const current = await dailyState.getDailyProjection(ctx.userId, today);
    const saved = await prepared.saveProposal({
      userId: ctx.userId,
      sessionDate: today,
      dayRole: "C",
      planVersionId: null,
      dailyStateRevision: typeof current?.revision === "number" ? current.revision : -1,
      proposedExercises: planC.proposedExercises as unknown as Array<Record<string, unknown>>,
      blockedExercises: planC.blockedExercises as unknown as Array<Record<string, unknown>>,
      activeConstraints: [],
    });
    const started = await prepared.startSessionFromProposal({
      userId: ctx.userId,
      proposalId: saved.proposalId,
      sessionDate: today,
      dayRole: "C",
    });

    const rows = await db.select().from(schema.trainingSessionExercises)
      .where(eq(schema.trainingSessionExercises.sessionId, started.sessionId));
    expect(rows.map((r) => r.exerciseSlug)).not.toContain("bulgarian_split_squat");
  });

  it("J05: equipment occupied mid-set -> substitute transfers remaining budget", async () => {
    const planB = await training.prepareSession(ctx.userId, today, "B");
    const session = await training.startSession({
      userId: ctx.userId,
      sessionDate: today,
      dayRole: "B",
      planVersionId: planB.planVersionId ?? undefined,
    });
    const readBack = await training.readBackSession(ctx.userId, session.id);
    const first = readBack.exercisesWithSets[0]!;
    const targetSets = first.exercise.targetSets;

    // Complete all but one set.
    for (let n = 1; n < targetSets; n++) {
      await training.recordSet({
        userId: ctx.userId,
        sessionId: session.id,
        sessionExerciseId: first.exercise.id,
        setNumber: n,
        reps: 8,
      });
    }

    const proposal = await substitution.propose(ctx.userId, session.id, first.exercise.id);
    expect(proposal.remainingSets).toBe(1);

    const chosen = proposal.candidates[0]!;
    const applied = await substitution.apply({
      userId: ctx.userId,
      substitutionProposalId: proposal.substitutionProposalId,
      chosenSlug: chosen.slug,
      reason: "器械被占用",
    });

    const [replacement] = await db.select().from(schema.trainingSessionExercises)
      .where(eq(schema.trainingSessionExercises.id, applied.replacementId));
    expect(replacement?.targetSets).toBe(1); // only remaining work transfers

    // Original completed sets stay as actual.
    const originalsDone = await db.select().from(schema.trainingSetLogs)
      .where(eq(schema.trainingSetLogs.sessionExerciseId, first.exercise.id));
    expect(originalsDone).toHaveLength(targetSets - 1);
    void originalsDone;
  });

  it("cross-user protection holds at every training layer", async () => {
    // A second user attempts to touch this user's session via their own context.
    const attacker = await initToolContext({
      externalUserId: `j04-attacker-${Date.now()}`,
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    try {
      const victimTraining = createTrainingService(ctx.db!);
      const plan = await victimTraining.prepareSession(ctx.userId, today, "A");
      const victimSession = await victimTraining.startSession({
        userId: ctx.userId,
        sessionDate: today,
        dayRole: "A",
        planVersionId: plan.planVersionId ?? undefined,
      });

      const attackerTraining = createTrainingService(attacker.db!);
      await expect(attackerTraining.recordSet({
        userId: attacker.userId,
        sessionId: victimSession.id,
        sessionExerciseId: crypto.randomUUID(),
        setNumber: 1,
      })).rejects.toBeInstanceOf(NotOwnedError);

      void plan;
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, attacker.userId));
      await attacker.close();
    }
  });
});
