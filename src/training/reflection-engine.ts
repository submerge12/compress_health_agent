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

type Db = PostgresJsDatabase<typeof schema>;

type PlanDayItem = Record<string, unknown>;

export interface PlanVersionDiff {
  changes: Array<Record<string, unknown>>;
  changedDays: Array<{
    dayRole: string;
    beforeOrder: string[];
    afterOrder: string[];
  }>;
}

export interface PlanActivationResult {
  activatedVersionId: string;
  previousVersionId: string;
  direction: "forward" | "rollback";
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

    // WO-HS-07: content_json must be a complete executable plan. Compile:
    // parent days + change-set applied.
    const parentContent = parent.contentJson as {
      days?: Record<string, PlanDayItem[]> | Array<{
        dayRole?: string;
        name?: string;
        items?: PlanDayItem[];
      }>;
      cyclePattern?: string[];
    };
    const compiledDays = normalizePlanDays(parentContent);
    let materialChanges = 0;
    for (const change of input.changes as Array<Record<string, unknown>>) {
      const kind = String(change.kind ?? "");
      if (kind === "remove_exercise") {
        const slug = requiredChangeString(change, "exerciseSlug");
        let removed = 0;
        for (const role of Object.keys(compiledDays)) {
          const list = compiledDays[role];
          if (list !== undefined) {
            const next = list.filter(
              (item) => String(item.exerciseSlug ?? "") !== slug);
            removed += list.length - next.length;
            compiledDays[role] = next;
          }
        }
        if (removed === 0) throw new RangeError(`exercise ${slug} is not in the active plan`);
        materialChanges += removed;
      } else if (kind === "reorder") {
        const role = requiredChangeString(change, "dayRole").toUpperCase();
        const current = compiledDays[role];
        if (!current) throw new RangeError(`day ${role} is not in the active plan`);
        if (!Array.isArray(change.order) || change.order.length === 0) {
          throw new RangeError("reorder requires a non-empty order array");
        }
        const order = change.order.map((slug) => String(slug).trim()).filter(Boolean);
        if (new Set(order).size !== order.length) throw new RangeError("reorder contains duplicate exercise slugs");
        const available = new Set(current.map((item) => String(item.exerciseSlug ?? "")));
        const missing = order.filter((slug) => !available.has(slug));
        if (missing.length > 0) throw new RangeError(`reorder contains unknown exercises: ${missing.join(", ")}`);
        const before = exerciseOrder(current);
        const rank = new Map(order.map((slug, index) => [slug, index]));
        compiledDays[role] = current
          .map((item, originalIndex) => ({ item, originalIndex }))
          .sort((left, right) => {
            const leftRank = rank.get(String(left.item.exerciseSlug ?? ""));
            const rightRank = rank.get(String(right.item.exerciseSlug ?? ""));
            if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
            if (leftRank !== undefined) return -1;
            if (rightRank !== undefined) return 1;
            return left.originalIndex - right.originalIndex;
          })
          .map(({ item }) => item);
        if (JSON.stringify(before) === JSON.stringify(exerciseOrder(compiledDays[role]!))) {
          throw new RangeError(`reorder for day ${role} has no effect`);
        }
        materialChanges += 1;
      } else if (kind === "add_exercise") {
        const role = requiredChangeString(change, "dayRole").toUpperCase();
        const slug = requiredChangeString(change, "exerciseSlug");
        const current = compiledDays[role];
        if (!current) throw new RangeError(`day ${role} is not in the active plan`);
        if (current.some((item) => item.exerciseSlug === slug)) {
          throw new RangeError(`exercise ${slug} already exists on day ${role}`);
        }
        const sets = Number(change.sets ?? 3);
        if (!Number.isInteger(sets) || sets <= 0) throw new RangeError("added exercise sets must be a positive integer");
        current.push({
          exerciseSlug: slug,
          sets,
          note: String(change.note ?? "added by reflection"),
        });
        materialChanges += 1;
      } else {
        throw new RangeError(`unsupported plan change kind: ${kind || "missing"}`);
      }
    }
    if (materialChanges === 0) throw new RangeError("plan changes have no effect");
    for (const [role, items] of Object.entries(compiledDays)) {
      if (items.length === 0) throw new RangeError(`plan change would leave day ${role} empty`);
    }
    const planDiff = diffPlanContents(parent.contentJson, {
      ...parentContent,
      days: compiledDays,
    }, input.changes);
    if (planDiff.changedDays.length === 0) throw new RangeError("plan changes have no compiled diff");
    const this_contentJson = {
      ...parentContent,
      days: compiledDays,
      cyclePattern: parentContent.cyclePattern ?? ["A", "B", "REST", "C", "REST"],
      changeSet: input.changes,
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
  async function activateVersion(userId: string, targetVersionId: string): Promise<PlanActivationResult> {
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
      return {
        activatedVersionId: target.id,
        previousVersionId: current.id,
        direction,
      };
    });
  }

  async function activateChildVersion(userId: string, childVersionId: string): Promise<void> {
    await activateVersion(userId, childVersionId);
  }

  return { record, proposeChildVersion, activateChildVersion, activateVersion };
}

export function diffPlanContents(
  beforeContent: Record<string, unknown>,
  afterContent: Record<string, unknown>,
  changes: Array<Record<string, unknown>>,
): PlanVersionDiff {
  const beforeDays = normalizePlanDays(beforeContent);
  const afterDays = normalizePlanDays(afterContent);
  const roles = [...new Set([...Object.keys(beforeDays), ...Object.keys(afterDays)])].sort();
  return {
    changes,
    changedDays: roles.flatMap((dayRole) => {
      const beforeOrder = exerciseOrder(beforeDays[dayRole] ?? []);
      const afterOrder = exerciseOrder(afterDays[dayRole] ?? []);
      return JSON.stringify(beforeOrder) === JSON.stringify(afterOrder)
        ? []
        : [{ dayRole, beforeOrder, afterOrder }];
    }),
  };
}

function normalizePlanDays(content: { days?: unknown }): Record<string, PlanDayItem[]> {
  const normalized: Record<string, PlanDayItem[]> = {};
  const rawDays = content.days;
  if (Array.isArray(rawDays)) {
    for (const value of rawDays) {
      const day = value as { dayRole?: string; name?: string; items?: PlanDayItem[] };
      const key = (day.dayRole
        ?? (day.name?.startsWith("胸") ? "A"
          : day.name?.includes("背") || day.name?.includes("肩后束") ? "B"
          : day.name?.includes("腿") ? "C" : undefined)
        ?? "").toUpperCase();
      if (key && Array.isArray(day.items)) {
        normalized[key] = day.items.map((item) => ({ ...item }));
      }
    }
    return normalized;
  }
  if (rawDays !== null && typeof rawDays === "object") {
    for (const [role, items] of Object.entries(rawDays as Record<string, unknown>)) {
      if (Array.isArray(items)) {
        normalized[role.toUpperCase()] = items.map((item) => ({ ...(item as PlanDayItem) }));
      }
    }
  }
  return normalized;
}

function exerciseOrder(items: PlanDayItem[]): string[] {
  return items.map((item) => String(item.exerciseSlug ?? ""));
}

function requiredChangeString(change: Record<string, unknown>, key: string): string {
  const value = change[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RangeError(`${key} is required for plan change`);
  }
  return value.trim();
}
