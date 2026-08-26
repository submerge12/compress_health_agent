import { and, eq, gte, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

function addCalendarDays(localDate: string, days: number): string {
  const value = new Date(`${localDate}T00:00:00.000Z`);
  if (Number.isNaN(value.getTime())) throw new RangeError(`invalid local date: ${localDate}`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function markMaterializedDatesLagging(
  db: Db,
  userId: string,
  affectedDates: readonly string[],
): Promise<void> {
  if (affectedDates.length === 0) return;
  await db.update(schema.dailyHealthStateProjection)
    .set({ projectionStatus: "lagging", updatedAt: new Date() })
    .where(and(
      eq(schema.dailyHealthStateProjection.userId, userId),
      inArray(schema.dailyHealthStateProjection.stateDate, [...affectedDates]),
    ));
}

export function createProjectionInvalidationService(db: Db) {
  async function invalidateDietPlanRange(input: {
    userId: string;
    startDate: string;
    dayCount: number;
    status: string;
    entryCountByDate: ReadonlyMap<string, number>;
  }): Promise<{ affectedDates: string[]; outboxEventIds: string[] }> {
    const affectedDates = Array.from(
      { length: input.dayCount },
      (_, index) => addCalendarDays(input.startDate, index),
    );
    const endDate = affectedDates.at(-1) ?? input.startDate;
    await markMaterializedDatesLagging(db, input.userId, affectedDates);
    const events = await db.insert(schema.outboxEvents).values(affectedDates.map((observedOn) => ({
      userId: input.userId,
      aggregateType: "diet_plan",
      aggregateId: `${input.startDate}:${observedOn}`,
      eventType: "diet_plan.changed",
      payloadJson: {
        observedOn,
        startDate: input.startDate,
        endDate,
        status: input.status,
        entries: input.entryCountByDate.get(observedOn) ?? 0,
      },
    }))).returning({ id: schema.outboxEvents.id });
    if (events.length !== affectedDates.length) throw new Error("diet plan invalidation outbox insert failed");
    return { affectedDates, outboxEventIds: events.map((event) => event.id) };
  }

  async function invalidateTrainingPlanFuture(input: {
    userId: string;
    effectiveFrom: string;
    planVersionId: string;
    previousVersionId: string;
    direction: "forward" | "rollback";
  }): Promise<{ affectedDates: string[]; outboxEventIds: string[] }> {
    const [projectionDates, sessionDates] = await Promise.all([
      db.select({ date: schema.dailyHealthStateProjection.stateDate })
        .from(schema.dailyHealthStateProjection)
        .where(and(
          eq(schema.dailyHealthStateProjection.userId, input.userId),
          gte(schema.dailyHealthStateProjection.stateDate, input.effectiveFrom),
        )),
      db.select({ date: schema.trainingSessions.sessionDate })
        .from(schema.trainingSessions)
        .where(and(
          eq(schema.trainingSessions.userId, input.userId),
          gte(schema.trainingSessions.sessionDate, input.effectiveFrom),
        )),
    ]);
    const affectedDates = [...new Set([
      input.effectiveFrom,
      ...projectionDates.map((row) => row.date),
      ...sessionDates.map((row) => row.date),
    ])].sort();
    await markMaterializedDatesLagging(db, input.userId, affectedDates);
    const events = await db.insert(schema.outboxEvents).values(affectedDates.map((observedOn) => ({
      userId: input.userId,
      aggregateType: "plan_version",
      aggregateId: input.planVersionId,
      eventType: "plan.version_activated",
      payloadJson: {
        observedOn,
        effectiveFrom: input.effectiveFrom,
        planVersionId: input.planVersionId,
        previousVersionId: input.previousVersionId,
        direction: input.direction,
      },
    }))).returning({ id: schema.outboxEvents.id });
    if (events.length !== affectedDates.length) throw new Error("training plan invalidation outbox insert failed");
    return { affectedDates, outboxEventIds: events.map((event) => event.id) };
  }

  return { invalidateDietPlanRange, invalidateTrainingPlanFuture };
}
