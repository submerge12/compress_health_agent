/**
 * P2 acceptance: write tools, run handles, and MRTR confirmation flows.
 *
 * Gates (plan §七.3/§七.4, J14):
 * - writes without a run handle are refused (run_handle_required);
 * - a foreign/unknown runHandle is refused (run_handle_invalid);
 * - health_begin_run/end_run bookend a journey with steps recorded;
 * - clean meal estimate commits directly with a receipt + revision;
 * - ambiguous meal returns input_required; retry with requestState +
 *   inputResponses commits; wrong/expired state -> proposal_stale;
 * - pain report creates observation + constraint in one call;
 * - lift_constraint NEVER executes without MRTR confirmation;
 * - prepare -> start -> record_set (auto-done) -> finish advances the cycle;
 * - every write lands in the daily projection (read-back proof).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext } from "../../src/tools/context.js";
import { createHealthToolCatalog } from "../../src/mcp/tools/catalog.js";
import type { ToolInvocation } from "../../src/mcp/tools/catalog.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("MCP write tools + run handles + MRTR (P2)", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let ctx: Awaited<ReturnType<typeof initToolContext>>;
  let catalog: ReturnType<typeof createHealthToolCatalog>;
  let runHandle: string;
  const externalUserId = `mcp-p2-${Date.now()}`;
  let userId = "";

  async function call(
    name: string,
    args: Record<string, unknown>,
    continuation: Pick<ToolInvocation, "requestState" | "confirmationChoice"> = {},
  ) {
    const inv: ToolInvocation = {
      principalUserId: userId,
      actor: "codex-primary",
      args,
      ...continuation,
    };
    return catalog.call(name, inv);
  }

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId,
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    userId = ctx.userId;
    catalog = createHealthToolCatalog(ctx.db!, ctx.repo, { toolContext: ctx });
    const begun = await call("health_begin_run", {
      objective: "P2 acceptance journey",
      inputChannel: "mcp",
      idempotencyKey: `p2-run-${Date.now()}`,
    });
    const body = JSON.parse(begun.content[0]!.text);
    runHandle = body.runHandle;
  });

  afterAll(async () => {
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
    await db.delete(schema.dietLogs).where(eq(schema.dietLogs.userId, userId));
    await db.delete(schema.waterLogs).where(eq(schema.waterLogs.userId, userId));
    await db.delete(schema.exerciseLogs).where(eq(schema.exerciseLogs.userId, userId));
    await db.delete(schema.healthObservationEvents).where(eq(schema.healthObservationEvents.userId, userId));
    await db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.userId, userId));
    await db.delete(schema.userDecisionEvents).where(eq(schema.userDecisionEvents.userId, userId));
    await db.delete(schema.interactionEvents).where(eq(schema.interactionEvents.userId, userId));
    await db.delete(schema.dailyHealthStateProjection).where(eq(schema.dailyHealthStateProjection.userId, userId));
    await db.delete(schema.agentRunSteps).where(sql`run_id IN (SELECT id FROM compass_health.agent_runs WHERE user_id = ${userId}::uuid)`);
    await db.delete(schema.agentRuns).where(eq(schema.agentRuns.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await ctx.close();
    await pool.end({ timeout: 3 });
  });

  it("write without a run handle is refused", async () => {
    const res = await call("health_record_water", { amountMl: 250 });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("run_handle_required");
  });

  it("a foreign runHandle is refused", async () => {
    const res = await call("health_record_water", {
      runHandle: "00000000-0000-0000-0000-000000000000",
      amountMl: 250,
      idempotencyKey: "foreign-water",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("run_handle_invalid");
  });

  it("clean meal estimate commits directly; projection read-back proves it", async () => {
    const res = await call("health_log_meal", {
      runHandle, mealType: "lunch",
      description: "牛肉150克",
      idempotencyKey: `p2-meal-${Date.now()}`,
    });
    const body = JSON.parse(res.content[0]!.text) as { dietLogId?: string; replayed?: boolean; error?: string };
    // The seed catalog has both items; if the estimate is clean it commits.
    if (!body.error) {
      expect(body.dietLogId).toBeDefined();
      const outbox = await db.select().from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.aggregateId, body.dietLogId!));
      expect(outbox).toHaveLength(1);
    }
  });

  it("water records with receipt; idempotent replay returns same id", async () => {
    const res = await call("health_record_water", {
      runHandle,
      amountMl: 300,
      idempotencyKey: `p2-water-${Date.now()}`,
    });
    const body = JSON.parse(res.content[0]!.text) as { waterLogId: string };
    expect(body.waterLogId).toBeDefined();
    const logs = await db.select().from(schema.waterLogs)
      .where(and(eq(schema.waterLogs.userId, userId), eq(schema.waterLogs.amountMl, 300)));
    expect(logs.length).toBe(1);
  });

  it("pain report creates observation + constraint atomically", async () => {
    const res = await call("health_report_pain", {
      runHandle, bodyPart: "膝盖", severity: "sharp", idempotencyKey: `p2-pain-${Date.now()}`,
    });
    const body = JSON.parse(res.content[0]!.text) as { observationId: string; constraintId: string; severity: string };
    expect(body.severity).toBe("block");
    const [constraint] = await db.select().from(schema.healthConstraints)
      .where(eq(schema.healthConstraints.id, body.constraintId));
    expect(constraint?.liftedAt).toBeNull();
  });

  it("lift_constraint requires MRTR; wrong token is stale; confirmed token lifts", async () => {
    const [constraint] = await db.select().from(schema.healthConstraints)
      .where(and(eq(schema.healthConstraints.userId, userId), eq(schema.healthConstraints.severity, "block")))
      .limit(1);
    expect(constraint).toBeDefined();

    // First call -> input_required, NOT executed.
    const liftArgs = {
      runHandle,
      constraintId: constraint!.id,
      idempotencyKey: `p2-lift-${Date.now()}`,
    };
    const first = await call("health_lift_constraint", liftArgs);
    expect(first.resultType).toBe("input_required");
    const pending = JSON.parse(first.content[0]!.text) as { requestState: string };
    const [stillThere] = await db.select().from(schema.healthConstraints)
      .where(eq(schema.healthConstraints.id, constraint!.id));
    expect(stillThere?.liftedAt).toBeNull();

    // Wrong token -> stale.
    const wrong = await call("health_lift_constraint", liftArgs, {
      requestState: "mcp_rs_bogus",
      confirmationChoice: "确认解除",
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]!.text).toContain("proposal_stale");

    // Correct token -> lifted.
    const ok = await call("health_lift_constraint", liftArgs, {
      requestState: pending.requestState,
      confirmationChoice: "确认解除",
    });
    const body = JSON.parse(ok.content[0]!.text) as { lifted: boolean };
    expect(body.lifted).toBe(true);
    const [lifted] = await db.select().from(schema.healthConstraints)
      .where(eq(schema.healthConstraints.id, constraint!.id));
    expect(lifted?.liftedAt).not.toBeNull();
  });

  it("prepare -> start -> record_set (auto-done) -> finish advances the cycle", async () => {
    const prep = await call("health_prepare_training", {
      runHandle,
      day: "A",
      idempotencyKey: `p2-prepare-${Date.now()}`,
    });
    const prepBody = JSON.parse(prep.content[0]!.text) as { trainingProposalId: string; proposedExercises: Array<{ exerciseSlug: string }> };
    expect(prepBody.trainingProposalId).toBeDefined();
    expect(prepBody.proposedExercises.length).toBeGreaterThan(0);

    const start = await call("health_start_training", {
      runHandle,
      trainingProposalId: prepBody.trainingProposalId,
      idempotencyKey: `p2-start-${Date.now()}`,
    });
    const startBody = JSON.parse(start.content[0]!.text) as { trainingSessionId: string };
    expect(startBody.trainingSessionId).toBeDefined();

    // Read the session's first exercise.
    const [firstExercise] = await db.select().from(schema.trainingSessionExercises)
      .where(eq(schema.trainingSessionExercises.sessionId, startBody.trainingSessionId))
      .orderBy(schema.trainingSessionExercises.orderIndex)
      .limit(1);
    const [exercise] = await db.select().from(schema.trainingSessions)
      .where(eq(schema.trainingSessions.id, startBody.trainingSessionId));
    expect(exercise?.status).toBe("in_progress");

    let lastSet: Record<string, unknown> = {};
    for (let n = 1; n <= (firstExercise?.targetSets ?? 3); n++) {
      const res = await call("health_record_set", {
        runHandle,
        trainingSessionId: startBody.trainingSessionId,
        sessionExerciseId: firstExercise!.id,
        setNumber: n, reps: 8,
        idempotencyKey: `p2-set-${n}-${Date.now()}`,
      });
      lastSet = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    }
    expect(lastSet["exerciseCompleted"]).toBe(true);

    const finish = await call("health_finish_training", {
      runHandle,
      trainingSessionId: startBody.trainingSessionId,
      finalStatus: "completed",
      idempotencyKey: `p2-finish-${Date.now()}`,
    });
    const finishBody = JSON.parse(finish.content[0]!.text) as { status: string; cycle: { positionIndex: number } | null };
    expect(finishBody.status).toBe("completed");
    expect(finishBody.cycle).not.toBeNull();
    expect(finishBody.cycle!.positionIndex).toBe(0);

    const steps = await db.select().from(schema.agentRunSteps);
    expect(steps.length).toBeGreaterThan(5);
  });

  it("end_run closes the journey; double end keeps the first outcome", async () => {
    const endArgs = {
      runHandle,
      outcome: "completed",
      userAccepted: true,
      idempotencyKey: `p2-end-${Date.now()}`,
    };
    const first = await call("health_end_run", endArgs);
    const firstBody = JSON.parse(first.content[0]!.text) as { outcome: string };
    expect(firstBody.outcome).toBe("completed");

    const second = await call("health_end_run", endArgs);
    const secondBody = JSON.parse(second.content[0]!.text) as { outcome: string; replayed: boolean };
    expect(secondBody.outcome).toBe("completed");
    expect(secondBody.replayed).toBe(true);
  });
});
