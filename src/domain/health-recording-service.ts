import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

const ACTIVITY_TYPES = new Set(["running", "walking", "cycling", "swimming", "strength"]);

export function createHealthRecordingService(db: Db) {
  async function recordWater(input: {
    userId: string;
    date: string;
    amountMl: unknown;
    source: string;
  }) {
    const amount = Number(input.amountMl);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) {
      throw new RangeError("amountMl must be 1..10000");
    }
    const [created] = await db.insert(schema.waterLogs).values({
      userId: input.userId,
      logDate: input.date,
      amountMl: Math.round(amount),
      source: input.source,
    }).returning();
    if (!created) throw new Error("water insert returned no row");
    const [outbox] = await db.insert(schema.outboxEvents).values({
      userId: input.userId,
      aggregateType: "water_log",
      aggregateId: created.id,
      eventType: "health.water_recorded",
      payloadJson: { observedOn: input.date },
    }).returning({ id: schema.outboxEvents.id });
    const [readBack] = await db.select().from(schema.waterLogs).where(and(
      eq(schema.waterLogs.id, created.id),
      eq(schema.waterLogs.userId, input.userId),
    )).limit(1);
    if (!outbox || !readBack) throw new Error("water write read-back failed");
    return { log: readBack, outboxId: outbox.id };
  }

  async function recordActivity(input: {
    userId: string;
    date: string;
    activityType: unknown;
    durationMinutes: unknown;
    caloriesBurnedKcal?: unknown;
  }) {
    const activityType = typeof input.activityType === "string" ? input.activityType : "";
    if (!ACTIVITY_TYPES.has(activityType)) throw new RangeError("unsupported activityType");
    const duration = Number(input.durationMinutes);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600) {
      throw new RangeError("durationMinutes must be 1..600");
    }
    const calories = input.caloriesBurnedKcal === undefined ? 0 : Number(input.caloriesBurnedKcal);
    if (!Number.isFinite(calories) || calories < 0) throw new RangeError("caloriesBurnedKcal must be non-negative");
    const [created] = await db.insert(schema.exerciseLogs).values({
      userId: input.userId,
      logDate: input.date,
      activityType,
      durationMinutes: Math.round(duration),
      caloriesBurnedKcal: calories,
    }).returning();
    if (!created) throw new Error("activity insert returned no row");
    const [outbox] = await db.insert(schema.outboxEvents).values({
      userId: input.userId,
      aggregateType: "activity_log",
      aggregateId: created.id,
      eventType: "health.activity_recorded",
      payloadJson: { observedOn: input.date },
    }).returning({ id: schema.outboxEvents.id });
    const [readBack] = await db.select().from(schema.exerciseLogs).where(and(
      eq(schema.exerciseLogs.id, created.id),
      eq(schema.exerciseLogs.userId, input.userId),
    )).limit(1);
    if (!outbox || !readBack) throw new Error("activity write read-back failed");
    return { log: readBack, outboxId: outbox.id };
  }

  async function recordSleep(input: { userId: string; date: string; hours: unknown; source: string }) {
    const hours = Number(input.hours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
      throw new RangeError("hours must be 0..24");
    }
    return recordObservation({
      userId: input.userId,
      date: input.date,
      kind: "sleep",
      valueJson: { hours },
      source: input.source,
      eventType: "health.sleep_recorded",
    });
  }

  async function recordFatigue(input: {
    userId: string;
    date: string;
    level: unknown;
    scope: unknown;
    feedback?: unknown;
    source: string;
  }) {
    const level = Number(input.level);
    if (!Number.isFinite(level) || level < 1 || level > 5) {
      throw new RangeError("level must be 1..5 (structured fatigue is required)");
    }
    if (input.scope !== "general" && input.scope !== "local") {
      throw new RangeError("scope must be general|local");
    }
    return recordObservation({
      userId: input.userId,
      date: input.date,
      kind: "fatigue",
      valueJson: {
        level,
        scope: input.scope,
        ...(typeof input.feedback === "string" && input.feedback.trim()
          ? { feedback: input.feedback.trim() }
          : {}),
      },
      source: input.source,
      eventType: "health.fatigue_recorded",
    });
  }

  async function recordObservation(input: {
    userId: string;
    date: string;
    kind: "sleep" | "fatigue";
    valueJson: Record<string, unknown>;
    source: string;
    eventType: string;
  }) {
    const [created] = await db.insert(schema.healthObservationEvents).values({
      userId: input.userId,
      observedOn: input.date,
      kind: input.kind,
      valueJson: input.valueJson,
      source: input.source,
    }).returning();
    if (!created) throw new Error(`${input.kind} observation insert returned no row`);
    const [outbox] = await db.insert(schema.outboxEvents).values({
      userId: input.userId,
      aggregateType: "observation",
      aggregateId: created.id,
      eventType: input.eventType,
      payloadJson: { observedOn: input.date },
    }).returning({ id: schema.outboxEvents.id });
    const [readBack] = await db.select().from(schema.healthObservationEvents).where(and(
      eq(schema.healthObservationEvents.id, created.id),
      eq(schema.healthObservationEvents.userId, input.userId),
    )).limit(1);
    if (!outbox || !readBack) throw new Error(`${input.kind} write read-back failed`);
    return { observation: readBack, outboxId: outbox.id };
  }

  return { recordWater, recordActivity, recordSleep, recordFatigue };
}
