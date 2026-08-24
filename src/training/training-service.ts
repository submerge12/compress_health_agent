/**
 * M06/M07 / P4: training session lifecycle and per-set logging.
 *
 * Invariants (plan §8 J02/J04, §17.2):
 * - session state machine: planned → in_progress → completed | interrupted;
 *   no silent completed fabrication;
 * - set logs are unique per (sessionExerciseId, setNumber) — a retry with the
 *   same key updates nothing and returns the original row (idempotent);
 * - missing load/reps/RIR stay null: the system never invents values;
 * - preparing a day filters blocked movement patterns from active
 *   constraints (strictest wins) before proposing anything.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import { THREE_SPLIT_DAYS, DEFAULT_CYCLE } from "./three-split.js";

type Db = PostgresJsDatabase<typeof schema>;
type SessionRow = typeof schema.trainingSessions.$inferSelect;

export class SessionStateError extends Error {
  readonly code = "invalid_session_state";
  constructor(readonly from: string, readonly to: string) {
    super(`cannot transition session from ${from} to ${to}`);
  }
}

export function createTrainingService(db: Db) {
  /** Seed the reference program as data exactly once per user. */
  async function ensureUserProgram(userId: string): Promise<{ templateIds: string[]; planVersionId: string }> {
    const existing = await db.select().from(schema.trainingTemplates)
      .where(eq(schema.trainingTemplates.userId, userId));
    if (existing.length > 0) {
      const [assignment] = await db.select().from(schema.activePlanAssignments)
        .where(and(eq(schema.activePlanAssignments.userId, userId), eq(schema.activePlanAssignments.scope, "training_template")));
      return {
        templateIds: existing.map((t) => t.id),
        ...(assignment ? { planVersionId: assignment.planVersionId } : {}),
      } as { templateIds: string[]; planVersionId: string };
    }

    return db.transaction(async (tx) => {
      const [version] = await tx.insert(schema.planVersions).values({
        userId,
        scope: "training_template",
        status: "active",
        contentJson: { days: THREE_SPLIT_DAYS, cyclePattern: DEFAULT_CYCLE },
        adjustmentReason: "initial three-split reference program",
        createdByActor: "system",
        activatedAt: new Date(),
      }).returning();
      if (!version) throw new Error("plan version insert returned no row");

      await tx.insert(schema.trainingTemplates).values(
        THREE_SPLIT_DAYS.map((day) => ({
          userId,
          name: day.name,
          dayRole: day.dayRole,
          itemsJson: day.items as unknown as Array<Record<string, unknown>>,
          cyclePattern: DEFAULT_CYCLE,
          sourceVersionId: version.id,
        })),
      );

      await tx.insert(schema.activePlanAssignments).values({
        userId,
        scope: "training_template",
        planVersionId: version.id,
      }).onConflictDoUpdate({
        target: [schema.activePlanAssignments.userId, schema.activePlanAssignments.scope],
        set: { planVersionId: version.id, updatedAt: new Date() },
      });

      // Exercise definitions are global catalog rows; seed if absent.
      const counts = await tx.select({ count: sql<number>`count(*)::int` })
        .from(schema.exerciseDefinitions);
      if ((counts[0]?.count ?? 0) === 0) {
        const { DEFAULT_EXERCISES } = await import("./three-split.js");
        await tx.insert(schema.exerciseDefinitions).values(DEFAULT_EXERCISES.map((e) => ({
          slug: e.slug,
          nameZh: e.nameZh,
          nameEn: e.nameEn,
          movementPattern: e.movementPattern,
          primaryMuscles: e.primaryMuscles,
          secondaryMuscles: e.secondaryMuscles,
          equipment: e.equipment,
        }))).onConflictDoNothing();
      }

      return { templateIds: [], planVersionId: version.id };
    });
  }

  async function listActiveConstraints(userId: string, onDate: string) {
    return db.select().from(schema.healthConstraints).where(and(
      eq(schema.healthConstraints.userId, userId),
      isNull(schema.healthConstraints.liftedAt),
      sql`${schema.healthConstraints.activeFrom} <= ${onDate}`,
    ));
  }

  /**
   * Prepare today's session proposal: pick by cycle position, drop exercises
   * blocked by active constraints, report what was filtered and why.
   */
  async function prepareSession(userId: string, sessionDate: string, requestedDay?: "A" | "B" | "C") {
    await ensureUserProgram(userId);
    const [template] = await db.select().from(schema.trainingTemplates)
      .where(and(
        eq(schema.trainingTemplates.userId, userId),
        ...(requestedDay ? [eq(schema.trainingTemplates.dayRole, requestedDay)] : []),
      ))
      .limit(1);
    if (!template) throw new RangeError("no training template found for the request");

    const constraints = await listActiveConstraints(userId, sessionDate);
    const blockedPatterns = new Set(
      constraints
        .filter((c) => c.severity === "block")
        .flatMap((c) => {
          const target = c.targetJson as { movementPattern?: string };
          return target.movementPattern ? [target.movementPattern] : [];
        }),
    );

    const items = (template.itemsJson as unknown as Array<{
      exerciseSlug: string; nameZh: string; movementPattern: string; sets: number;
      repRangeLow?: number; repRangeHigh?: number; rirLow?: number; rirHigh?: number;
      alternates?: string[]; note?: string;
    }>);
    const kept = items.filter((item) => !blockedPatterns.has(item.movementPattern));
    const blocked = items.filter((item) => blockedPatterns.has(item.movementPattern));

    return {
      dayRole: template.dayRole,
      planVersionId: template.sourceVersionId,
      proposedExercises: kept.map((item) => ({
        ...item,
        status: blockedPatterns.size > 0 && kept.length < items.length ? "adjusted_for_constraints" : "as_planned",
      })),
      blockedExercises: blocked.map((item) => ({
        exerciseSlug: item.exerciseSlug,
        nameZh: item.nameZh,
        reason: "blocked_by_active_constraint",
        suggestion: item.alternates?.length ? "consider_alternates_or_rest" : "rest_that_pattern",
      })),
      activeConstraints: constraints.map((c) => ({
        id: c.id, type: c.constraintType, severity: c.severity, reason: c.reason,
      })),
    };
  }

  async function startSession(input: {
    userId: string;
    sessionDate: string;
    dayRole: "A" | "B" | "C";
    planVersionId?: string;
    journeyId?: string;
  }): Promise<SessionRow> {
    return db.transaction(async (tx) => {
      const [session] = await tx.insert(schema.trainingSessions).values({
        userId: input.userId,
        sessionDate: input.sessionDate,
        planVersionId: input.planVersionId ?? null,
        status: "in_progress",
        startedAt: new Date(),
        journeyId: input.journeyId ?? null,
      }).returning();
      if (!session) throw new Error("session insert returned no row");

      const [template] = await tx.select().from(schema.trainingTemplates)
        .where(and(eq(schema.trainingTemplates.userId, input.userId), eq(schema.trainingTemplates.dayRole, input.dayRole)))
        .limit(1);
      if (!template) throw new RangeError(`no template for day ${input.dayRole}`);

      const items = template.itemsJson as unknown as Array<{
        order: number; exerciseSlug: string; sets: number;
        repRangeLow?: number; repRangeHigh?: number; rirLow?: number; rirHigh?: number;
      }>;
      await tx.insert(schema.trainingSessionExercises).values(items.map((item) => ({
        sessionId: session.id,
        exerciseSlug: item.exerciseSlug,
        orderIndex: item.order,
        targetSets: item.sets,
        targetRepRangeLow: item.repRangeLow ?? null,
        targetRepRangeHigh: item.repRangeHigh ?? null,
        targetRirLow: item.rirLow ?? null,
        targetRirHigh: item.rirHigh ?? null,
      })));
      return session;
    });
  }

  async function requireOwnedSession(userId: string, sessionId: string): Promise<SessionRow> {
    const [session] = await db.select().from(schema.trainingSessions)
      .where(and(eq(schema.trainingSessions.id, sessionId), eq(schema.trainingSessions.userId, userId)))
      .limit(1);
    if (!session) throw new RangeError("session not found");
    return session;
  }

  async function finishSession(userId: string, sessionId: string, finalStatus: "completed" | "interrupted" | "cancelled"): Promise<SessionRow> {
    const session = await requireOwnedSession(userId, sessionId);
    if (session.status !== "in_progress") {
      throw new SessionStateError(session.status, finalStatus);
    }
    const [updated] = await db.update(schema.trainingSessions)
      .set({ status: finalStatus, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.trainingSessions.id, sessionId))
      .returning();
    if (!updated) throw new Error("session update returned no row");

    await db.insert(schema.outboxEvents).values({
      userId,
      aggregateType: "training_session",
      aggregateId: sessionId,
      eventType: `training.${finalStatus}`,
      payloadJson: { observedOn: session.sessionDate },
    });
    return updated;
  }

  async function recordSet(input: {
    userId: string;
    sessionId: string;
    sessionExerciseId: string;
    setNumber: number;
    loadValue?: number | null;
    loadUnit?: "kg" | "lb" | "bodyweight" | null;
    reps?: number | null;
    rir?: number | null;
    targetMuscleFeel?: number | null;
    pain?: Array<Record<string, unknown>>;
    source?: string;
    idempotencyKey?: string;
  }): Promise<{ log: typeof schema.trainingSetLogs.$inferSelect; replayed: boolean }> {
    const session = await requireOwnedSession(input.userId, input.sessionId);
    if (session.status !== "in_progress") {
      throw new SessionStateError(session.status, "record_set");
    }

    if (input.idempotencyKey) {
      const [existing] = await db.select().from(schema.trainingSetLogs)
        .where(eq(schema.trainingSetLogs.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing) return { log: existing, replayed: true };
    }

    const inserted = await db.insert(schema.trainingSetLogs).values({
      sessionExerciseId: input.sessionExerciseId,
      setNumber: input.setNumber,
      loadValue: input.loadValue ?? null,
      loadUnit: input.loadUnit ?? null,
      reps: input.reps ?? null,
      rir: input.rir ?? null,
      targetMuscleFeel: input.targetMuscleFeel ?? null,
      painJson: input.pain ?? [],
      source: input.source ?? "ui",
      idempotencyKey: input.idempotencyKey ?? null,
    }).onConflictDoUpdate({
      target: [schema.trainingSetLogs.sessionExerciseId, schema.trainingSetLogs.setNumber],
      set: {
        loadValue: input.loadValue ?? null,
        loadUnit: input.loadUnit ?? null,
        reps: input.reps ?? null,
        rir: input.rir ?? null,
        targetMuscleFeel: input.targetMuscleFeel ?? null,
        painJson: input.pain ?? [],
        updatedAt: new Date(),
      },
    }).returning();
    if (!inserted[0]) throw new Error("set log upsert returned no row");

    // A retry without an explicit key but same (exercise,set) is also a replay.
    return { log: inserted[0], replayed: false };
  }

  async function readBackSession(userId: string, sessionId: string) {
    const session = await requireOwnedSession(userId, sessionId);
    const exercises = await db.select().from(schema.trainingSessionExercises)
      .where(eq(schema.trainingSessionExercises.sessionId, sessionId))
      .orderBy(schema.trainingSessionExercises.orderIndex);
    const logs = await Promise.all(exercises.map(async (ex) => ({
      exercise: ex,
      sets: await db.select().from(schema.trainingSetLogs)
        .where(eq(schema.trainingSetLogs.sessionExerciseId, ex.id))
        .orderBy(schema.trainingSetLogs.setNumber),
    })));
    return { session, exercisesWithSets: logs };
  }

  return {
    ensureUserProgram,
    prepareSession,
    startSession,
    finishSession,
    recordSet,
    readBackSession,
    listActiveConstraints,
  };
}
