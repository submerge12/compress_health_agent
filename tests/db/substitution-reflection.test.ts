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
import {
  createReflectionEngine,
  PlanActivationBlockedError,
  ProposalConflictError,
} from "../../src/training/reflection-engine.js";

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
    await db.delete(schema.healthConstraints).where(eq(schema.healthConstraints.userId, userId));
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

    const proposalInput = {
      userId: ctx.userId,
      reflectionId,
      changes: [{
        kind: "reorder_exercises",
        dayRole: "B",
        order: ["chest_supported_row", "single_machine_row"],
      }],
      reason: "根据本次反思调整动作顺序",
      previousVersionProblems: ["单手划船无感"],
      validationQuestions: ["顺序调整后垂直拉表现是否下降？"],
    };
    const proposal = await reflection.proposeChildVersion(proposalInput);
    expect(proposal.childVersionId).not.toBe(proposal.parentVersionId);

    // Re-propose is idempotent — same child returned.
    const again = await reflection.proposeChildVersion(proposalInput);
    expect(again.childVersionId).toBe(proposal.childVersionId);

    await expect(reflection.proposeChildVersion({
      ...proposalInput,
      reason: "同一反思下的不同提案不得静默复用",
    })).rejects.toBeInstanceOf(ProposalConflictError);

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

  it("serializes concurrent proposals and assigns distinct user-scoped version numbers", async () => {
    const sessions = await Promise.all([startBWithProgress(), startBWithProgress()]);
    await Promise.all(sessions.map(({ session }) => training.finishSession(ctx.userId, session.id, "interrupted")));
    const reflections = await Promise.all(sessions.map(({ session }, index) => reflection.record({
      userId: ctx.userId,
      sessionId: session.id,
      nextValidationQuestions: [`concurrent validation ${index + 1}`],
    })));

    const [left, right] = await Promise.all([
      reflection.proposeChildVersion({
        userId: ctx.userId,
        reflectionId: reflections[0]!.reflectionId,
        changes: [{ kind: "update_sets", dayRole: "B", exerciseSlug: "single_machine_row", sets: 4 }],
        reason: "concurrent proposal left",
      }),
      reflection.proposeChildVersion({
        userId: ctx.userId,
        reflectionId: reflections[1]!.reflectionId,
        changes: [{ kind: "update_sets", dayRole: "B", exerciseSlug: "chest_supported_row", sets: 4 }],
        reason: "concurrent proposal right",
      }),
    ]);

    expect(left.childVersionId).not.toBe(right.childVersionId);
    expect(new Set([left.versionNumber, right.versionNumber]).size).toBe(2);
  });

  it("rejects a replacement that intersects a current blocking pain constraint", async () => {
    const replacementSlug = `plan_governance_press_${process.pid}`;
    await db.insert(schema.exerciseDefinitions).values({
      slug: replacementSlug,
      nameZh: "计划治理测试推举",
      movementPattern: "horizontal_push",
      trainingPurpose: "hypertrophy",
      primaryMuscles: ["chest"],
      secondaryMuscles: ["triceps"],
      equipment: "machine",
      stabilityDemand: "low",
      rangeOfMotion: "full",
    }).onConflictDoNothing();
    const [constraint] = await db.insert(schema.healthConstraints).values({
      userId: ctx.userId,
      constraintType: "pain",
      severity: "block",
      targetJson: { movementPattern: "horizontal_push", bodyPart: "chest" },
      reason: "active chest pain test constraint",
      activeFrom: today,
    }).returning();
    try {
      const { session } = await startBWithProgress();
      await training.finishSession(ctx.userId, session.id, "interrupted");
      const { reflectionId } = await reflection.record({ userId: ctx.userId, sessionId: session.id });
      await expect(reflection.proposeChildVersion({
        userId: ctx.userId,
        reflectionId,
        changes: [{
          kind: "replace_exercise",
          dayRole: "A",
          exerciseSlug: "barbell_bench_press",
          replacementExerciseSlug: replacementSlug,
        }],
        reason: "must not evade current pain constraint",
      })).rejects.toThrow(/blocked by an active pain constraint/i);
    } finally {
      if (constraint) await db.delete(schema.healthConstraints).where(eq(schema.healthConstraints.id, constraint.id));
      await db.delete(schema.exerciseDefinitions).where(eq(schema.exerciseDefinitions.slug, replacementSlug));
    }
  });

  it("rejects an unconfirmed or unusable media segment as a cue reference", async () => {
    const [asset] = await db.insert(schema.mediaAssets).values({
      kind: "video",
      trainer: "governance-test",
      sourceRole: "technique_details",
      title: "governance cue validation",
      localPath: `governance-${process.pid}.mp4`,
      sha256: `${String(process.pid).padStart(64, "0")}`.slice(-64),
      durationMs: 60_000,
      probeStatus: "ok",
      fullDecodeStatus: "ok",
      usableVideoUntilMs: 60_000,
    }).returning();
    if (!asset) throw new Error("media asset insert failed");
    const [pairing] = await db.insert(schema.mediaPairings).values({
      videoAssetId: asset.id,
      matchMethod: "manifest",
      completeness: "complete",
      subtitleEndMs: 60_000,
      usableUntilMs: 60_000,
    }).returning();
    if (!pairing) throw new Error("media pairing insert failed");
    const [segment] = await db.insert(schema.videoSegments).values({
      pairingId: pairing.id,
      startMs: 1_000,
      endMs: 10_000,
      trainer: "governance-test",
      sourceRole: "technique_details",
      title: "draft bench cue",
      bodyPart: "chest",
      movementPattern: "horizontal_push",
      exerciseSlug: "barbell_bench_press",
      category: "correction",
      reviewStatus: "draft",
    }).returning();
    if (!segment) throw new Error("media segment insert failed");
    try {
      const { session } = await startBWithProgress();
      await training.finishSession(ctx.userId, session.id, "interrupted");
      const { reflectionId } = await reflection.record({ userId: ctx.userId, sessionId: session.id });
      await expect(reflection.proposeChildVersion({
        userId: ctx.userId,
        reflectionId,
        changes: [{
          kind: "update_cue_refs",
          dayRole: "A",
          exerciseSlug: "barbell_bench_press",
          cueRefs: [segment.id],
        }],
        reason: "draft media cannot enter a durable plan",
      })).rejects.toThrow(/not confirmed/i);
      await db.update(schema.videoSegments)
        .set({ reviewStatus: "confirmed", endMs: 70_000 })
        .where(eq(schema.videoSegments.id, segment.id));
      await expect(reflection.proposeChildVersion({
        userId: ctx.userId,
        reflectionId,
        changes: [{
          kind: "update_cue_refs",
          dayRole: "A",
          exerciseSlug: "barbell_bench_press",
          cueRefs: [segment.id],
        }],
        reason: "draft media cannot enter a durable plan",
      })).rejects.toThrow(/outside the verified media window/i);
    } finally {
      await db.delete(schema.videoSegments).where(eq(schema.videoSegments.id, segment.id));
      await db.delete(schema.mediaPairings).where(eq(schema.mediaPairings.id, pairing.id));
      await db.delete(schema.mediaAssets).where(eq(schema.mediaAssets.id, asset.id));
    }
  });

  it("allows a high-frequency draft but blocks activation without two recovery-safe cycles", async () => {
    const { session } = await startBWithProgress();
    await training.finishSession(ctx.userId, session.id, "interrupted");
    const { reflectionId } = await reflection.record({
      userId: ctx.userId,
      sessionId: session.id,
      nextValidationQuestions: ["高频周期后睡眠与疲劳是否保持稳定？"],
    });
    const proposal = await reflection.proposeChildVersion({
      userId: ctx.userId,
      reflectionId,
      changes: [{ kind: "update_cycle_pattern", cyclePattern: ["A", "B", "C", "REST"] }],
      reason: "high frequency requires recovery evidence",
    });
    const [draft] = await db.select().from(schema.planVersions)
      .where(eq(schema.planVersions.id, proposal.childVersionId));
    expect(draft?.status).toBe("draft");
    expect(draft?.contentJson).toMatchObject({
      governance: {
        reviewStatus: "activation_blocked",
        highFrequencyCycle: true,
        recoveryEvidence: {
          completedCycles: expect.any(Number),
          sufficientForHighFrequency: false,
        },
      },
    });
    await expect(reflection.activateVersion(ctx.userId, proposal.childVersionId, today))
      .rejects.toBeInstanceOf(PlanActivationBlockedError);
  });
});
