/**
 * WO-HS-07 / M21: training cycle engine and readiness policy.
 *
 * Cycle decision is explainable and data-driven: next position in the active
 * plan's cyclePattern, adjusted by recent completion and body state. In
 * shadow mode (default) the recommendation is advisory only — it never
 * silently changes the active plan (plan §十).
 */
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface CycleDecision {
  decision: "A" | "B" | "C" | "REST";
  reasonCodes: string[];
  adjustments: string[];
  requiresConfirmation: boolean;
}

const DEFAULT_CYCLE = ["A", "B", "REST", "C", "REST"];

export function createCycleEngine(db: Db) {
  /**
   * Decide today's training day from the active cycle pattern + recent history
   * + body observations. Purely derived; no writes.
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

    // Recent completed sessions (last 14 days), oldest first.
    const since = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
    const recent = await db.select().from(schema.trainingSessions)
      .where(and(
        eq(schema.trainingSessions.userId, userId),
        eq(schema.trainingSessions.status, "completed"),
        gte(schema.trainingSessions.sessionDate, since),
      ))
      .orderBy(schema.trainingSessions.sessionDate);

    const workDays = recent
      .map((s) => s.sessionDate)
      .filter((d) => d !== onDate);
    const lastWorkDay = workDays[workDays.length - 1] ?? null;

    // Next non-REST position after the last completed working day.
    const completedWorkCount = workDays.length;
    if (completedWorkCount === 0) {
      return {
        decision: pattern.find((p) => p !== "REST") as ("A" | "B" | "C") ?? "A",
        reasonCodes: ["cycle_start"],
        adjustments: [],
        requiresConfirmation: false,
      };
    }
    const workPositions = pattern.map((p, i) => ({ p, i })).filter((x) => x.p !== "REST");
    const nextPosition = workPositions[completedWorkCount % workPositions.length]!;
    let decision: CycleDecision = {
      decision: nextPosition.p as "A" | "B" | "C",
      reasonCodes: ["cycle_next", ...(lastWorkDay ? [`last_session_${lastWorkDay}`] : [])],
      adjustments: [],
      requiresConfirmation: false,
    };

    // Readiness inputs: sleep/fatigue/recovery/pain observations today or yesterday.
    const obsSince = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    const observations = await db.select().from(schema.healthObservationEvents)
      .where(and(
        eq(schema.healthObservationEvents.userId, userId),
        gte(schema.healthObservationEvents.observedOn, obsSince),
        isNull(schema.healthObservationEvents.revokedAt),
      ))
      .orderBy(desc(schema.healthObservationEvents.createdAt));

    const sleepHours = (() => {
      for (const o of observations) {
        if (o.kind === "sleep") {
          const hours = (o.valueJson as { hours?: number }).hours;
          if (typeof hours === "number") return hours;
        }
      }
      return undefined;
    })();
    const fatigueHigh = observations.some((o) => o.kind === "fatigue");
    const activePainBlock = await db.select({ n: sql<number>`count(*)::int` })
      .from(schema.healthConstraints)
      .where(and(
        eq(schema.healthConstraints.userId, userId),
        eq(schema.healthConstraints.severity, "block"),
        isNull(schema.healthConstraints.liftedAt),
      ));
    const painBlocked = (activePainBlock[0]?.n ?? 0) > 0;

    const reasonCodes: string[] = [];
    let rest = false;
    if (sleepHours !== undefined && sleepHours < 5.5) {
      reasonCodes.push("sleep_low");
      rest = true;
    }
    if (fatigueHigh) {
      reasonCodes.push("fatigue_high");
      rest = true;
    }

    if (rest || painBlocked) {
      return {
        decision: "REST",
        reasonCodes: [...reasonCodes, ...(painBlocked ? ["active_block_constraint"] : [])],
        adjustments: rest ? ["delay_next_training"] : [],
        requiresConfirmation: false,
      };
    }
    void decision;
    return {
      ...decision,
      reasonCodes: [...decision.reasonCodes, ...(sleepHours !== undefined ? [`sleep_${sleepHours}h_ok`] : [])],
    };
  }

  return { decide };
}
