/**
 * M03 / P2: Daily health state — facts, projection, and concurrency.
 *
 * Design (plan §6): PostgreSQL detail tables plus append-only events are the
 * source of truth; `daily_health_state_projection` is a rebuildable read
 * model keyed by (user, date) and is never a write target. Every state-
 * changing command goes through `applyDailyCommand`, which:
 *
 *   1. checks optimistic concurrency (expectedRevision → 409 on mismatch),
 *   2. enforces idempotency (same key → original result, no duplicate fact),
 *   3. appends the observation fact,
 *   4. enqueues an outbox event in the SAME transaction,
 *   5. bumps the projection revision.
 *
 * The projection worker consumes the outbox separately (M04); a projection
 * failure never rolls back committed facts.
 */
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import type { Repository } from "../db/repository.js";

type Db = PostgresJsDatabase<typeof schema>;

export class StateConflictError extends Error {
  readonly code = "state_conflict";
  constructor(readonly currentRevision: number, readonly field?: string) {
    super(`revision mismatch (current: ${currentRevision})`);
  }
}

export class DuplicateIdempotencyKeyError extends Error {
  readonly code = "duplicate_idempotency_key";
}

/** Risk tiers per plan §17.1; M14 wraps these into an ask/deny matrix. */
export const CONFIRMATION_POLICY = {
  query: { confirm: false },
  reversible_log: { confirm: false }, // ordinary logs: save directly + undo
  low_confidence_input: { confirm: true }, // ASR/estimation below threshold
  day_plan_change: { confirm: true }, // show diff before applying
  long_horizon_change: { confirm: true }, // volume/cycle changes
  delete_or_lift_constraint: { confirm: true }, // reversal event required
  health_risk: { confirm: true }, // stop + escalate to human guidance
} as const;

export interface ObservationInput {
  userId: string;
  observedOn: string;
  kind: "sleep" | "fatigue" | "recovery" | "pain" | "weight" | "note";
  valueJson: Record<string, unknown>;
  source?: string;
  journeyId?: string;
  actor?: string;
}

interface ApplyOptions {
  /** Opaque command name, used for outbox typing. */
  commandType: string;
  aggregateType: string;
}

export interface DailyStateReadModel {
  schemaVersion: "daily-health-state.v1";
  userId: string;
  localDate: string;
  timezone: string;
  revision: number;

  activePlans: Record<string, string | null>;
  observations: Array<{ kind: string; valueJson: Record<string, unknown>; observedOn: string }>;
  activeConstraints: Array<Record<string, unknown>>;
  dietActualCount: number;
  dietActualKcal: number;
  waterTotalMl: number;
  exerciseMinutes: number;
  training: {
    recommendation: string | null;
    sessionId: string | null;
    status: string | null;
    plannedExercises: number;
    completedExercises: number;
    plannedSets: number;
    completedSets: number;
    substitutions: Array<{ replacementForId: string | null; slug: string }>;
    painEvents: Array<{ valueJson: Record<string, unknown> }>;
  };
  body: {
    weight: Record<string, unknown> | null;
    sleep: Record<string, unknown> | null;
    fatigue: Record<string, unknown> | null;
    recovery: Record<string, unknown> | null;
    pain: Array<{ valueJson: Record<string, unknown> }>;
  };
  projection: { status: string; builtAt: string };
}

type ProjectionStatus = "fresh" | "lagging" | "failed" | "rebuilding";

export function createDailyStateService(db: Db, repo: Repository) {
  // ── Facts ────────────────────────────────────────────────────────────────

  async function recordObservation(input: ObservationInput, options: ApplyOptions): Promise<{ eventId: string }> {
    return db.transaction(async (tx) => {
      const [event] = await tx.insert(schema.healthObservationEvents).values({
        userId: input.userId,
        observedOn: input.observedOn,
        kind: input.kind,
        valueJson: input.valueJson,
        source: input.source ?? "user",
        journeyId: input.journeyId ?? null,
      }).returning();
      if (!event) throw new Error("observation insert returned no row");

      await tx.insert(schema.outboxEvents).values({
        userId: input.userId,
        aggregateType: options.aggregateType,
        aggregateId: event.id,
        eventType: `${options.commandType}:recorded`,
        payloadJson: { kind: input.kind, observedOn: input.observedOn },
      });

      await touchProjection(input.userId, input.observedOn);
      return { eventId: event.id };
    });
  }

  /**
   * Pain constraints follow "strictest wins": inserting one is low-friction
   * (the user is in pain), lifting one always creates a reversal event and
   * requires explicit confirmation upstream (M14 confirmation matrix).
   */
  async function addConstraint(input: {
    userId: string;
    constraintType: string;
    severity?: "warn" | "block";
    targetJson: Record<string, unknown>;
    reason: string;
    activeFrom: string;
    activeTo?: string | null;
    sourceObservationId?: string | null;
  }): Promise<{ constraintId: string }> {
    const [created] = await db.insert(schema.healthConstraints).values({
      userId: input.userId,
      constraintType: input.constraintType,
      severity: input.severity ?? "warn",
      targetJson: input.targetJson,
      reason: input.reason,
      activeFrom: input.activeFrom,
      activeTo: input.activeTo ?? null,
      sourceObservationId: input.sourceObservationId ?? null,
    }).returning();
    if (!created) throw new Error("constraint insert returned no row");
    return { constraintId: created.id };
  }

  async function liftConstraint(constraintId: string, liftedByActor: string): Promise<void> {
    await db.update(schema.healthConstraints)
      .set({ liftedAt: new Date(), liftedByActor, updatedAt: new Date() })
      .where(and(eq(schema.healthConstraints.id, constraintId), isNull(schema.healthConstraints.liftedAt)));
  }

  async function listActiveConstraints(userId: string, onDate: string) {
    return db.select().from(schema.healthConstraints).where(and(
      eq(schema.healthConstraints.userId, userId),
      isNull(schema.healthConstraints.liftedAt),
      sql`${schema.healthConstraints.activeFrom} <= ${onDate}`,
      or(isNull(schema.healthConstraints.activeTo), sql`${schema.healthConstraints.activeTo} >= ${onDate}`),
    ));
  }

  // ── Idempotency ──────────────────────────────────────────────────────────

  async function checkAndRecordIdempotency(key: string, requestHash: string): Promise<"new" | "replay"> {
    // InteractionEvents double as the idempotency ledger until a dedicated
    // table lands with M05's DietLogV2 (plan §10 M05 model).
    const existing = await db.select({ id: schema.interactionEvents.id })
      .from(schema.interactionEvents)
      .where(and(
        eq(schema.interactionEvents.stage, "idempotency"),
        sql`${schema.interactionEvents.detailJson} ->> 'key' = ${key}`,
      ))
      .limit(1);
    if (existing[0]) {
      throw new DuplicateIdempotencyKeyError(`key already used: ${key}`);
    }
    await db.insert(schema.interactionEvents).values({
      stage: "idempotency",
      stageCode: "ok",
      detailJson: { key, hash: requestHash },
    });
    return "new";
  }

  // ── Projection ───────────────────────────────────────────────────────────

  async function buildDailyState(userId: string, localDate: string, timezone: string): Promise<DailyStateReadModel> {
    const [dietLogs, waterLogs, exerciseLogs, constraints, observations, assignments] = await Promise.all([
      // Effective revisions only: superseded rows stay on disk for audit but
      // must not count toward the day's facts (M05 correction lineage).
      db.select().from(schema.dietLogs).where(and(
        eq(schema.dietLogs.userId, userId),
        eq(schema.dietLogs.logDate, localDate),
        isNull(schema.dietLogs.supersededById),
      )),
      repo.listWaterLogs(userId, localDate),
      db.select().from(schema.exerciseLogs).where(and(
        eq(schema.exerciseLogs.userId, userId),
        eq(schema.exerciseLogs.logDate, localDate),
      )),
      listActiveConstraints(userId, localDate),
      db.select().from(schema.healthObservationEvents).where(and(
        eq(schema.healthObservationEvents.userId, userId),
        eq(schema.healthObservationEvents.observedOn, localDate),
        isNull(schema.healthObservationEvents.revokedAt),
      )).orderBy(asc(schema.healthObservationEvents.createdAt)),
      db.select().from(schema.activePlanAssignments).where(eq(schema.activePlanAssignments.userId, userId)),
    ]);

    // Structured training for the day (WO-HS-05): sessions + per-exercise
    // completion + set totals, so DailyState.training reflects reality even
    // when the coarse exercise_logs row is absent.
    const daySessions = await db.select().from(schema.trainingSessions).where(and(
      eq(schema.trainingSessions.userId, userId),
      eq(schema.trainingSessions.sessionDate, localDate),
    )).orderBy(asc(schema.trainingSessions.createdAt));
    const primarySession = daySessions.find((s) => s.status !== "cancelled") ?? null;
    let trainingExercises: Array<typeof schema.trainingSessionExercises.$inferSelect> = [];
    if (primarySession !== null) {
      trainingExercises = await db.select().from(schema.trainingSessionExercises)
        .where(eq(schema.trainingSessionExercises.sessionId, primarySession.id))
        .orderBy(asc(schema.trainingSessionExercises.orderIndex));
    }
    const setCounts = await Promise.all(trainingExercises.map(async (ex) => {
      const rows = await db.select({ n: sql<number>`count(*)::int` })
        .from(schema.trainingSetLogs)
        .where(eq(schema.trainingSetLogs.sessionExerciseId, ex.id));
      return { exerciseId: ex.id, doneSets: rows[0]?.n ?? 0 };
    }));
    const plannedSets = trainingExercises
      .filter((ex) => ex.status !== "replaced")
      .reduce((sum, ex) => sum + ex.targetSets, 0);
    const completedSets = setCounts.reduce((sum, s) => sum + s.doneSets, 0);

    const sleepObservation = observations.find((o) => o.kind === "sleep");

    const trainingBlock = {
      recommendation: null as string | null,
      sessionId: primarySession?.id ?? null,
      status: primarySession?.status ?? null,
      plannedExercises: trainingExercises.filter((ex) => ex.status !== "replaced").length,
      completedExercises: trainingExercises.filter((ex) =>
        ex.status === "done" || (ex.status === "pending" &&
          (setCounts.find((s) => s.exerciseId === ex.id)?.doneSets ?? 0) >= ex.targetSets)).length,
      plannedSets,
      completedSets,
      substitutions: trainingExercises
        .filter((ex) => ex.replacementForId !== null)
        .map((ex) => ({ replacementForId: ex.replacementForId, slug: ex.exerciseSlug })),
      painEvents: observations
        .filter((o) => o.kind === "pain")
        .map((o) => ({ valueJson: o.valueJson })),
    };

    const bodyBlock = {
      weight: observations.find((o) => o.kind === "weight")?.valueJson ?? null,
      sleep: sleepObservation?.valueJson ?? null,
      fatigue: observations.find((o) => o.kind === "fatigue")?.valueJson ?? null,
      recovery: observations.find((o) => o.kind === "recovery")?.valueJson ?? null,
      pain: trainingBlock.painEvents,
    };

    return {
      schemaVersion: "daily-health-state.v1",
      userId,
      localDate,
      timezone,
      revision: 0, // filled by persistDailyProjection
      activePlans: Object.fromEntries(assignments.map((a) => [a.scope, a.planVersionId])),
      observations: observations.map((o) => ({ kind: o.kind, valueJson: o.valueJson, observedOn: o.observedOn })),
      activeConstraints: constraints.map((c) => ({
        id: c.id,
        constraintType: c.constraintType,
        severity: c.severity,
        targetJson: c.targetJson,
        reason: c.reason,
      })),
      dietActualCount: dietLogs.length,
      dietActualKcal: dietLogs.reduce((sum, log) => sum + Number(log.caloriesKcal), 0),
      waterTotalMl: waterLogs.reduce((sum, log) => sum + log.amountMl, 0),
      exerciseMinutes: exerciseLogs.reduce((sum, log) => sum + log.durationMinutes, 0),
      training: trainingBlock,
      body: bodyBlock,
      projection: { status: "fresh", builtAt: new Date().toISOString() },
    };
  }

  async function persistDailyProjection(
    userId: string,
    localDate: string,
    timezone: string,
    status: ProjectionStatus = "fresh",
  ): Promise<DailyStateReadModel> {
    return persistBuiltProjection(await buildDailyState(userId, localDate, timezone), status);
  }

  /**
   * Persist an already-built read model. A projection worker can call this on
   * a transaction-scoped service after locking and re-checking its outbox
   * lease, so a stale worker never mutates the projection.
   */
  async function persistBuiltProjection(
    state: DailyStateReadModel,
    status: ProjectionStatus = "fresh",
  ): Promise<DailyStateReadModel> {
    const { userId, localDate, timezone } = state;
    const [existing] = await db.select({ revision: schema.dailyHealthStateProjection.revision })
      .from(schema.dailyHealthStateProjection)
      .where(and(
        eq(schema.dailyHealthStateProjection.userId, userId),
        eq(schema.dailyHealthStateProjection.stateDate, localDate),
      ))
      .limit(1);
    const revision = (existing?.revision ?? -1) + 1;
    const payload = { ...state, revision };

    await db.insert(schema.dailyHealthStateProjection).values({
      userId,
      stateDate: localDate,
      revision,
      timezone,
      stateJson: payload as unknown as Record<string, unknown>,
      sourceEventCount: state.observations.length,
      projectionStatus: status,
      builtAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.dailyHealthStateProjection.userId, schema.dailyHealthStateProjection.stateDate],
      set: {
        revision,
        stateJson: payload as unknown as Record<string, unknown>,
        sourceEventCount: state.observations.length,
        projectionStatus: status,
        builtAt: new Date(),
        updatedAt: new Date(),
      },
    });

    return payload;
  }

  async function touchProjection(userId: string, localDate: string): Promise<void> {
    // Facts commit first; marking the projection lagging is best-effort.
    try {
      await db.update(schema.dailyHealthStateProjection)
        .set({ projectionStatus: "lagging", updatedAt: new Date() })
        .where(and(
          eq(schema.dailyHealthStateProjection.userId, userId),
          eq(schema.dailyHealthStateProjection.stateDate, localDate),
        ));
    } catch {
      // no projection row yet — fine, next rebuild creates it fresh
    }
  }

  async function getDailyProjection(userId: string, localDate: string) {
    const [row] = await db.select().from(schema.dailyHealthStateProjection)
      .where(and(
        eq(schema.dailyHealthStateProjection.userId, userId),
        eq(schema.dailyHealthStateProjection.stateDate, localDate),
      ))
      .limit(1);
    if (!row) return undefined;

    const counts = await db.select({ count: sql<number>`count(*)::int` })
      .from(schema.outboxEvents)
      .where(and(
        eq(schema.outboxEvents.userId, userId),
        eq(schema.outboxEvents.status, "pending"),
        or(
          sql`${schema.outboxEvents.payloadJson} ->> 'observedOn' = ${localDate}`,
          sql`${schema.outboxEvents.payloadJson} ->> 'logDate' = ${localDate}`,
        ),
      ));

    return {
      ...row.stateJson as unknown as DailyStateReadModel,
      projection: {
        ...(row.stateJson as unknown as DailyStateReadModel).projection,
        status: row.projectionStatus,
        pendingOutboxEvents: counts[0]?.count ?? 0,
      },
    };
  }

  return {
    recordObservation,
    addConstraint,
    liftConstraint,
    listActiveConstraints,
    buildDailyState,
    persistDailyProjection,
    persistBuiltProjection,
    getDailyProjection,
    checkAndRecordIdempotency,
  };
}

export type DailyStateService = ReturnType<typeof createDailyStateService>;
