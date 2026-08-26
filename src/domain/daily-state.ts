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
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import { createRepository, type Repository } from "../db/repository.js";
import { latestEffectiveSingletonObservation } from "./observation-policy.js";
import {
  summarizeSessionVolume,
  type SubstitutionLineage,
} from "../training/session-volume.js";
import { createCycleEngine, type CycleDecision } from "../training/cycle-engine.js";

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

export interface DailyHealthStateV2 {
  schemaVersion: "daily-health-state.v2";
  userId: string;
  localDate: string;
  timezone: string;
  revision: number;

  plans: {
    dietPlanVersionId: string | null;
    trainingPlanVersionId: string | null;
    trainingCycleVersionId: string | null;
  };
  constraints: ActiveConstraint[];
  userDecisions: UserDecision[];
  nextAdjustments: Adjustment[];
  basis: EvidenceReference[];
  /** @deprecated V1 compatibility during the V2 rollout. */
  activePlans: Record<string, string | null>;
  diet: {
    plannedMeals: PlannedMeal[];
    actualLogs: ActualMeal[];
    plannedTotals: NutritionTotals;
    actualTotals: NutritionTotals;
    deviation: NutritionDeviation;
    uncertainEstimates: UncertainEstimate[];
  };
  observations: Array<{ kind: string; valueJson: Record<string, unknown>; observedOn: string }>;
  activeConstraints: Array<Record<string, unknown>>;
  dietActualCount: number;
  dietActualKcal: number;
  waterTotalMl: number;
  exerciseMinutes: number;
  training: {
    recommendation: CycleDecision | null;
    sessions: TrainingSessionSummary[];
    activeSessionId: string | null;
    plannedSetBudget: number;
    completedSetBudget: number;
    completionRate: number;
    reflections: ReflectionSummary[];
    /** @deprecated V1 compatibility during the V2 rollout. */
    sessionId: string | null;
    status: string | null;
    plannedExercises: number;
    completedExercises: number;
    plannedSets: number;
    completedSets: number;
    substitutions: SubstitutionLineage[];
    painEvents: Array<{ valueJson: Record<string, unknown> }>;
  };
  body: {
    effectiveWeight: DailyStateObservation | null;
    effectiveSleep: DailyStateObservation | null;
    effectiveFatigue: DailyStateObservation | null;
    effectiveRecovery: DailyStateObservation | null;
    activePain: DailyStateObservation[];
    observationHistory: DailyStateObservation[];
    /** @deprecated V1 compatibility during the V2 rollout. */
    weight: Record<string, unknown> | null;
    /** @deprecated V1 compatibility during the V2 rollout. */
    sleep: Record<string, unknown> | null;
    /** @deprecated V1 compatibility during the V2 rollout. */
    fatigue: Record<string, unknown> | null;
    /** @deprecated V1 compatibility during the V2 rollout. */
    recovery: Record<string, unknown> | null;
    /** @deprecated V1 compatibility during the V2 rollout. */
    pain: Array<{ valueJson: Record<string, unknown> }>;
  };
  projection: {
    status: ProjectionStatus;
    pendingEvents: number;
    deadLetterEvents: number;
    builtAt: string;
    /** @deprecated V1 compatibility during the V2 rollout. */
    pendingOutboxEvents?: number;
  };
}

/** Compatibility name for internal callers while the public contract is V2. */
export type DailyStateReadModel = DailyHealthStateV2;

export interface DailyStateObservation {
  id: string;
  observedOn: string;
  kind: string;
  valueJson: Record<string, unknown>;
  source: string;
  createdAt: string;
}

export interface TrainingSessionSummary {
  id: string;
  status: string;
  planVersionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  plannedExercises: number;
  completedExercises: number;
  plannedSetBudget: number;
  completedSetBudget: number;
  completionRate: number;
}

export interface ReflectionSummary {
  id: string;
  sessionId: string;
  completedVsPlanned: Record<string, unknown> | null;
  bestCueRefs: string[];
  unresolvedIssues: Array<Record<string, unknown>>;
  painSummary: Array<Record<string, unknown>>;
  proposedAdjustments: Array<Record<string, unknown>>;
  nextValidationQuestions: string[];
  proposalPlanVersionId: string | null;
  userAcceptedAt: string | null;
  createdAt: string;
}

export const NUTRITION_TOTAL_KEYS = [
  "caloriesKcal",
  "proteinGrams",
  "carbsGrams",
  "fatGrams",
  "fiberGrams",
  "sugarGrams",
  "sodiumMg",
  "potassiumMg",
  "calciumMg",
  "ironMg",
  "magnesiumMg",
  "zincMg",
  "vitaminAMcg",
  "vitaminCMg",
  "vitaminDMcg",
  "vitaminB12Mcg",
  "folateMcg",
  "cholesterolMg",
] as const;

export type NutritionTotalKey = typeof NUTRITION_TOTAL_KEYS[number];
export type NutritionTotals = Record<NutritionTotalKey, number>;
export type NutritionDeviation = NutritionTotals;

export interface PlannedMeal {
  id: string;
  planDate: string;
  mealType: string;
  dishName: string;
  recipeSlug: string | null;
  status: string;
  ingredients: Array<Record<string, unknown>>;
  seasonings: Array<Record<string, unknown>>;
  nutrition: NutritionTotals;
}

export interface ActualMeal {
  id: string;
  logDate: string;
  loggedAt: string;
  mealType: string;
  description: string;
  source: string;
  uncertain: boolean;
  estimateConfidence: number | null;
  correctionOfId: string | null;
  nutrition: NutritionTotals;
}

export interface UncertainEstimate {
  dietLogId: string;
  description: string;
  confidence: number | null;
  reason: "estimate_marked_uncertain";
}

export interface ActiveConstraint {
  id: string;
  constraintType: string;
  severity: string;
  target: Record<string, unknown>;
  reason: string;
  activeFrom: string;
  activeTo: string | null;
  sourceObservationId: string | null;
  createdAt: string;
}

export interface UserDecision {
  id: string;
  decisionType: string;
  subject: Record<string, unknown>;
  journeyId: string | null;
  createdAt: string;
}

export interface Adjustment {
  kind: string;
  reasonCode: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  basis: EvidenceReference[];
}

export interface EvidenceReference {
  type: string;
  id: string;
  role: string;
}

function nutritionFromRow(row: Record<NutritionTotalKey, number>): NutritionTotals {
  return Object.fromEntries(
    NUTRITION_TOTAL_KEYS.map((key) => [key, Number(row[key])]),
  ) as NutritionTotals;
}

function sumNutrition(rows: readonly Record<NutritionTotalKey, number>[]): NutritionTotals {
  return Object.fromEntries(NUTRITION_TOTAL_KEYS.map((key) => [
    key,
    rows.reduce((sum, row) => sum + Number(row[key]), 0),
  ])) as NutritionTotals;
}

function subtractNutrition(actual: NutritionTotals, planned: NutritionTotals): NutritionDeviation {
  return Object.fromEntries(
    NUTRITION_TOTAL_KEYS.map((key) => [key, actual[key] - planned[key]]),
  ) as NutritionDeviation;
}

type ProjectionStatus = "fresh" | "lagging" | "failed" | "rebuilding";

/**
 * Serialize projection builds for one user/day inside the caller's current
 * PostgreSQL transaction. Hash collisions only reduce concurrency; they
 * cannot weaken correctness.
 */
export async function acquireDailyProjectionTransactionLock(
  db: Db,
  userId: string,
  localDate: string,
): Promise<void> {
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${localDate}))
  `);
}

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
    const [
      dietLogs,
      plannedMealRows,
      waterLogs,
      exerciseLogs,
      constraints,
      observations,
      assignments,
      decisionRows,
      projectionEventCounts,
      recommendation,
    ] = await Promise.all([
      // Effective revisions only: superseded rows stay on disk for audit but
      // must not count toward the day's facts (M05 correction lineage).
      db.select().from(schema.dietLogs).where(and(
        eq(schema.dietLogs.userId, userId),
        eq(schema.dietLogs.logDate, localDate),
        isNull(schema.dietLogs.supersededById),
      )),
      db.select().from(schema.mealPlanEntries).where(and(
        eq(schema.mealPlanEntries.userId, userId),
        eq(schema.mealPlanEntries.planDate, localDate),
      )).orderBy(asc(schema.mealPlanEntries.createdAt)),
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
      )).orderBy(desc(schema.healthObservationEvents.createdAt)),
      db.select().from(schema.activePlanAssignments).where(eq(schema.activePlanAssignments.userId, userId)),
      db.select().from(schema.userDecisionEvents).where(and(
        eq(schema.userDecisionEvents.userId, userId),
        or(
          sql`${schema.userDecisionEvents.subjectJson} ->> 'observedOn' = ${localDate}`,
          sql`${schema.userDecisionEvents.subjectJson} ->> 'logDate' = ${localDate}`,
          sql`${schema.userDecisionEvents.subjectJson} ->> 'planDate' = ${localDate}`,
          sql`${schema.userDecisionEvents.subjectJson} ->> 'date' = ${localDate}`,
          sql`(${schema.userDecisionEvents.createdAt} AT TIME ZONE ${timezone})::date = ${localDate}::date`,
        ),
      )).orderBy(asc(schema.userDecisionEvents.createdAt)),
      db.select({
        pendingEvents: sql<number>`count(*) filter (
          where ${schema.outboxEvents.status} in ('pending', 'processing')
        )::int`,
        deadLetterEvents: sql<number>`count(*) filter (
          where ${schema.outboxEvents.status} = 'dead_letter'
        )::int`,
      }).from(schema.outboxEvents).where(and(
        eq(schema.outboxEvents.userId, userId),
        or(
          sql`${schema.outboxEvents.payloadJson} ->> 'observedOn' = ${localDate}`,
          sql`${schema.outboxEvents.payloadJson} ->> 'logDate' = ${localDate}`,
        ),
      )),
      createCycleEngine(db).decide(userId, localDate),
    ]);

    // Structured training for the day (WO-HS-05): sessions + per-exercise
    // completion + set totals, so DailyState.training reflects reality even
    // when the coarse exercise_logs row is absent.
    const daySessions = await db.select().from(schema.trainingSessions).where(and(
      eq(schema.trainingSessions.userId, userId),
      eq(schema.trainingSessions.sessionDate, localDate),
    )).orderBy(asc(schema.trainingSessions.startedAt), asc(schema.trainingSessions.createdAt));
    const dayReflections = daySessions.length === 0
      ? []
      : await db.select().from(schema.trainingReflections).where(and(
          eq(schema.trainingReflections.userId, userId),
          inArray(schema.trainingReflections.sessionId, daySessions.map((session) => session.id)),
        )).orderBy(asc(schema.trainingReflections.createdAt));
    const latestSessionWithStatus = (status: string) => daySessions
      .filter((session) => session.status === status)
      .sort((left, right) => {
        const leftAt = left.finishedAt ?? left.startedAt ?? left.createdAt;
        const rightAt = right.finishedAt ?? right.startedAt ?? right.createdAt;
        return rightAt.getTime() - leftAt.getTime();
      })[0] ?? null;
    const primarySession = latestSessionWithStatus("in_progress")
      ?? latestSessionWithStatus("completed")
      ?? latestSessionWithStatus("interrupted");
    const allTrainingExercises = daySessions.length === 0
      ? []
      : await db.select().from(schema.trainingSessionExercises)
          .where(inArray(schema.trainingSessionExercises.sessionId, daySessions.map((session) => session.id)))
          .orderBy(asc(schema.trainingSessionExercises.orderIndex));
    const trainingExercises = primarySession === null
      ? []
      : allTrainingExercises.filter((exercise) => exercise.sessionId === primarySession.id);
    const setCounts = allTrainingExercises.length === 0
      ? []
      : await db.select({
          exerciseId: schema.trainingSetLogs.sessionExerciseId,
          doneSets: sql<number>`count(*)::int`,
        })
          .from(schema.trainingSetLogs)
          .where(inArray(
            schema.trainingSetLogs.sessionExerciseId,
            allTrainingExercises.map((exercise) => exercise.id),
          ))
          .groupBy(schema.trainingSetLogs.sessionExerciseId);
    const doneSetsByExercise = new Map(setCounts.map((count) => [count.exerciseId, count.doneSets]));
    const primaryVolume = summarizeSessionVolume(trainingExercises, doneSetsByExercise);
    const plannedSets = primaryVolume.plannedSetBudget;
    const completedSets = primaryVolume.completedSetBudget;
    const sessionSummaries: TrainingSessionSummary[] = daySessions.map((session) => {
      const exercises = allTrainingExercises.filter((exercise) => exercise.sessionId === session.id);
      const volume = summarizeSessionVolume(exercises, doneSetsByExercise);
      return {
        id: session.id,
        status: session.status,
        planVersionId: session.planVersionId,
        startedAt: session.startedAt?.toISOString() ?? null,
        finishedAt: session.finishedAt?.toISOString() ?? null,
        plannedExercises: volume.plannedExercises,
        completedExercises: volume.completedExercises,
        plannedSetBudget: volume.plannedSetBudget,
        completedSetBudget: volume.completedSetBudget,
        completionRate: volume.completionRate,
      };
    });

    const sleepObservation = latestEffectiveSingletonObservation(observations, "sleep");
    const fatigueObservation = latestEffectiveSingletonObservation(observations, "fatigue");
    const recoveryObservation = latestEffectiveSingletonObservation(observations, "recovery");
    const weightObservation = latestEffectiveSingletonObservation(observations, "weight");
    const toObservation = (
      observation: typeof schema.healthObservationEvents.$inferSelect,
    ): DailyStateObservation => ({
      id: observation.id,
      observedOn: observation.observedOn,
      kind: observation.kind,
      valueJson: observation.valueJson,
      source: observation.source,
      createdAt: observation.createdAt.toISOString(),
    });

    const trainingBlock = {
      recommendation,
      sessions: sessionSummaries,
      activeSessionId: primarySession?.id ?? null,
      plannedSetBudget: plannedSets,
      completedSetBudget: completedSets,
      completionRate: primaryVolume.completionRate,
      reflections: dayReflections.map((reflection): ReflectionSummary => ({
        id: reflection.id,
        sessionId: reflection.sessionId,
        completedVsPlanned: reflection.completedVsPlannedJson,
        bestCueRefs: reflection.bestCueRefs,
        unresolvedIssues: reflection.unresolvedIssuesJson,
        painSummary: reflection.painSummaryJson,
        proposedAdjustments: reflection.proposedAdjustmentsJson,
        nextValidationQuestions: reflection.nextValidationQuestions,
        proposalPlanVersionId: reflection.proposalPlanVersionId,
        userAcceptedAt: reflection.userAcceptedAt?.toISOString() ?? null,
        createdAt: reflection.createdAt.toISOString(),
      })),
      sessionId: primarySession?.id ?? null,
      status: primarySession?.status ?? null,
      plannedExercises: primaryVolume.plannedExercises,
      completedExercises: primaryVolume.completedExercises,
      plannedSets,
      completedSets,
      substitutions: primaryVolume.substitutions,
      painEvents: observations
        .filter((o) => o.kind === "pain")
        .map((o) => ({ valueJson: o.valueJson })),
    };

    const bodyBlock = {
      effectiveWeight: weightObservation ? toObservation(weightObservation) : null,
      effectiveSleep: sleepObservation ? toObservation(sleepObservation) : null,
      effectiveFatigue: fatigueObservation ? toObservation(fatigueObservation) : null,
      effectiveRecovery: recoveryObservation ? toObservation(recoveryObservation) : null,
      activePain: observations.filter((o) => o.kind === "pain").map(toObservation),
      observationHistory: observations.map(toObservation),
      weight: weightObservation?.valueJson ?? null,
      sleep: sleepObservation?.valueJson ?? null,
      fatigue: fatigueObservation?.valueJson ?? null,
      recovery: recoveryObservation?.valueJson ?? null,
      pain: trainingBlock.painEvents,
    };
    const plannedMeals = plannedMealRows.map((meal): PlannedMeal => ({
      id: meal.id,
      planDate: meal.planDate,
      mealType: meal.mealType,
      dishName: meal.dishName,
      recipeSlug: meal.recipeSlug,
      status: meal.status,
      ingredients: meal.ingredientsJson,
      seasonings: meal.seasoningsJson,
      nutrition: nutritionFromRow(meal),
    }));
    const actualLogs = dietLogs.map((log): ActualMeal => ({
      id: log.id,
      logDate: log.logDate,
      loggedAt: log.loggedAt.toISOString(),
      mealType: log.mealType,
      description: log.description,
      source: log.source,
      uncertain: log.uncertain === true,
      estimateConfidence: log.estimateConfidence,
      correctionOfId: log.correctionOfId,
      nutrition: nutritionFromRow(log),
    }));
    const plannedTotals = sumNutrition(plannedMealRows);
    const actualTotals = sumNutrition(dietLogs);
    const activePlanMap = new Map(assignments.map((assignment) => [assignment.scope, assignment.planVersionId]));
    const userDecisions = decisionRows.map((decision): UserDecision => ({
      id: decision.id,
      decisionType: decision.decisionType,
      subject: decision.subjectJson,
      journeyId: decision.journeyId,
      createdAt: decision.createdAt.toISOString(),
    }));
    const activeConstraints = constraints.map((constraint): ActiveConstraint => ({
      id: constraint.id,
      constraintType: constraint.constraintType,
      severity: constraint.severity,
      target: constraint.targetJson,
      reason: constraint.reason,
      activeFrom: constraint.activeFrom,
      activeTo: constraint.activeTo,
      sourceObservationId: constraint.sourceObservationId,
      createdAt: constraint.createdAt.toISOString(),
    }));
    const basis: EvidenceReference[] = [
      ...assignments.map((assignment) => ({
        type: "plan_version",
        id: assignment.planVersionId,
        role: `active_${assignment.scope}`,
      })),
      ...plannedMealRows.map((meal) => ({ type: "meal_plan_entry", id: meal.id, role: "diet_planned" })),
      ...dietLogs.map((log) => ({ type: "diet_log", id: log.id, role: "diet_actual" })),
      ...observations.map((observation) => ({
        type: "health_observation",
        id: observation.id,
        role: observation.kind,
      })),
      ...constraints.map((constraint) => ({
        type: "health_constraint",
        id: constraint.id,
        role: constraint.severity,
      })),
      ...daySessions.map((session) => ({ type: "training_session", id: session.id, role: session.status })),
      ...dayReflections.map((reflection) => ({
        type: "training_reflection",
        id: reflection.id,
        role: "post_session_reflection",
      })),
      ...decisionRows.map((decision) => ({
        type: "user_decision",
        id: decision.id,
        role: decision.decisionType,
      })),
    ];
    const nextAdjustments: Adjustment[] = [];
    if (plannedTotals.caloriesKcal > 0 && actualTotals.caloriesKcal > plannedTotals.caloriesKcal) {
      nextAdjustments.push({
        kind: "rebalance_remaining_diet",
        reasonCode: "diet_actual_above_plan",
        targetId: null,
        detail: { caloriesKcal: actualTotals.caloriesKcal - plannedTotals.caloriesKcal },
        basis: dietLogs.map((log) => ({ type: "diet_log", id: log.id, role: "diet_actual" })),
      });
    }
    for (const log of actualLogs.filter((candidate) => candidate.uncertain)) {
      nextAdjustments.push({
        kind: "review_uncertain_estimate",
        reasonCode: "diet_estimate_uncertain",
        targetId: log.id,
        detail: { confidence: log.estimateConfidence, description: log.description },
        basis: [{ type: "diet_log", id: log.id, role: "uncertain_estimate" }],
      });
    }
    for (const reflection of dayReflections) {
      for (const proposed of reflection.proposedAdjustmentsJson) {
        nextAdjustments.push({
          kind: "training_reflection_proposal",
          reasonCode: "reflection_proposed_adjustment",
          targetId: reflection.sessionId,
          detail: proposed,
          basis: [{ type: "training_reflection", id: reflection.id, role: "proposal_source" }],
        });
      }
      for (const question of reflection.nextValidationQuestions) {
        nextAdjustments.push({
          kind: "validate_training_adjustment",
          reasonCode: "reflection_validation_question",
          targetId: reflection.sessionId,
          detail: { question },
          basis: [{ type: "training_reflection", id: reflection.id, role: "validation_source" }],
        });
      }
    }
    const pendingEvents = projectionEventCounts[0]?.pendingEvents ?? 0;
    const deadLetterEvents = projectionEventCounts[0]?.deadLetterEvents ?? 0;
    const projectionStatus: ProjectionStatus = deadLetterEvents > 0
      ? "failed"
      : pendingEvents > 0
        ? "lagging"
        : "fresh";

    return {
      schemaVersion: "daily-health-state.v2",
      userId,
      localDate,
      timezone,
      revision: 0, // filled by persistDailyProjection
      plans: {
        dietPlanVersionId: activePlanMap.get("diet") ?? null,
        trainingPlanVersionId: activePlanMap.get("training_template") ?? null,
        trainingCycleVersionId: activePlanMap.get("training_cycle") ?? null,
      },
      constraints: activeConstraints,
      userDecisions,
      nextAdjustments,
      basis,
      activePlans: Object.fromEntries(assignments.map((a) => [a.scope, a.planVersionId])),
      diet: {
        plannedMeals,
        actualLogs,
        plannedTotals,
        actualTotals,
        deviation: subtractNutrition(actualTotals, plannedTotals),
        uncertainEstimates: actualLogs
          .filter((log) => log.uncertain)
          .map((log) => ({
            dietLogId: log.id,
            description: log.description,
            confidence: log.estimateConfidence,
            reason: "estimate_marked_uncertain" as const,
          })),
      },
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
      projection: {
        status: projectionStatus,
        pendingEvents,
        deadLetterEvents,
        builtAt: new Date().toISOString(),
      },
    };
  }

  async function persistDailyProjection(
    userId: string,
    localDate: string,
    timezone: string,
    status: ProjectionStatus = "fresh",
  ): Promise<DailyStateReadModel> {
    return db.transaction(async (tx) => {
      const transactionDb = tx as unknown as Db;
      await acquireDailyProjectionTransactionLock(transactionDb, userId, localDate);
      const transactionState = createDailyStateService(
        transactionDb,
        createRepository(transactionDb),
      );
      const state = await transactionState.buildDailyState(userId, localDate, timezone);
      return transactionState.persistBuiltProjection(state, status);
    });
  }

  /**
   * Persist an already-built read model. The caller must hold the user/day
   * transaction lock above; projection workers also lock and re-check their
   * outbox lease in that same transaction.
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
      schemaVersion: state.schemaVersion,
      revision,
      timezone,
      stateJson: payload as unknown as Record<string, unknown>,
      sourceEventCount: state.basis.length,
      projectionStatus: status,
      builtAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.dailyHealthStateProjection.userId, schema.dailyHealthStateProjection.stateDate],
      set: {
        revision,
        schemaVersion: state.schemaVersion,
        stateJson: payload as unknown as Record<string, unknown>,
        sourceEventCount: state.basis.length,
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
    if (
      row.schemaVersion !== "daily-health-state.v2"
      || (row.stateJson as { schemaVersion?: unknown }).schemaVersion !== "daily-health-state.v2"
    ) return undefined;

    const counts = await db.select({
      pendingEvents: sql<number>`count(*) filter (
        where ${schema.outboxEvents.status} in ('pending', 'processing')
      )::int`,
      deadLetterEvents: sql<number>`count(*) filter (
        where ${schema.outboxEvents.status} = 'dead_letter'
      )::int`,
    })
      .from(schema.outboxEvents)
      .where(and(
        eq(schema.outboxEvents.userId, userId),
        or(
          sql`${schema.outboxEvents.payloadJson} ->> 'observedOn' = ${localDate}`,
          sql`${schema.outboxEvents.payloadJson} ->> 'logDate' = ${localDate}`,
        ),
      ));

    const pendingEvents = counts[0]?.pendingEvents ?? 0;
    const deadLetterEvents = counts[0]?.deadLetterEvents ?? 0;
    const status: ProjectionStatus = row.projectionStatus === "failed" || deadLetterEvents > 0
      ? "failed"
      : row.projectionStatus === "rebuilding"
        ? "rebuilding"
        : row.projectionStatus === "lagging" || pendingEvents > 0
          ? "lagging"
          : "fresh";

    return {
      ...row.stateJson as unknown as DailyStateReadModel,
      projection: {
        ...(row.stateJson as unknown as DailyStateReadModel).projection,
        status,
        pendingEvents,
        deadLetterEvents,
        pendingOutboxEvents: pendingEvents,
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
