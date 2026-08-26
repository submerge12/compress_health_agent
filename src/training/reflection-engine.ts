/**
 * M07 / P4: post-training reflection → adjustment proposal → child plan
 * version. The reflection is structured (not free text), produces a PROPOSAL
 * only, and activation creates an immutable child of the parent version —
 * the parent is never modified (plan §14.4, J07).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { NotOwnedError } from "./ownership.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import { createProjectionInvalidationService } from "../domain/projection-invalidation.js";
import { createUserLocalDateResolver } from "../domain/timezone.js";
import {
  compilePlanChanges,
  diffPlanContents,
  type PlanVersionDiff,
} from "./plan-change-compiler.js";

export { diffPlanContents } from "./plan-change-compiler.js";
export type { PlanChange, PlanVersionDiff } from "./plan-change-compiler.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface PlanActivationResult {
  activatedVersionId: string;
  previousVersionId: string;
  direction: "forward" | "rollback";
  effectiveFrom: string;
  affectedDates: string[];
  outboxEventIds: string[];
}

export interface ReflectionInput {
  userId: string;
  sessionId: string;
  bestCueRefs?: string[];
  unresolvedIssues?: Array<Record<string, unknown>>;
  painSummary?: Array<Record<string, unknown>>;
  /** Deterministic engine output; the model may phrase it but not invent it. */
  proposedAdjustments?: Array<{
    kind: "exercise_swap" | "volume_change" | "cycle_change" | "cue_change";
    target: string;
    change: string;
    reason: string;
    riskLevel: "low" | "medium" | "high";
  }>;
  nextValidationQuestions?: string[];
}

export function createReflectionEngine(db: Db) {
  async function record(input: ReflectionInput): Promise<{ reflectionId: string }> {
    const [session] = await db.select().from(schema.trainingSessions)
      .where(and(
        eq(schema.trainingSessions.id, input.sessionId),
        eq(schema.trainingSessions.userId, input.userId),
      ))
      .limit(1);
    if (!session) throw new NotOwnedError("training_session");
    if (session.status === "in_progress") {
      throw new RangeError("finish the session before reflecting");
    }

    const exercises = await db.select().from(schema.trainingSessionExercises)
      .where(eq(schema.trainingSessionExercises.sessionId, input.sessionId));
    // P0-4: completion is computed from logged-set FACTS, not from the
    // status column alone.
    const setCounts = await db.select({
      sessionExerciseId: schema.trainingSetLogs.sessionExerciseId,
      logged: sql<number>`count(*)::int`,
    })
      .from(schema.trainingSetLogs)
      .where(sql`${schema.trainingSetLogs.sessionExerciseId} IN (
        SELECT id FROM ${schema.trainingSessionExercises} WHERE ${schema.trainingSessionExercises.sessionId} = ${input.sessionId}
      )`)
      .groupBy(schema.trainingSetLogs.sessionExerciseId);
    const setsByExercise = new Map(setCounts.map((r) => [r.sessionExerciseId, r.logged]));
    const isComplete = (ex: typeof schema.trainingSessionExercises.$inferSelect): boolean =>
      (setsByExercise.get(ex.id) ?? 0) >= ex.targetSets;
    const completedVsPlanned = {
      plannedExercises: exercises.length,
      completedExercises: exercises.filter(isComplete).length,
      replacedExercises: exercises.filter((e) => e.status === "replaced").length,
      skippedExercises: exercises.filter((e) => !isComplete(e) && e.status !== "replaced").length,
    };

    const [created] = await db.insert(schema.trainingReflections).values({
      userId: input.userId,
      sessionId: input.sessionId,
      completedVsPlannedJson: completedVsPlanned,
      bestCueRefs: input.bestCueRefs ?? [],
      unresolvedIssuesJson: input.unresolvedIssues ?? [],
      painSummaryJson: input.painSummary ?? [],
      proposedAdjustmentsJson: input.proposedAdjustments ?? [],
      nextValidationQuestions: input.nextValidationQuestions ?? [],
    }).returning();
    if (!created) throw new Error("reflection insert returned no row");

    return { reflectionId: created.id };
  }

  /**
   * Turn accepted adjustments into a CHILD plan version (status draft). The
   * parent stays active until the user activates the child; nothing in this
   * path mutates the parent's content.
   */
  async function proposeChildVersion(input: {
    userId: string;
    reflectionId: string;
    scope?: string;
    changes: Array<Record<string, unknown>>;
    reason: string;
    previousVersionProblems?: string[];
    validationQuestions?: string[];
  }): Promise<{
    childVersionId: string;
    parentVersionId: string;
    versionNumber: number;
    diff: PlanVersionDiff;
  }> {
    const [reflection] = await db.select().from(schema.trainingReflections)
      .where(and(
        eq(schema.trainingReflections.id, input.reflectionId),
        eq(schema.trainingReflections.userId, input.userId),
      ))
      .limit(1);
    if (!reflection) throw new RangeError("reflection not found");

    if (reflection.proposalPlanVersionId !== null) {
      const [existing] = await db.select().from(schema.planVersions)
        .where(and(
          eq(schema.planVersions.id, reflection.proposalPlanVersionId),
          eq(schema.planVersions.userId, input.userId),
        ))
        .limit(1);
      if (!existing || existing.parentVersionId === null) {
        throw new RangeError("existing reflection proposal is invalid");
      }
      const content = existing.contentJson as { planDiff?: PlanVersionDiff };
      const [existingParent] = await db.select().from(schema.planVersions)
        .where(eq(schema.planVersions.id, existing.parentVersionId))
        .limit(1);
      if (!existingParent) throw new RangeError("existing proposal parent is missing");
      return {
        childVersionId: existing.id,
        parentVersionId: existing.parentVersionId,
        versionNumber: existing.versionNumber,
        diff: content.planDiff
          ?? diffPlanContents(existingParent.contentJson, existing.contentJson, []),
      };
    }

    if (input.changes.length === 0) {
      throw new RangeError("at least one plan change is required");
    }

    const [parent] = await db.select().from(schema.planVersions)
      .where(and(
        eq(schema.planVersions.userId, input.userId),
        eq(schema.planVersions.scope, input.scope ?? "training_template"),
        eq(schema.planVersions.status, "active"),
      ))
      .orderBy(desc(schema.planVersions.createdAt))
      .limit(1);
    if (!parent) throw new RangeError("no active parent plan version");

    const siblings = await db.select({ n: sql<number>`count(*)::int` })
      .from(schema.planVersions)
      .where(eq(schema.planVersions.parentVersionId, parent.id));

    const exerciseRows = await db.select({
      slug: schema.exerciseDefinitions.slug,
      nameZh: schema.exerciseDefinitions.nameZh,
      movementPattern: schema.exerciseDefinitions.movementPattern,
    }).from(schema.exerciseDefinitions);
    const compiled = compilePlanChanges(parent.contentJson, input.changes, {
      exerciseCatalog: new Map(exerciseRows.map((exercise) => [exercise.slug, exercise])),
    });
    const planDiff = compiled.diff;
    const this_contentJson = {
      ...compiled.content,
      changeSet: compiled.changes,
      planDiff,
    };

    return db.transaction(async (tx) => {
      const [child] = await tx.insert(schema.planVersions).values({
        userId: input.userId,
        scope: parent.scope,
        status: "draft",
        parentVersionId: parent.id,
        versionNumber: parent.versionNumber + 1 + (siblings[0]?.n ?? 0),
        contentJson: this_contentJson,
        adjustmentReason: input.reason,
        previousVersionProblems: input.previousVersionProblems ?? [],
        validationQuestions: input.validationQuestions ?? [],
        createdByActor: "training_reflection",
      }).returning();
      if (!child) throw new Error("child version insert returned no row");

      await tx.update(schema.trainingReflections)
        .set({
          proposalPlanVersionId: child.id,
          updatedAt: new Date(),
        })
        .where(eq(schema.trainingReflections.id, reflection.id));

      return {
        childVersionId: child.id,
        parentVersionId: parent.id,
        versionNumber: child.versionNumber,
        diff: planDiff,
      };
    });
  }

  /** Activate a direct child or roll back to its direct parent atomically. */
  async function activateVersion(
    userId: string,
    targetVersionId: string,
    effectiveFrom?: string,
  ): Promise<PlanActivationResult> {
    return db.transaction(async (tx) => {
      const [targetIdentity] = await tx.select({ scope: schema.planVersions.scope })
        .from(schema.planVersions)
        .where(and(
          eq(schema.planVersions.id, targetVersionId),
          eq(schema.planVersions.userId, userId),
        ))
        .limit(1);
      if (!targetIdentity) throw new RangeError("target plan version not found");
      const [assignment] = await tx.select().from(schema.activePlanAssignments)
        .where(and(
          eq(schema.activePlanAssignments.userId, userId),
          eq(schema.activePlanAssignments.scope, targetIdentity.scope),
        ))
        .limit(1)
        .for("update");
      if (!assignment) throw new RangeError("active training plan assignment not found");
      const [current] = await tx.select().from(schema.planVersions)
        .where(and(
          eq(schema.planVersions.id, assignment.planVersionId),
          eq(schema.planVersions.userId, userId),
          eq(schema.planVersions.status, "active"),
        ))
        .limit(1);
      if (!current) throw new RangeError("active training plan version not found");
      const [target] = await tx.select().from(schema.planVersions)
        .where(and(
          eq(schema.planVersions.id, targetVersionId),
          eq(schema.planVersions.userId, userId),
        ))
        .limit(1);
      if (!target) throw new RangeError("target plan version not found");

      const direction = target.status === "draft" && target.parentVersionId === current.id
        ? "forward"
        : target.status === "superseded" && current.parentVersionId === target.id
          ? "rollback"
          : undefined;
      if (!direction) {
        throw new RangeError("target must be the active version's direct draft child or direct superseded parent");
      }

      await tx.update(schema.planVersions)
        .set({ status: "active", activatedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.planVersions.id, target.id));
      await tx.update(schema.planVersions)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(eq(schema.planVersions.id, current.id));
      await tx.update(schema.activePlanAssignments)
        .set({ planVersionId: target.id, updatedAt: new Date() })
        .where(eq(schema.activePlanAssignments.id, assignment.id));

      if (direction === "forward") {
        await tx.update(schema.trainingReflections)
          .set({ userAcceptedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(schema.trainingReflections.proposalPlanVersionId, target.id),
            eq(schema.trainingReflections.userId, userId),
          ));
      }
      const activationDate = effectiveFrom ?? await createUserLocalDateResolver(tx as unknown as Db)(userId);
      const invalidation = await createProjectionInvalidationService(tx as unknown as Db)
        .invalidateTrainingPlanFuture({
          userId,
          effectiveFrom: activationDate,
          planVersionId: target.id,
          previousVersionId: current.id,
          direction,
        });
      return {
        activatedVersionId: target.id,
        previousVersionId: current.id,
        direction,
        effectiveFrom: activationDate,
        affectedDates: invalidation.affectedDates,
        outboxEventIds: invalidation.outboxEventIds,
      };
    });
  }

  async function activateChildVersion(userId: string, childVersionId: string): Promise<void> {
    await activateVersion(userId, childVersionId);
  }

  return { record, proposeChildVersion, activateChildVersion, activateVersion };
}
