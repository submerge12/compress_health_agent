/**
 * M07 / P4: post-training reflection → adjustment proposal → child plan
 * version. The reflection is structured (not free text), produces a PROPOSAL
 * only, and activation creates an immutable child of the parent version —
 * the parent is never modified (plan §14.4, J07).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

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
    if (!session) throw new RangeError("session not found");
    if (session.status === "in_progress") {
      throw new RangeError("finish the session before reflecting");
    }

    const exercises = await db.select().from(schema.trainingSessionExercises)
      .where(eq(schema.trainingSessionExercises.sessionId, input.sessionId));
    const completedVsPlanned = {
      plannedExercises: exercises.length,
      completedExercises: exercises.filter((e) => e.status === "done").length,
      replacedExercises: exercises.filter((e) => e.status === "replaced").length,
      skippedExercises: exercises.filter((e) => e.status === "skipped").length,
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
  }): Promise<{ childVersionId: string; parentVersionId: string; versionNumber: number }> {
    const [reflection] = await db.select().from(schema.trainingReflections)
      .where(and(
        eq(schema.trainingReflections.id, input.reflectionId),
        eq(schema.trainingReflections.userId, input.userId),
      ))
      .limit(1);
    if (!reflection) throw new RangeError("reflection not found");

    const [session] = await db.select().from(schema.trainingSessions)
      .where(eq(schema.trainingSessions.id, reflection.sessionId))
      .limit(1);

    const [parent] = await db.select().from(schema.planVersions)
      .where(and(
        eq(schema.planVersions.userId, input.userId),
        eq(schema.planVersions.scope, input.scope ?? "training_template"),
        eq(schema.planVersions.status, "active"),
      ))
      .orderBy(desc(schema.planVersions.createdAt))
      .limit(1);
    if (!parent) throw new RangeError("no active parent plan version");

    // Mark any earlier unaccepted proposal from this reflection as superseded.
    if (reflection.proposalPlanVersionId !== null) {
      return {
        childVersionId: reflection.proposalPlanVersionId,
        parentVersionId: parent.id,
        versionNumber: -1,
      }; // idempotent re-propose
    }

    const siblings = await db.select({ n: sql<number>`count(*)::int` })
      .from(schema.planVersions)
      .where(eq(schema.planVersions.parentVersionId, parent.id));

    return db.transaction(async (tx) => {
      const [child] = await tx.insert(schema.planVersions).values({
        userId: input.userId,
        scope: parent.scope,
        status: "draft",
        parentVersionId: parent.id,
        versionNumber: parent.versionNumber + 1 + (siblings[0]?.n ?? 0),
        contentJson: {
          basedOn: parent.contentJson,
          changes: input.changes,
        },
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

      return { childVersionId: child.id, parentVersionId: parent.id, versionNumber: child.versionNumber };
    });
  }

  /** Activate a draft child atomically: child→active, parent→superseded. */
  async function activateChildVersion(userId: string, childVersionId: string): Promise<void> {
    return db.transaction(async (tx) => {
      const [child] = await tx.select().from(schema.planVersions)
        .where(and(
          eq(schema.planVersions.id, childVersionId),
          eq(schema.planVersions.userId, userId),
          eq(schema.planVersions.status, "draft"),
        ))
        .limit(1);
      if (!child) throw new RangeError("draft child version not found");
      if (child.parentVersionId === null) throw new RangeError("refusing to activate a root version without review");

      await tx.update(schema.planVersions)
        .set({ status: "active", activatedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.planVersions.id, child.id));
      await tx.update(schema.planVersions)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(and(
          eq(schema.planVersions.id, child.parentVersionId),
          eq(schema.planVersions.status, "active"),
        ));
      await tx.update(schema.activePlanAssignments)
        .set({ planVersionId: child.id, updatedAt: new Date() })
        .where(and(
          eq(schema.activePlanAssignments.userId, userId),
          eq(schema.activePlanAssignments.scope, child.scope),
        ));

      await tx.update(schema.trainingReflections)
        .set({ userAcceptedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(schema.trainingReflections.proposalPlanVersionId, child.id),
          eq(schema.trainingReflections.userId, userId),
        ));
    });
  }

  return { record, proposeChildVersion, activateChildVersion };
}
