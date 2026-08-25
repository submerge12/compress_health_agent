/**
 * M07 P4 invariants — J05/J07 acceptance gates on real data.
 *
 * J05: propose → apply substitution on a half-done exercise; the replacement
 * inherits exactly the REMAINING sets; purpose volume does not grow; the
 * original keeps its completed sets as actual; decision event recorded.
 * J07: reflection → child draft version (parent untouched) → activate swaps
 * the active pointer atomically and marks the parent superseded.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext } from "../../src/tools/context.js";
import { createTrainingService } from "../../src/training/training-service.js";
import { createSubstitutionEngine } from "../../src/training/substitution-engine.js";
import { createReflectionEngine } from "../../src/training/reflection-engine.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("substitution & reflection invariants", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let ctx: Awaited<ReturnType<typeof initToolContext>>;
  let training: ReturnType<typeof createTrainingService>;
  let substitution: ReturnType<typeof createSubstitutionEngine>;
  let reflection: ReturnType<typeof createReflectionEngine>;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId: "substitution-invariant-user",
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    training = createTrainingService(ctx.db!);
    substitution = createSubstitutionEngine(ctx.db!);
    reflection = createReflectionEngine(ctx.db!);
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
    await db.delete(schema.trainingReflections).where(sql`session_id IN (
      SELECT id FROM compass_health.training_sessions WHERE user_id = ${userId}::uuid)`);
    await db.delete(schema.trainingSessions).where(eq(schema.trainingSessions.userId, userId));
    await db.delete(schema.activePlanAssignments).where(eq(schema.activePlanAssignments.userId, userId));
    await db.delete(schema.planVersions).where(eq(schema.planVersions.userId, userId));
    await db.delete(schema.trainingTemplates).where(eq(schema.trainingTemplates.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await ctx.close();
    await pool.end({ timeout: 3 });
  });

  async function startBWithProgress() {
    const plan = await training.prepareSession(ctx.userId, today, "B");
    const session = await training.startSession({
      userId: ctx.userId,
      sessionDate: today,
      dayRole: "B",
      planVersionId: plan.planVersionId ?? undefined,
    });
    const readBack = await training.readBackSession(ctx.userId, session.id);
    const first = readBack.exercisesWithSets[0]!;
    // Complete 1 of the target sets.
    await training.recordSet({
      userId: ctx.userId,
      sessionId: session.id,
      sessionExerciseId: first.exercise.id,
      setNumber: 1,
      loadValue: 25,
      loadUnit: "kg",
      reps: 10,
    });
    return { session, originalExercise: first.exercise };
  }

  it("J05: substitution transfers remaining sets only and records the decision", async () => {
    const { session, originalExercise } = await startBWithProgress();

    const proposal = await substitution.propose(ctx.userId, session.id, originalExercise.id);
    expect(proposal.remainingSets).toBe(originalExercise.targetSets - 1);
    expect(proposal.candidates.length).toBeGreaterThan(0);

    // Rejecting an unknown slug is refused while the proposal is still live.
    await expect(substitution.apply({
      userId: ctx.userId,
      substitutionProposalId: proposal.substitutionProposalId,
      chosenSlug: "not_a_candidate",
      reason: "x",
    })).rejects.toBeInstanceOf(RangeError);

    const chosen = proposal.candidates[0]!;
    const { replacementId } = await substitution.apply({
      userId: ctx.userId,
      substitutionProposalId: proposal.substitutionProposalId,
      chosenSlug: chosen.slug,
      reason: "器械被占用",
    });

    const [replacement] = await db.select().from(schema.trainingSessionExercises)
      .where(eq(schema.trainingSessionExercises.id, replacementId));
    expect(replacement?.targetSets).toBe(proposal.remainingSets); // ← no stacking
    expect(replacement?.replacementForId).toBe(originalExercise.id);

    const [originalRow] = await db.select().from(schema.trainingSessionExercises)
      .where(eq(schema.trainingSessionExercises.id, originalExercise.id));
    expect(originalRow?.status).toBe("replaced");
    expect(originalRow?.replacedById).toBe(replacement!.id);

    // Completed set stays as actual on the ORIGINAL row.
    const doneLogs = await db.select().from(schema.trainingSetLogs)
      .where(eq(schema.trainingSetLogs.sessionExerciseId, originalExercise.id));
    expect(doneLogs).toHaveLength(1);
    expect(doneLogs[0]?.setNumber).toBe(1);

    // Purpose-level planned volume unchanged: work done on the original (1)
    // plus the transferred budget (replacement target = remaining = 2)
    // equals the original planned target (3). Nothing was added.
    const doneOnOriginal = doneLogs.length;
    expect(doneOnOriginal + (replacement?.targetSets ?? 0))
      .toBe(originalExercise.targetSets);

    const decisions = await db.select().from(schema.userDecisionEvents)
      .where(eq(schema.userDecisionEvents.userId, ctx.userId));
    expect(decisions.some((d) => (d.subjectJson as Record<string, unknown>)["type"] === "exercise_substitution"))
      .toBe(true);
  });

  it("J07: reflection proposes a child draft; activation supersedes the parent atomically", async () => {
    const { session } = await startBWithProgress();
    await training.finishSession(ctx.userId, session.id, "completed");

    const { reflectionId } = await reflection.record({
      userId: ctx.userId,
      sessionId: session.id,
      bestCueRefs: ["seg-123"],
      unresolvedIssues: [{ kind: "target_muscle_not_felt", exerciseSlug: "single_machine_row" }],
      proposedAdjustments: [{
        kind: "exercise_swap",
        target: "single_machine_row",
        change: "换为胸托划船先行",
        reason: "水平拉感受更好",
        riskLevel: "low",
      }],
      nextValidationQuestions: ["下次划船时中背是否有更强收缩？"],
    });

    const proposal = await reflection.proposeChildVersion({
      userId: ctx.userId,
      reflectionId,
      changes: [{
        kind: "reorder",
        dayRole: "B",
        order: ["chest_supported_row", "single_machine_row"],
      }],
      reason: "根据本次反思调整动作顺序",
      previousVersionProblems: ["单手划船无感"],
      validationQuestions: ["顺序调整后垂直拉表现是否下降？"],
    });
    expect(proposal.childVersionId).not.toBe(proposal.parentVersionId);

    // Re-propose is idempotent — same child returned.
    const again = await reflection.proposeChildVersion({
      userId: ctx.userId,
      reflectionId,
      changes: [],
      reason: "duplicate call",
    });
    expect(again.childVersionId).toBe(proposal.childVersionId);

    // Parent content untouched while child is draft.
    const [parentBefore] = await db.select().from(schema.planVersions)
      .where(eq(schema.planVersions.id, proposal.parentVersionId));
    expect(parentBefore?.status).toBe("active");

    await reflection.activateChildVersion(ctx.userId, proposal.childVersionId);

    const [childAfter] = await db.select().from(schema.planVersions)
      .where(eq(schema.planVersions.id, proposal.childVersionId));
    const [parentAfter] = await db.select().from(schema.planVersions)
      .where(eq(schema.planVersions.id, proposal.parentVersionId));
    expect(childAfter?.status).toBe("active");
    expect(parentAfter?.status).toBe("superseded");
    // Parent content immutable.
    expect(parentAfter?.contentJson).toEqual(parentBefore?.contentJson);
    const next = await training.prepareSession(ctx.userId, today, "B");
    expect(next.planVersionId).toBe(proposal.childVersionId);
    expect(next.proposedExercises.slice(0, 2).map((exercise) => exercise.exerciseSlug)).toEqual([
      "chest_supported_row",
      "single_machine_row",
    ]);

    const [assignment] = await db.select().from(schema.activePlanAssignments)
      .where(and(
        eq(schema.activePlanAssignments.userId, ctx.userId),
        eq(schema.activePlanAssignments.scope, "training_template"),
      ));
    expect(assignment?.planVersionId).toBe(proposal.childVersionId);

    // Reflection records acceptance.
    const [reflectionRow] = await db.select().from(schema.trainingReflections)
      .where(eq(schema.trainingReflections.id, reflectionId));
    expect(reflectionRow?.userAcceptedAt).not.toBeNull();
  });
});
