/**
 * M07 / P4: post-training reflection → adjustment proposal → child plan
 * version. The reflection is structured (not free text), produces a PROPOSAL
 * only, and activation creates an immutable child of the parent version —
 * the parent is never modified (plan §14.4, J07).
 */
import { and, eq, sql } from "drizzle-orm";
import { NotOwnedError } from "./ownership.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import { hashCanonicalJson } from "../domain/canonical-hash.js";
import { createProjectionInvalidationService } from "../domain/projection-invalidation.js";
import { createUserLocalDateResolver } from "../domain/timezone.js";
import {
  compilePlanChanges,
  diffPlanContents,
  type PlanVersionDiff,
} from "./plan-change-compiler.js";
import {
  createPlanGovernanceMetadata,
  evaluateActivationGovernance,
  loadPlanCompileContext,
  type ActivationGovernanceReview,
} from "./plan-governance.js";

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
  governanceReview: ActivationGovernanceReview;
}

export class ProposalConflictError extends Error {
  readonly code = "proposal_conflict";
  readonly statusCode = 409;

  constructor() {
    super("proposal_conflict: this reflection already has a proposal for different arguments");
  }
}

export class PlanActivationBlockedError extends Error {
  readonly code = "health_safety_block";

  constructor(readonly reasons: string[]) {
    super(`plan activation blocked: ${reasons.join("; ")}`);
  }
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
    if (input.changes.length === 0) {
      throw new RangeError("at least one plan change is required");
    }
    const scope = input.scope ?? "training_template";
    const proposalArgumentHash = hashCanonicalJson({
      scope,
      changes: input.changes,
      reason: input.reason,
      previousVersionProblems: input.previousVersionProblems ?? [],
      validationQuestions: input.validationQuestions ?? [],
    });

    return db.transaction(async (tx) => {
      const [reflection] = await tx.select().from(schema.trainingReflections)
        .where(and(
          eq(schema.trainingReflections.id, input.reflectionId),
          eq(schema.trainingReflections.userId, input.userId),
        ))
        .limit(1)
        .for("update");
      if (!reflection) throw new RangeError("reflection not found");

      const [assignment] = await tx.select().from(schema.activePlanAssignments)
        .where(and(
          eq(schema.activePlanAssignments.userId, input.userId),
          eq(schema.activePlanAssignments.scope, scope),
        ))
        .limit(1)
        .for("update");
      if (!assignment) throw new RangeError("no active plan assignment");
      const [parent] = await tx.select().from(schema.planVersions)
        .where(and(
          eq(schema.planVersions.id, assignment.planVersionId),
          eq(schema.planVersions.userId, input.userId),
          eq(schema.planVersions.scope, scope),
          eq(schema.planVersions.status, "active"),
        ))
        .limit(1);
      if (!parent) throw new RangeError("no active parent plan version");

      if (reflection.proposalPlanVersionId !== null) {
        if (reflection.proposalArgumentHash !== proposalArgumentHash) throw new ProposalConflictError();
        const [existing] = await tx.select().from(schema.planVersions)
          .where(and(
            eq(schema.planVersions.id, reflection.proposalPlanVersionId),
            eq(schema.planVersions.userId, input.userId),
            eq(schema.planVersions.scope, scope),
          ))
          .limit(1);
        if (!existing || existing.parentVersionId === null) {
          throw new RangeError("existing reflection proposal is invalid");
        }
        const content = existing.contentJson as { planDiff?: PlanVersionDiff };
        const [existingParent] = await tx.select().from(schema.planVersions)
          .where(and(
            eq(schema.planVersions.id, existing.parentVersionId),
            eq(schema.planVersions.userId, input.userId),
          ))
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

      const [versionCursor] = await tx.select({
        next: sql<number>`coalesce(max(${schema.planVersions.versionNumber}), 0)::int + 1`,
      }).from(schema.planVersions).where(and(
        eq(schema.planVersions.userId, input.userId),
        eq(schema.planVersions.scope, scope),
      ));
      const nextVersionNumber = versionCursor?.next;
      if (!nextVersionNumber) throw new Error("could not allocate next plan version number");

      const localDate = await createUserLocalDateResolver(tx as unknown as Db)(input.userId);
      const compileContext = await loadPlanCompileContext({
        db: tx as unknown as Db,
        userId: input.userId,
        onDate: localDate,
        reflection,
        changes: input.changes,
      });
      const compiled = compilePlanChanges(parent.contentJson, input.changes, compileContext);
      const governance = await createPlanGovernanceMetadata({
        db: tx as unknown as Db,
        userId: input.userId,
        onDate: localDate,
        parentVersionId: parent.id,
        proposalArgumentHash,
        diff: compiled.diff,
        requestedValidationQuestions: [
          ...(input.validationQuestions ?? []),
          ...reflection.nextValidationQuestions,
        ],
      });
      const planDiff = compiled.diff;
      const contentJson = {
        ...compiled.content,
        changeSet: compiled.changes,
        planDiff,
        governance,
      };
      const [child] = await tx.insert(schema.planVersions).values({
        userId: input.userId,
        scope: parent.scope,
        status: "draft",
        parentVersionId: parent.id,
        versionNumber: nextVersionNumber,
        contentJson,
        adjustmentReason: input.reason,
        previousVersionProblems: input.previousVersionProblems ?? [],
        validationQuestions: governance.validationQuestions,
        createdByActor: "training_reflection",
      }).returning();
      if (!child) throw new Error("child version insert returned no row");

      await tx.update(schema.trainingReflections)
        .set({
          proposalPlanVersionId: child.id,
          proposalArgumentHash,
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

  async function reviewTransition(
    database: Db,
    userId: string,
    current: typeof schema.planVersions.$inferSelect,
    target: typeof schema.planVersions.$inferSelect,
    direction: "forward" | "rollback",
    effectiveFrom: string,
  ): Promise<ActivationGovernanceReview> {
    const targetContent = target.contentJson as Record<string, unknown>;
    const storedChanges = Array.isArray(targetContent["changeSet"])
      ? targetContent["changeSet"] as Array<Record<string, unknown>>
      : [];
    const storedDiff = targetContent["planDiff"] as PlanVersionDiff | undefined;
    const diff = direction === "forward" && storedDiff?.changes.length
      ? storedDiff
      : diffPlanContents(
          current.contentJson,
          target.contentJson,
          direction === "forward"
            ? storedChanges
            : [{ kind: "rollback", targetVersionId: target.id }],
        );
    return evaluateActivationGovernance({
      db: database,
      userId,
      onDate: effectiveFrom,
      currentVersionId: current.id,
      targetVersionId: target.id,
      direction,
      targetContent,
      targetValidationQuestions: target.validationQuestions,
      diff,
    });
  }

  async function previewActivation(
    userId: string,
    targetVersionId: string,
    effectiveFrom?: string,
  ): Promise<{
    currentVersionId: string;
    currentVersionNumber: number;
    targetVersionId: string;
    targetVersionNumber: number;
    direction: "forward" | "rollback";
    governanceReview: ActivationGovernanceReview;
  }> {
    return db.transaction(async (tx) => {
      const [target] = await tx.select().from(schema.planVersions).where(and(
        eq(schema.planVersions.id, targetVersionId),
        eq(schema.planVersions.userId, userId),
      )).limit(1);
      if (!target) throw new RangeError("target plan version not found");
      const [assignment] = await tx.select().from(schema.activePlanAssignments).where(and(
        eq(schema.activePlanAssignments.userId, userId),
        eq(schema.activePlanAssignments.scope, target.scope),
      )).limit(1);
      if (!assignment) throw new RangeError("active training plan assignment not found");
      const [current] = await tx.select().from(schema.planVersions).where(and(
        eq(schema.planVersions.id, assignment.planVersionId),
        eq(schema.planVersions.userId, userId),
        eq(schema.planVersions.status, "active"),
      )).limit(1);
      if (!current) throw new RangeError("active training plan version not found");
      const direction = target.status === "draft" && target.parentVersionId === current.id
        ? "forward" as const
        : target.status === "superseded" && current.parentVersionId === target.id
          ? "rollback" as const
          : undefined;
      if (!direction) {
        throw new RangeError("target must be the active version's direct draft child or direct superseded parent");
      }
      const activationDate = effectiveFrom ?? await createUserLocalDateResolver(tx as unknown as Db)(userId);
      const governanceReview = await reviewTransition(
        tx as unknown as Db,
        userId,
        current,
        target,
        direction,
        activationDate,
      );
      return {
        currentVersionId: current.id,
        currentVersionNumber: current.versionNumber,
        targetVersionId: target.id,
        targetVersionNumber: target.versionNumber,
        direction,
        governanceReview,
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

      const activationDate = effectiveFrom ?? await createUserLocalDateResolver(tx as unknown as Db)(userId);
      const governanceReview = await reviewTransition(
        tx as unknown as Db,
        userId,
        current,
        target,
        direction,
        activationDate,
      );
      if (!governanceReview.allowed) throw new PlanActivationBlockedError(governanceReview.reasons);

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
        governanceReview,
      };
    });
  }

  async function activateChildVersion(userId: string, childVersionId: string): Promise<void> {
    await activateVersion(userId, childVersionId);
  }

  return { record, proposeChildVersion, previewActivation, activateChildVersion, activateVersion };
}
