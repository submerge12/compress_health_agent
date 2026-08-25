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
import { NotOwnedError } from "./ownership.js";
import { blockedPatternsForBodyPart } from "./prepared-session.js";

type Db = PostgresJsDatabase<typeof schema>;
type SessionRow = typeof schema.trainingSessions.$inferSelect;

export class SessionStateError extends Error {
  readonly code = "invalid_session_state";
  constructor(readonly from: string, readonly to: string) {
    super(`cannot transition session from ${from} to ${to}`);
  }
}

export function createTrainingService(db: Db) {
  /** Latest daily-state revision for the user across dates (−1 when none). */
  async function currentDailyRevision(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    userId: string,
  ): Promise<number> {
    const [row] = await tx.select({ max: sql<number>`coalesce(max(${schema.dailyHealthStateProjection.revision}), -1)::int` })
      .from(schema.dailyHealthStateProjection)
      .where(eq(schema.dailyHealthStateProjection.userId, userId));
    return row?.max ?? -1;
  }

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

    // WO-HS-07: the ACTIVE plan version is authoritative (its content_json is
    // a complete compiled plan). Templates are only the initial seed.
    const [assignment] = await db.select().from(schema.activePlanAssignments)
      .where(and(
        eq(schema.activePlanAssignments.userId, userId),
        eq(schema.activePlanAssignments.scope, "training_template"),
      ))
      .limit(1);
    const [activeVersion] = assignment
      ? await db.select().from(schema.planVersions)
          .where(eq(schema.planVersions.id, assignment.planVersionId))
          .limit(1)
      : [];

    let dayRole: string;
    let items: Array<{
      exerciseSlug: string; nameZh?: string; movementPattern?: string; sets: number;
      repRangeLow?: number; repRangeHigh?: number; rirLow?: number; rirHigh?: number;
      alternates?: string[]; note?: string;
    }>;
    let planVersionId: string | undefined;

    if (activeVersion) {
      const content = activeVersion.contentJson as {
        cyclePattern?: string[];
        // Compiled (WO-HS-07): days keyed by A/B/C.
        days?: Record<string, Array<Record<string, unknown>>>;
        // Legacy seed format: days is an ARRAY of {dayRole|name, items}.
        legacyDays?: Array<{ dayRole?: string; name?: string; items?: Array<Record<string, unknown>> }>;
      };
      let dayList: Record<string, Array<Record<string, unknown>>> = {};
      if (content.days && !Array.isArray(content.days)) {
        dayList = content.days;
      } else {
        for (const day of (Array.isArray(content.days) ? content.days : [])) {
          const typed = day as { dayRole?: string; name?: string; items?: Array<Record<string, unknown>> };
          const key = (typed.dayRole
            ?? (typed.name?.startsWith("胸") ? "A"
              : typed.name?.includes("背") || typed.name?.includes("肩后束") ? "B"
              : typed.name?.includes("腿") ? "C" : undefined)
            ?? "").toUpperCase();
          if (key && typed.items) dayList[key] = typed.items;
        }
      }
      const role = requestedDay ?? content.cyclePattern?.[0]?.toUpperCase() ?? "A";
      const dayItems = dayList[role];
      if (!dayItems || dayItems.length === 0) {
        throw new RangeError(`no training plan found for the request (${role})`);
      }
      dayRole = role;
      planVersionId = activeVersion.id;
      items = dayItems as typeof items;
    } else {
      const [template] = await db.select().from(schema.trainingTemplates)
        .where(and(
          eq(schema.trainingTemplates.userId, userId),
          ...(requestedDay ? [eq(schema.trainingTemplates.dayRole, requestedDay)] : []),
        ))
        .limit(1);
      if (!template) throw new RangeError("no training template found for the request");
      dayRole = template.dayRole;
      planVersionId = template.sourceVersionId ?? undefined;
      items = template.itemsJson as typeof items;
    }

    const constraints = await listActiveConstraints(userId, sessionDate);
    const blockedPatterns = new Set(
      constraints
        .filter((c) => c.severity === "block")
        .flatMap((c) => {
          const target = c.targetJson as { movementPattern?: string; bodyPart?: string };
          const direct = target.movementPattern ? [target.movementPattern] : [];
          // WO-HS-06: pain commands store bodyPart scope; expand to pattern
          // families here so service-level filtering matches the route layer.
          const byBodyPart = blockedPatternsForBodyPart(target.bodyPart);
          return [...direct, ...byBodyPart];
        }),
    );

    const kept = items.filter((item) => !blockedPatterns.has(String(item.movementPattern)));
    const blocked = items.filter((item) => blockedPatterns.has(String(item.movementPattern)));

    return {
      dayRole,
      planVersionId,
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
    if (!session) throw new NotOwnedError("training_session");
    return session;
  }

  /**
   * WO-HS-06: create a session directly from a prepared proposal's exercise
   * list — no template lookup, so the constraint-filtered plan is exactly
   * what lands in the database (J04 acceptance).
   */
  async function startSessionFromProposal(input: {
    userId: string;
    sessionDate: string;
    dayRole: "A" | "B" | "C";
    planVersionId?: string;
    exercises: Array<{
      order: number;
      exerciseSlug: string;
      sets: number;
      repRangeLow?: number;
      repRangeHigh?: number;
      rirLow?: number;
      rirHigh?: number;
    }>;
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

      const exercises = [...input.exercises].sort((a, b) => a.order - b.order);
      await tx.insert(schema.trainingSessionExercises).values(exercises.map((item) => ({
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

  async function finishSession(userId: string, sessionId: string, finalStatus: "completed" | "interrupted" | "cancelled"): Promise<SessionRow> {
    // P0-4: session transition + exercise completion projection + outbox +
    // interaction receipt commit as ONE transaction — a crash can no longer
    // leave a finished session without its outbox event.
    return db.transaction(async (tx) => {
      const [session] = await tx.select().from(schema.trainingSessions)
        .where(and(eq(schema.trainingSessions.id, sessionId), eq(schema.trainingSessions.userId, userId)))
        .limit(1)
        .for("update");
      if (!session) throw new NotOwnedError("training_session");
      if (session.status !== "in_progress") {
        throw new SessionStateError(session.status, finalStatus);
      }

      const exercises = await tx.select().from(schema.trainingSessionExercises)
        .where(eq(schema.trainingSessionExercises.sessionId, sessionId));
      const doneCounts = await tx.select({
        sessionExerciseId: schema.trainingSetLogs.sessionExerciseId,
        logged: sql<number>`count(*)::int`,
      })
        .from(schema.trainingSetLogs)
        .where(sql`${schema.trainingSetLogs.sessionExerciseId} IN (
          SELECT id FROM ${schema.trainingSessionExercises} WHERE ${schema.trainingSessionExercises.sessionId} = ${sessionId}
        )`)
        .groupBy(schema.trainingSetLogs.sessionExerciseId);
      const doneByExercise = new Map(doneCounts.map((r) => [r.sessionExerciseId, r.logged]));

      // Fact-based completion: enough LOGGED sets mark the exercise done —
      // never a client-asserted status.
      for (const ex of exercises) {
        if (ex.status !== "pending") continue;
        const logged = doneByExercise.get(ex.id) ?? 0;
        const nextStatus = logged >= ex.targetSets ? "done"
          : finalStatus === "completed" ? "skipped" : ex.status;
        if (nextStatus !== ex.status) {
          await tx.update(schema.trainingSessionExercises)
            .set({ status: nextStatus, updatedAt: new Date() })
            .where(eq(schema.trainingSessionExercises.id, ex.id));
        }
      }

      const [updated] = await tx.update(schema.trainingSessions)
        .set({ status: finalStatus, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.trainingSessions.id, sessionId))
        .returning();
      if (!updated) throw new Error("session update returned no row");

      await tx.insert(schema.outboxEvents).values({
        userId,
        aggregateType: "training_session",
        aggregateId: sessionId,
        eventType: `training.${finalStatus}`,
        payloadJson: { observedOn: session.sessionDate },
      });
      await tx.insert(schema.interactionEvents).values({
        userId,
        journeyId: session.journeyId,
        stage: "db",
        stageCode: "ok",
        detailJson: {
          kind: "training_session_finished",
          sessionId,
          finalStatus,
          observedOn: session.sessionDate,
        },
      });
      return updated;
    });
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
  }): Promise<{
    log: typeof schema.trainingSetLogs.$inferSelect;
    replayed: boolean;
    beforeRevision: number;
    afterRevision: number;
    exerciseCompleted: boolean;
  }> {
    // P0-4: ownership check, replay detection, insert, outbox, auto-done and
    // revision bump all happen in ONE transaction; a retry with the same
    // idempotency key or the same (exercise, setNumber) returns the original
    // row untouched and emits nothing.
    return db.transaction(async (tx) => {
      const [session] = await tx.select().from(schema.trainingSessions)
        .where(and(eq(schema.trainingSessions.id, input.sessionId), eq(schema.trainingSessions.userId, input.userId)))
        .limit(1);
      if (!session) throw new NotOwnedError("training_session");
      const [exercise] = await tx.select().from(schema.trainingSessionExercises)
        .where(and(
          eq(schema.trainingSessionExercises.id, input.sessionExerciseId),
          eq(schema.trainingSessionExercises.sessionId, input.sessionId),
        ))
        .limit(1)
        .for("update");
      if (!exercise) throw new NotOwnedError("session_exercise");
      if (session.status !== "in_progress") {
        throw new SessionStateError(session.status, "record_set");
      }

      if (input.idempotencyKey) {
        const [existing] = await tx.select().from(schema.trainingSetLogs)
          .where(eq(schema.trainingSetLogs.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (existing) {
          return {
            log: existing,
            replayed: true,
            beforeRevision: -1,
            afterRevision: -1,
            exerciseCompleted: false,
          };
        }
      }

      const beforeRevision = await currentDailyRevision(tx, input.userId);

      const inserted = await tx.insert(schema.trainingSetLogs).values({
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
      }).onConflictDoNothing({
        target: [schema.trainingSetLogs.sessionExerciseId, schema.trainingSetLogs.setNumber],
      }).returning();

      if (inserted[0] === undefined) {
        const [existing] = await tx.select().from(schema.trainingSetLogs)
          .where(and(
            eq(schema.trainingSetLogs.sessionExerciseId, input.sessionExerciseId),
            eq(schema.trainingSetLogs.setNumber, input.setNumber),
          ))
          .limit(1);
        if (!existing) throw new Error("set insert conflicted but original row vanished");
        return {
          log: existing,
          replayed: true,
          beforeRevision: -1,
          afterRevision: -1,
          exerciseCompleted: false,
        };
      }
      const log = inserted[0];

      await tx.insert(schema.outboxEvents).values({
        userId: input.userId,
        aggregateType: "training_set",
        aggregateId: log.id,
        eventType: "training.set_logged",
        payloadJson: {
          observedOn: session.sessionDate,
          sessionId: input.sessionId,
          sessionExerciseId: input.sessionExerciseId,
          setNumber: input.setNumber,
        },
      });

      // P0-4: reaching target sets flips the exercise to done as a FACT.
      const loggedCount = await tx.select({ n: sql<number>`count(*)::int` })
        .from(schema.trainingSetLogs)
        .where(eq(schema.trainingSetLogs.sessionExerciseId, input.sessionExerciseId));
      const done = (loggedCount[0]?.n ?? 0) >= exercise.targetSets && exercise.status === "pending";
      let exerciseCompleted = false;
      if (done) {
        await tx.update(schema.trainingSessionExercises)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(schema.trainingSessionExercises.id, input.sessionExerciseId));
        exerciseCompleted = true;
      }

      // Pain entries attached to a set still escalate through the constraint
      // path — a set log must never swallow a pain signal.
      if ((input.pain?.length ?? 0) > 0) {
        await tx.insert(schema.outboxEvents).values({
          userId: input.userId,
          aggregateType: "observation",
          aggregateId: log.id,
          eventType: "health.pain_during_set",
          payloadJson: { observedOn: session.sessionDate, sessionId: input.sessionId },
        });
      }

      const afterRevision = beforeRevision + 1;
      return { log, replayed: false, beforeRevision, afterRevision, exerciseCompleted };
    });
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
    startSessionFromProposal,
    finishSession,
    recordSet,
    readBackSession,
    listActiveConstraints,
  };
}
