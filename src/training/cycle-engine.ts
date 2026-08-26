/**
 * P0-5 / M21: training cycle engine and readiness policy.
 *
 * The cycle is EXPLICIT state now: training_cycle_instances /
 * training_cycle_positions advance one position per finished or skipped
 * working day. Readiness is judged per movement-pattern family of the
 * CANDIDATE training day — shoulder pain must not block safe leg work, knee
 * pain must not block safe upper-body work. Fatigue requires an explicit
 * structured payload ({level, scope}) — the mere existence of a fatigue row
 * no longer forces REST. In shadow mode the recommendation stays advisory:
 * it never silently changes the active plan (plan §十).
 */
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import { latestEffectiveSingletonObservation } from "../domain/observation-policy.js";
import { THREE_SPLIT_DAYS } from "./three-split.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface CycleDecision {
  decision: "A" | "B" | "C" | "REST";
  reasonCodes: string[];
  adjustments: string[];
  requiresConfirmation: boolean;
  /** Explicit cycle bookkeeping returned so callers can inspect progress. */
  cycleInstanceId?: string;
  positionIndex?: number;
}

const DEFAULT_CYCLE = ["A", "B", "REST", "C", "REST"];

function addCalendarDays(localDate: string, days: number): string {
  const value = new Date(`${localDate}T00:00:00.000Z`);
  if (Number.isNaN(value.getTime())) throw new RangeError(`invalid local date: ${localDate}`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Movement patterns each A/B/C reference day trains (from the seed program). */
function patternsForRole(role: string): string[] {
  const day = THREE_SPLIT_DAYS.find((d) => d.dayRole === role);
  const patterns = new Set<string>();
  for (const item of day?.items ?? []) {
    if (typeof item.movementPattern === "string") patterns.add(item.movementPattern);
  }
  return [...patterns];
}

interface StructuredFatigue {
  level: number;
  scope?: "general" | "local" | string;
  feedback?: unknown;
}

/** Fatigue counts as high ONLY with explicit structured evidence. */
function fatigueIsHigh(value: unknown): { high: boolean; level?: number } {
  const f = value as Partial<StructuredFatigue> | null | undefined;
  const level = typeof f?.level === "number" ? f.level : undefined;
  // Legacy rows without a numeric level are NOT treated as high fatigue.
  return { high: typeof level === "number" && level >= 4, level };
}

export function createCycleEngine(db: Db) {
  /**
   * Decide today's training day from explicit cycle positions + body state.
   * Purely derived; no writes. Positions are advanced by recordCycleOutcome.
   */
  async function decide(userId: string, onDate: string): Promise<CycleDecision> {
    const [assignment] = await db.select().from(schema.activePlanAssignments)
      .where(and(eq(schema.activePlanAssignments.userId, userId), eq(schema.activePlanAssignments.scope, "training_template")))
      .limit(1);
    let pattern = DEFAULT_CYCLE;
    if (assignment) {
      const [version] = await db.select().from(schema.planVersions)
        .where(eq(schema.planVersions.id, assignment.planVersionId))
        .limit(1);
      const content = version?.contentJson as { cyclePattern?: string[] } | undefined;
      if (content?.cyclePattern && content.cyclePattern.length > 0) pattern = content.cyclePattern;
    }

    // The active cycle instance holds the explicit next-position cursor.
    const [instance] = await db.select().from(schema.trainingCycleInstances)
      .where(and(
        eq(schema.trainingCycleInstances.userId, userId),
        eq(schema.trainingCycleInstances.status, "active"),
      ))
      .orderBy(desc(schema.trainingCycleInstances.startedAt))
      .limit(1);

    const positions = instance
      ? await db.select().from(schema.trainingCyclePositions)
          .where(eq(schema.trainingCyclePositions.cycleInstanceId, instance.id))
          .orderBy(asc(schema.trainingCyclePositions.positionIndex))
      : [];
    const settled = positions.filter((p) => p.status !== "pending");
    const nextIndex = instance !== undefined
      ? (settled[settled.length - 1]?.positionIndex ?? -1) + 1
      : 0;
    const role = pattern[nextIndex % pattern.length] ?? "A";

    const reasonCodes: string[] = [
      ...(instance === undefined ? ["cycle_start"] : []),
      `position_${nextIndex}`,
    ];

    // ── Readiness: scoped to the CANDIDATE day's movement patterns ──
    if (role === "REST") {
      return {
        decision: "REST",
        reasonCodes: [...reasonCodes, "scheduled_rest"],
        adjustments: [],
        requiresConfirmation: false,
        ...(instance ? { cycleInstanceId: instance.id } : {}),
        positionIndex: nextIndex,
      };
    }

    const candidatePatterns = patternsForRole(role);
    const obsSince = addCalendarDays(onDate, -2);
    const observations = await db.select().from(schema.healthObservationEvents)
      .where(and(
        eq(schema.healthObservationEvents.userId, userId),
        gte(schema.healthObservationEvents.observedOn, obsSince),
        isNull(schema.healthObservationEvents.revokedAt),
      ))
      .orderBy(
        desc(schema.healthObservationEvents.observedOn),
        desc(schema.healthObservationEvents.createdAt),
      );

    const sleepObservation = latestEffectiveSingletonObservation(observations, "sleep");
    const sleepHours = (sleepObservation?.valueJson as { hours?: number } | undefined)?.hours;
    const fatigueObservation = latestEffectiveSingletonObservation(observations, "fatigue");

    const adjustments: string[] = [];
    let rest = false;

    if (sleepHours !== undefined && sleepHours < 5.5) {
      reasonCodes.push("sleep_low");
      rest = true;
    }

    if (fatigueObservation) {
      const { high, level } = fatigueIsHigh(fatigueObservation.valueJson);
      const scope = (fatigueObservation.valueJson as Partial<StructuredFatigue>).scope ?? "general";
      if (high) {
        if (scope === "general") {
          reasonCodes.push(`fatigue_high_general_${level}`);
          rest = true;
        } else {
          // Local fatigue only adjusts; it never forces a full rest day.
          reasonCodes.push(`fatigue_high_local_${level}`);
          adjustments.push("reduce_intensity_for_fatigued_area");
        }
      }
    }

    // Active block constraints that intersect THIS day's patterns force REST;
    // constraints on other families do not (肩痛不阻止腿部日).
    const candidateBlocked = candidatePatterns.length > 0
      ? await db.select({ target: schema.healthConstraints.targetJson })
          .from(schema.healthConstraints)
          .where(and(
            eq(schema.healthConstraints.userId, userId),
            eq(schema.healthConstraints.severity, "block"),
            isNull(schema.healthConstraints.liftedAt),
            sql`${schema.healthConstraints.activeFrom} <= ${onDate}`,
            or(isNull(schema.healthConstraints.activeTo), sql`${schema.healthConstraints.activeTo} >= ${onDate}`),
          ))
      : [];
    const { blockedPatternsForBodyPart } = await import("./prepared-session.js");
    const blockedHere: string[] = [];
    for (const c of candidateBlocked) {
      const target = c.target as { movementPattern?: string; bodyPart?: string };
      if (target.movementPattern !== undefined && candidatePatterns.includes(target.movementPattern)) {
        blockedHere.push(target.movementPattern);
      }
      for (const pattern of blockedPatternsForBodyPart(target.bodyPart)) {
        if (candidatePatterns.includes(pattern)) blockedHere.push(pattern);
      }
    }
    const fullyBlocked = candidatePatterns.length > 0
      && blockedHere.length >= candidatePatterns.length;
    const partiallyBlocked = !fullyBlocked && blockedHere.length > 0;
    if (fullyBlocked) {
      reasonCodes.push("active_block_constraint_covers_day_patterns");
      rest = true;
    } else if (partiallyBlocked) {
      reasonCodes.push("active_block_constraint_partial");
      adjustments.push(`skip_blocked_patterns:${blockedHere.join("|")}`);
    }

    if (rest) {
      return {
        decision: "REST",
        reasonCodes,
        adjustments,
        requiresConfirmation: false,
        ...(instance ? { cycleInstanceId: instance.id } : {}),
        positionIndex: nextIndex,
      };
    }

    void role;
    return {
      decision: role as "A" | "B" | "C",
      reasonCodes: [...reasonCodes, ...(sleepHours !== undefined ? [`sleep_${sleepHours}h_ok`] : [])],
      adjustments,
      requiresConfirmation: false,
      ...(instance ? { cycleInstanceId: instance.id } : {}),
      positionIndex: nextIndex,
    };
  }

  /**
   * Advance the explicit cycle after a working day settles. Called when a
   * session finishes (completed → position completed; readiness-skip →
   * skipped_readiness). Idempotent per (instance, index).
   */
  async function recordCycleOutcome(input: {
    userId: string;
    sessionId?: string;
    outcome: "completed" | "skipped_readiness";
    reasonCode?: string;
    onDate: string;
  }): Promise<{ cycleInstanceId: string; positionIndex: number }> {
    return db.transaction(async (tx) => {
      const [assignment] = await tx.select().from(schema.activePlanAssignments)
        .where(and(eq(schema.activePlanAssignments.userId, input.userId), eq(schema.activePlanAssignments.scope, "training_template")))
        .limit(1);
      let pattern = DEFAULT_CYCLE;
      let versionId: string | null = null;
      if (assignment) {
        const [version] = await tx.select().from(schema.planVersions)
          .where(eq(schema.planVersions.id, assignment.planVersionId))
          .limit(1);
        versionId = assignment.planVersionId;
        const content = version?.contentJson as { cyclePattern?: string[] } | undefined;
        if (content?.cyclePattern && content.cyclePattern.length > 0) pattern = content.cyclePattern;
      }

      let [instance] = await tx.select().from(schema.trainingCycleInstances)
        .where(and(
          eq(schema.trainingCycleInstances.userId, input.userId),
          eq(schema.trainingCycleInstances.status, "active"),
        ))
        .orderBy(desc(schema.trainingCycleInstances.startedAt))
        .limit(1)
        .for("update");
      if (!instance) {
        const created = await tx.insert(schema.trainingCycleInstances).values({
          userId: input.userId,
          cycleVersionId: versionId,
        }).returning();
        instance = created[0]!;
      }

      const positions = await tx.select().from(schema.trainingCyclePositions)
        .where(eq(schema.trainingCyclePositions.cycleInstanceId, instance.id))
        .orderBy(asc(schema.trainingCyclePositions.positionIndex));
      const settled = positions.filter((p) => p.status !== "pending");
      const nextIndex = (settled[settled.length - 1]?.positionIndex ?? -1) + 1;
      const role = pattern[nextIndex % pattern.length]!;

      await tx.insert(schema.trainingCyclePositions).values({
        cycleInstanceId: instance.id,
        userId: input.userId,
        positionIndex: nextIndex,
        positionRole: role,
        sessionId: input.sessionId ?? null,
        status: role === "REST" ? "skipped_rest"
          : input.outcome === "completed" ? "completed" : "skipped_readiness",
        reason: input.reasonCode ?? null,
        positionDate: input.onDate,
      });

      // When we just consumed the LAST position of the pattern, retire the
      // instance so the next decide() starts a fresh cycle run.
      if ((nextIndex + 1) % pattern.length === 0) {
        await tx.update(schema.trainingCycleInstances)
          .set({ status: "retired", updatedAt: new Date() })
          .where(eq(schema.trainingCycleInstances.id, instance.id));
      }

      return { cycleInstanceId: instance.id, positionIndex: nextIndex };
    });
  }

  /** Positions for inspection/testing. */
  async function listPositions(userId: string): Promise<Array<typeof schema.trainingCyclePositions.$inferSelect>> {
    const instances = await db.select({ id: schema.trainingCycleInstances.id })
      .from(schema.trainingCycleInstances)
      .where(eq(schema.trainingCycleInstances.userId, userId));
    if (instances.length === 0) return [];
    return db.select().from(schema.trainingCyclePositions)
      .where(inArray(schema.trainingCyclePositions.cycleInstanceId, instances.map((i) => i.id)))
      .orderBy(asc(schema.trainingCyclePositions.createdAt));
  }

  async function acknowledgeRest(input: {
    userId: string;
    onDate: string;
    reasonCode?: string;
  }): Promise<CycleDecision & { cycleInstanceId: string; positionIndex: number }> {
    const decision = await decide(input.userId, input.onDate);
    if (decision.decision !== "REST") {
      throw new RangeError(`current cycle decision is ${decision.decision}, not REST`);
    }
    const position = await recordCycleOutcome({
      userId: input.userId,
      outcome: "skipped_readiness",
      reasonCode: input.reasonCode ?? decision.reasonCodes.join("|"),
      onDate: input.onDate,
    });
    return { ...decision, ...position };
  }

  return { decide, recordCycleOutcome, listPositions, acknowledgeRest };
}
