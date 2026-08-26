import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext } from "../../src/tools/context.js";
import { createTrainingService } from "../../src/training/training-service.js";
import { createReflectionEngine } from "../../src/training/reflection-engine.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";
const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("plan governance readiness", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let ctx: Awaited<ReturnType<typeof initToolContext>>;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId: `plan-governance-readiness-${process.pid}-${Date.now()}`,
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    await createTrainingService(ctx.db!).ensureUserProgram(ctx.userId);
  });

  afterAll(async () => {
    const userId = ctx.userId;
    await db.delete(schema.trainingCyclePositions).where(eq(schema.trainingCyclePositions.userId, userId));
    await db.delete(schema.trainingCycleInstances).where(eq(schema.trainingCycleInstances.userId, userId));
    await db.delete(schema.healthObservationEvents).where(eq(schema.healthObservationEvents.userId, userId));
    await db.delete(schema.trainingReflections).where(eq(schema.trainingReflections.userId, userId));
    await db.delete(schema.trainingSessions).where(eq(schema.trainingSessions.userId, userId));
    await db.delete(schema.activePlanAssignments).where(eq(schema.activePlanAssignments.userId, userId));
    await db.delete(schema.planVersions).where(eq(schema.planVersions.userId, userId));
    await db.delete(schema.trainingTemplates).where(eq(schema.trainingTemplates.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await ctx.close();
    await pool.end({ timeout: 3 });
  });

  it("rechecks current sleep and fatigue even after an evidence-qualified high-frequency draft", async () => {
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const [instance] = await db.insert(schema.trainingCycleInstances).values({
        userId: ctx.userId,
        status: "retired",
      }).returning();
      if (!instance) throw new Error("cycle insert failed");
      await db.insert(schema.trainingCyclePositions).values([
        {
          cycleInstanceId: instance.id,
          userId: ctx.userId,
          positionIndex: 0,
          positionRole: "A",
          status: "completed",
          positionDate: today,
        },
        {
          cycleInstanceId: instance.id,
          userId: ctx.userId,
          positionIndex: 1,
          positionRole: "REST",
          status: "skipped_rest",
          positionDate: today,
        },
      ]);
    }
    const baselineObservations = await db.insert(schema.healthObservationEvents).values([
      { userId: ctx.userId, observedOn: yesterday, kind: "sleep", valueJson: { hours: 8 } },
      { userId: ctx.userId, observedOn: today, kind: "sleep", valueJson: { hours: 8 } },
      { userId: ctx.userId, observedOn: yesterday, kind: "fatigue", valueJson: { level: 1, scope: "general" } },
      { userId: ctx.userId, observedOn: today, kind: "fatigue", valueJson: { level: 1, scope: "general" } },
    ]).returning();
    const [session] = await db.insert(schema.trainingSessions).values({
      userId: ctx.userId,
      sessionDate: today,
      status: "completed",
      finishedAt: new Date(),
    }).returning();
    if (!session || baselineObservations.length !== 4) throw new Error("readiness fixture insert failed");
    const reflection = createReflectionEngine(ctx.db!);
    const { reflectionId } = await reflection.record({
      userId: ctx.userId,
      sessionId: session.id,
      nextValidationQuestions: ["高频周期后的恢复是否持续良好？"],
    });
    const proposal = await reflection.proposeChildVersion({
      userId: ctx.userId,
      reflectionId,
      changes: [{ kind: "update_cycle_pattern", cyclePattern: ["A", "B", "C", "REST"] }],
      reason: "qualified high-frequency readiness fixture",
    });
    const [draft] = await db.select().from(schema.planVersions)
      .where(eq(schema.planVersions.id, proposal.childVersionId));
    expect(draft?.contentJson).toMatchObject({
      governance: {
        reviewStatus: "approved",
        recoveryEvidence: { completedCycles: 2, sufficientForHighFrequency: true },
      },
    });

    const [lowSleep] = await db.insert(schema.healthObservationEvents).values({
      userId: ctx.userId,
      observedOn: today,
      kind: "sleep",
      valueJson: { hours: 4.5 },
    }).returning();
    if (!lowSleep) throw new Error("low-sleep fixture insert failed");
    await expect(reflection.activateVersion(ctx.userId, proposal.childVersionId, today))
      .rejects.toMatchObject({
        code: "health_safety_block",
        reasons: expect.arrayContaining([expect.stringContaining("current low sleep")]),
      });

    await db.update(schema.healthObservationEvents)
      .set({ revokedAt: new Date() })
      .where(eq(schema.healthObservationEvents.id, lowSleep.id));
    await db.insert(schema.healthObservationEvents).values({
      userId: ctx.userId,
      observedOn: today,
      kind: "fatigue",
      valueJson: { level: 5, scope: "general" },
    });
    await expect(reflection.activateVersion(ctx.userId, proposal.childVersionId, today))
      .rejects.toMatchObject({
        code: "health_safety_block",
        reasons: expect.arrayContaining([expect.stringContaining("current high fatigue")]),
      });
  });
});
