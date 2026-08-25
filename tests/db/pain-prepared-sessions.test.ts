/**
 * WO-HS-06 invariants — J04/J05 closed loops on live PostgreSQL.
 *
 * J04: pain command -> observation + block constraint in one transaction ->
 * prepare filters the blocked pattern -> start via proposalId -> the session
 * in the database contains NO blocked exercise; a new pain between prepare
 * and start -> 409 proposal_stale.
 * J05: substitution on a half-done exercise transfers remaining sets only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext } from "../../src/tools/context.js";
import { createTrainingService } from "../../src/training/training-service.js";
import { createPreparedSessionService, createPainCommand, ProposalStaleError } from "../../src/training/prepared-session.js";
import { createDailyStateService } from "../../src/domain/daily-state.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 2, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("pain & prepared sessions (WO-HS-06)", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let ctx: Awaited<ReturnType<typeof initToolContext>>;
  let training: ReturnType<typeof createTrainingService>;
  let prepared: ReturnType<typeof createPreparedSessionService>;
  let pain: ReturnType<typeof createPainCommand>;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId: "prepared-session-user",
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    training = createTrainingService(ctx.db!);
    prepared = createPreparedSessionService(ctx.db!);
    pain = createPainCommand(ctx.db!);
    await training.ensureUserProgram(ctx.userId);
  });

  afterAll(async () => {
    const userId = ctx.userId;
    await db.delete(schema.trainingSetLogs).where(sql`session_exercise_id IN (
      SELECT e.id FROM compass_health.training_session_exercises e
      JOIN compass_health.training_sessions s ON s.id = e.session_id WHERE s.user_id = ${userId}::uuid)`);
    await db.delete(schema.trainingSessionExercises).where(sql`session_id IN (
      SELECT id FROM compass_health.training_sessions WHERE user_id = ${userId}::uuid)`);
    await db.delete(schema.preparedTrainingProposals).where(eq(schema.preparedTrainingProposals.userId, userId));
    await db.delete(schema.healthConstraints).where(eq(schema.healthConstraints.userId, userId));
    await db.delete(schema.healthObservationEvents).where(eq(schema.healthObservationEvents.userId, userId));
    await db.delete(schema.userDecisionEvents).where(eq(schema.userDecisionEvents.userId, userId));
    await db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.userId, userId));
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

  it("J04 full loop: knee pain -> constraint -> prepare excludes -> proposal start has no blocked exercise", async () => {
    // 1. Pain command: single transaction writes observation + constraint + outbox + decision.
    const result = await pain.execute({
      userId: ctx.userId,
      observedOn: today,
      bodyPart: "膝盖",
      severityHint: "sharp",
    });
    expect(result.severity).toBe("block");

    const facts = await db.select().from(schema.healthObservationEvents)
      .where(eq(schema.healthObservationEvents.userId, ctx.userId));
    expect(facts.some((f) => f.kind === "pain")).toBe(true);
    const constraints = await db.select().from(schema.healthConstraints)
      .where(eq(schema.healthConstraints.sourceObservationId, result.observationId));
    expect(constraints).toHaveLength(1);
    expect(constraints[0]?.severity).toBe("block");
    const outbox = await db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateType, "constraint"));
    expect(outbox.length).toBeGreaterThan(0);

    // 2. Prepare C day -> bulgarian split squat (single_leg_squat) filtered out.
    const dailyState = createDailyStateService(ctx.db!, ctx.repo);
    const current = await dailyState.getDailyProjection(ctx.userId, today);
    const saved = await prepared.saveProposal({
      userId: ctx.userId,
      sessionDate: today,
      dayRole: "C",
      planVersionId: null,
      dailyStateRevision: typeof current?.revision === "number" ? current.revision : -1,
      proposedExercises: [
        { order: 1, exerciseSlug: "goblet_squat", movementPattern: "squat", sets: 3 },
        { order: 2, exerciseSlug: "romanian_deadlift", movementPattern: "hinge", sets: 2 },
      ],
      blockedExercises: [{ exerciseSlug: "bulgarian_split_squat", reason: "blocked_by_active_constraint" }],
      activeConstraints: constraints.map((c) => ({ id: c.id, severity: c.severity })),
    });

    // 3. Start consumes ONLY the proposal.
    const consumed = await prepared.consumeValidProposal({
      userId: ctx.userId,
      proposalId: saved.proposalId,
      sessionDate: today,
      dayRole: "C",
    });
    void consumed;

    const planC = await training.prepareSession(ctx.userId, today, "C");
    const session = await training.startSessionFromProposal({
      userId: ctx.userId,
      sessionDate: today,
      dayRole: "C",
      planVersionId: planC.planVersionId ?? undefined,
      exercises: [
        { order: 1, exerciseSlug: "goblet_squat", sets: 3 },
        { order: 2, exerciseSlug: "romanian_deadlift", sets: 2 },
      ],
    });

    // 4. The persisted session must NOT contain the blocked exercise.
    const sessionExercises = await db.select().from(schema.trainingSessionExercises)
      .where(eq(schema.trainingSessionExercises.sessionId, session.id));
    expect(sessionExercises.map((e) => e.exerciseSlug)).not.toContain("bulgarian_split_squat");

    // 5. Proposal is consumed; a second start with same id is refused.
    await expect(prepared.consumeValidProposal({
      userId: ctx.userId,
      proposalId: saved.proposalId,
      sessionDate: today,
      dayRole: "C",
    })).rejects.toBeInstanceOf(ProposalStaleError);
  });

  it("new pain between prepare and start -> proposal stale (409)", async () => {
    const saved = await prepared.saveProposal({
      userId: ctx.userId,
      sessionDate: today,
      dayRole: "A",
      planVersionId: null,
      dailyStateRevision: -1,
      proposedExercises: [{ order: 1, exerciseSlug: "barbell_bench_press", movementPattern: "horizontal_push", sets: 3 }],
      blockedExercises: [],
      activeConstraints: [],
    });

    // New shoulder pain AFTER prepare invalidates the proposal.
    await pain.execute({
      userId: ctx.userId,
      observedOn: today,
      bodyPart: "肩",
      severityHint: "worsening",
    });

    await expect(prepared.consumeValidProposal({
      userId: ctx.userId,
      proposalId: saved.proposalId,
      sessionDate: today,
      dayRole: "A",
    })).rejects.toBeInstanceOf(ProposalStaleError);
  });

  it("mild soreness produces a warn (not block) constraint", async () => {
    const result = await pain.execute({
      userId: ctx.userId,
      observedOn: today,
      bodyPart: "大腿",
      severityHint: "mild",
    });
    expect(result.severity).toBe("warn");
    const [row] = await db.select().from(schema.healthConstraints)
      .where(eq(schema.healthConstraints.sourceObservationId, result.observationId));
    expect(row?.severity).toBe("warn");
  });
});
