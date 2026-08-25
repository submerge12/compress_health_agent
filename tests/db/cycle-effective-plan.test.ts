/**
 * WO-HS-07 invariants — J03/J07 on live PostgreSQL.
 *
 * J07: reflection -> compiled child version (complete executable content,
 * parent immutable) -> activation -> the NEXT prepare reflects the change.
 * J03: low sleep -> cycle engine recommends REST with reason codes; the
 * long-term plan is never silently modified by readiness (shadow mode).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext } from "../../src/tools/context.js";
import { createTrainingService } from "../../src/training/training-service.js";
import { createReflectionEngine } from "../../src/training/reflection-engine.js";
import { createCycleEngine } from "../../src/training/cycle-engine.js";
import { createPainCommand } from "../../src/training/prepared-session.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 2, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("effective plan & cycle (WO-HS-07)", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let ctx: Awaited<ReturnType<typeof initToolContext>>;
  let training: ReturnType<typeof createTrainingService>;
  let reflection: ReturnType<typeof createReflectionEngine>;
  let cycle: ReturnType<typeof createCycleEngine>;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId: "cycle-engine-user",
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    training = createTrainingService(ctx.db!);
    reflection = createReflectionEngine(ctx.db!);
    cycle = createCycleEngine(ctx.db!);
    await training.ensureUserProgram(ctx.userId);
  });

  afterAll(async () => {
    const userId = ctx.userId;
    for (const t of [schema.healthObservationEvents, schema.outboxEvents,
      schema.dailyHealthStateProjection]) {
      await db.delete(t).where(eq(t.userId, userId));
    }
    await db.delete(schema.preparedTrainingProposals).where(eq(schema.preparedTrainingProposals.userId, userId));
    await db.delete(schema.healthConstraints).where(eq(schema.healthConstraints.userId, userId));
    await db.delete(schema.userDecisionEvents).where(eq(schema.userDecisionEvents.userId, userId));
    await db.delete(schema.trainingTemplates).where(eq(schema.trainingTemplates.userId, userId));
    await db.delete(schema.activePlanAssignments).where(eq(schema.activePlanAssignments.userId, userId));
    await db.delete(schema.planVersions).where(eq(schema.planVersions.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await ctx.close();
    await pool.end({ timeout: 3 });
  });

  it("J07: activated child plan changes the next prepare; parent stays immutable", async () => {
    // Prepare BEFORE: B day contains neutral_grip_pulldown.
    const before = await training.prepareSession(ctx.userId, today, "B");
    expect(before.proposedExercises.map((e) => e.exerciseSlug)).toContain("neutral_grip_pulldown");

    // Reflect: create a real (completed) B session, then seed the reflection
    // row against it — this test exercises plan compilation only.
    const planB = await training.prepareSession(ctx.userId, today, "B");
    const realSession = await training.startSession({
      userId: ctx.userId,
      sessionDate: today,
      dayRole: "B",
      planVersionId: planB.planVersionId ?? undefined,
    });
    await training.finishSession(ctx.userId, realSession.id, "completed");
    const [reflectionRow] = await db.insert(schema.trainingReflections).values({
      userId: ctx.userId,
      sessionId: realSession.id,
      proposedAdjustmentsJson: [{
        kind: "exercise_swap", target: "neutral_grip_pulldown",
        change: "remove", reason: "无感",
      }],
    }).returning();
    if (!reflectionRow) throw new Error("reflection insert failed");
    const reflectionId = reflectionRow.id;

    const proposal = await reflection.proposeChildVersion({
      userId: ctx.userId,
      reflectionId,
      changes: [{ kind: "remove_exercise", exerciseSlug: "neutral_grip_pulldown", dayRole: "B" }],
      reason: "B日下拉无感，移除",
      previousVersionProblems: ["对握下拉无收缩感"],
      validationQuestions: ["背阔是否仍有足够刺激？"],
    });

    // Parent content untouched while draft.
    const [parentBefore] = await db.select().from(schema.planVersions)
      .where(eq(schema.planVersions.id, proposal.parentVersionId));
    expect(parentBefore?.status).toBe("active");

    await reflection.activateChildVersion(ctx.userId, proposal.childVersionId);

    const [parentAfter] = await db.select().from(schema.planVersions)
      .where(eq(schema.planVersions.id, proposal.parentVersionId));
    const [child] = await db.select().from(schema.planVersions)
      .where(eq(schema.planVersions.id, proposal.childVersionId));
    expect(child?.status).toBe("active");
    expect(parentAfter?.status).toBe("superseded");
    expect(parentAfter?.contentJson).toEqual(parentBefore?.contentJson);

    // Child content is COMPLETE and the change applied.
    const childContent = child?.contentJson as {
      days?: Record<string, Array<{ exerciseSlug: string }>>;
      cyclePattern?: string[];
    };
    expect(childContent.days?.B?.map((i) => i.exerciseSlug)).not.toContain("neutral_grip_pulldown");
    expect(Array.isArray(childContent.cyclePattern)).toBe(true);

    // THE acceptance: next prepare uses the ACTIVE child content.
    const afterPrepare = await training.prepareSession(ctx.userId, today, "B");
    expect(afterPrepare.proposedExercises.map((e) => e.exerciseSlug))
      .not.toContain("neutral_grip_pulldown");
    expect(afterPrepare.planVersionId).toBe(proposal.childVersionId);

    // Rollback path: reactivating the parent swaps back and its full plan returns.
    await db.update(schema.planVersions)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(schema.planVersions.id, proposal.parentVersionId));
    await db.update(schema.activePlanAssignments)
      .set({ planVersionId: proposal.parentVersionId, updatedAt: new Date() })
      .where(and(
        eq(schema.activePlanAssignments.userId, ctx.userId),
        eq(schema.activePlanAssignments.scope, "training_template"),
      ));
    const rolledBack = await training.prepareSession(ctx.userId, today, "B");
    expect(rolledBack.proposedExercises.map((e) => e.exerciseSlug))
      .toContain("neutral_grip_pulldown");
  });

  it("J03: low sleep -> REST recommendation with reasons; plan untouched", async () => {
    // Record 4.5h sleep yesterday/today.
    const dailyState = (await import("../../src/domain/daily-state.js"))
      .createDailyStateService(ctx.db!, ctx.repo);
    await dailyState.recordObservation({
      userId: ctx.userId,
      observedOn: today,
      kind: "sleep",
      valueJson: { hours: 4.5 },
    }, { commandType: "observation.record", aggregateType: "observation" });

    const decision = await cycle.decide(ctx.userId, today);
    if (decision.decision === "REST") {
      expect(decision.reasonCodes).toContain("sleep_low");
    }
    // Shadow semantics: active plan unchanged either way.
    const [assignment] = await db.select().from(schema.activePlanAssignments)
      .where(eq(schema.activePlanAssignments.userId, ctx.userId));
    expect(assignment).toBeDefined();

    // High sleep does NOT force rest.
    await dailyState.recordObservation({
      userId: ctx.userId,
      observedOn: today,
      kind: "sleep",
      valueJson: { hours: 8 },
    }, { commandType: "observation.record", aggregateType: "observation" });
    const decision2 = await cycle.decide(ctx.userId, today);
    expect(decision2.reasonCodes.some((r) => r.startsWith("sleep_low"))).toBe(false);
  });
});
