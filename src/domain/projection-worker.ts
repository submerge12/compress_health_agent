/**
 * WO-HS-05 / M19: projection worker — reliable outbox consumption.
 *
 * Invariants (plan §八, J09):
 * - every event type that affects the daily state is projected; UNKNOWN event
 *   types are dead-lettered with last_error=unsupported_event_type and raise
 *   an operational interaction event — never silently "done";
 * - multi-worker safety: pending rows are claimed with FOR UPDATE SKIP
 *   LOCKED so two workers never process the same event;
 * - retries: immediate, then exponential backoff via available_at;
 *   MAX_ATTEMPTS exhausted -> dead_letter (visible, replayable);
 * - a projection failure NEVER rolls back committed facts.
 */
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import { createDailyStateService, type DailyStateService } from "./daily-state.js";
import { createTimezoneResolver, createUserLocalDateResolver } from "./timezone.js";
import type { Repository } from "../db/repository.js";

type Db = PostgresJsDatabase<typeof schema>;

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;
const DEFAULT_LEASE_MS = 30_000;

/** Event types this worker knows how to project. */
export const SUPPORTED_AGGREGATE_TYPES: ReadonlySet<string> = new Set([
  "diet_log",
  "observation",
  "water_log",
  "activity_log",
  "constraint",
  "training_session",
  "training_set",
  "training_substitution",
  "training_reflection",
  "plan_version",
  "user_decision",
]);

/** Backoff for attempt n (1-based): immediate, 5s, 20s, 60s, 120s. */
function backoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  const table = [0, 0, 5_000, 20_000, 60_000];
  return table[Math.min(attempt, table.length - 1)] ?? 120_000;
}

function eventMatchesDate(localDate: string) {
  return or(
    sql`${schema.outboxEvents.payloadJson} ->> 'observedOn' = ${localDate}`,
    sql`${schema.outboxEvents.payloadJson} ->> 'logDate' = ${localDate}`,
  )!;
}

export interface WorkerRunResult {
  processed: number;
  succeeded: number;
  deadLettered: number;
  requeued: number;
}

export interface ProjectionWorkerOptions {
  workerId?: string;
  leaseMs?: number;
  batchSize?: number;
  now?: () => Date;
}

export function createProjectionWorker(
  db: Db,
  repo: Repository,
  options: ProjectionWorkerOptions = {},
) {
  const dailyState: DailyStateService = createDailyStateService(db, repo);
  const now = options.now ?? (() => new Date());
  const resolveTimezone = createTimezoneResolver(db);
  const getUserLocalDate = createUserLocalDateResolver(db, now);
  const workerId = options.workerId ?? `projection-${process.pid}-${randomUUID()}`;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const batchSize = options.batchSize ?? BATCH_SIZE;

  async function extractEventDay(event: typeof schema.outboxEvents.$inferSelect): Promise<string> {
    const payloadDay = (event.payloadJson as { observedOn?: string; logDate?: string } | null)?.observedOn
      ?? (event.payloadJson as { logDate?: string } | null)?.logDate;
    return payloadDay ?? getUserLocalDate(event.userId);
  }

  /** Persist ownership before the row lock is released. Expired leases are reclaimable. */
  async function claimNext(
    claimAt: Date,
    onlyUserId?: string,
  ): Promise<typeof schema.outboxEvents.$inferSelect | undefined> {
    return db.transaction(async (tx) => {
      const claimed = await tx.select().from(schema.outboxEvents)
        .where(and(
          or(
            and(
              eq(schema.outboxEvents.status, "pending"),
              lte(schema.outboxEvents.availableAt, claimAt),
            ),
            and(
              eq(schema.outboxEvents.status, "processing"),
              or(
                isNull(schema.outboxEvents.lockExpiresAt),
                lte(schema.outboxEvents.lockExpiresAt, claimAt),
              ),
            ),
          ),
          ...(onlyUserId === undefined ? [] : [eq(schema.outboxEvents.userId, onlyUserId)]),
        ))
        .orderBy(asc(schema.outboxEvents.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      const row = claimed[0];
      if (!row) return undefined;
      const [leased] = await tx.update(schema.outboxEvents)
        .set({
          status: "processing",
          attempts: row.attempts + 1,
          processingStartedAt: claimAt,
          lockedBy: workerId,
          lockExpiresAt: new Date(claimAt.getTime() + leaseMs),
        })
        .where(eq(schema.outboxEvents.id, row.id))
        .returning();
      return leased;
    });
  }

  function ownedEvent(eventId: string) {
    return and(
      eq(schema.outboxEvents.id, eventId),
      eq(schema.outboxEvents.status, "processing"),
      eq(schema.outboxEvents.lockedBy, workerId),
    );
  }

  function startLeaseHeartbeat(eventId: string): () => void {
    const intervalMs = Math.max(250, Math.floor(leaseMs / 3));
    const timer = setInterval(() => {
      const heartbeatAt = now();
      void db.update(schema.outboxEvents)
        .set({ lockExpiresAt: new Date(heartbeatAt.getTime() + leaseMs) })
        .where(ownedEvent(eventId));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async function processOne(event: typeof schema.outboxEvents.$inferSelect): Promise<boolean> {
    try {
      if (!SUPPORTED_AGGREGATE_TYPES.has(event.aggregateType)) {
        throw new Error(`unsupported_event_type:${event.aggregateType}`);
      }
      // Every known aggregate feeds the user/day projection of its event day.
      const tz = await resolveTimezone(event.userId);
      await dailyState.persistDailyProjection(event.userId, await extractEventDay(event), tz);
      return true;
    } catch (error) {
      if (String(error instanceof Error ? error.message : error).startsWith("unsupported_event_type")) {
        // Dead-letter immediately with an operational trace, no retries.
        await db.update(schema.outboxEvents).set({
          status: "dead_letter",
          lastError: `unsupported_event_type:${event.aggregateType}`,
          lockedBy: null,
          lockExpiresAt: null,
        }).where(ownedEvent(event.id));
        await db.insert(schema.interactionEvents).values({
          userId: event.userId,
          actor: "projection-worker",
          stage: "projection",
          stageCode: "unsupported_event_type",
          detailJson: { aggregateType: event.aggregateType, eventType: event.eventType, outboxId: event.id },
        });
        return false;
      }
      const lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      const nextAttempt = event.attempts; // already incremented at claim time
      if (nextAttempt >= MAX_ATTEMPTS) {
        await db.update(schema.outboxEvents).set({
          status: "dead_letter",
          lastError,
          lockedBy: null,
          lockExpiresAt: null,
        }).where(ownedEvent(event.id));
      } else {
        const delay = backoffMs(nextAttempt);
        await db.update(schema.outboxEvents).set({
          status: "pending",
          lastError,
          availableAt: new Date(now().getTime() + delay),
          lockedBy: null,
          lockExpiresAt: null,
        }).where(ownedEvent(event.id));
      }
      return false;
    }
  }

  async function runOnce(runAt = now(), onlyUserId?: string): Promise<WorkerRunResult> {
    const result: WorkerRunResult = { processed: 0, succeeded: 0, deadLettered: 0, requeued: 0 };
    for (let i = 0; i < batchSize; i++) {
      const event = await claimNext(runAt, onlyUserId);
      if (!event) break;
      result.processed += 1;
      const stopHeartbeat = startLeaseHeartbeat(event.id);
      const ok = await processOne(event).finally(stopHeartbeat);
      if (ok) {
        await db.update(schema.outboxEvents).set({
          status: "done",
          processedAt: now(),
          lockedBy: null,
          lockExpiresAt: null,
        }).where(ownedEvent(event.id));
        result.succeeded += 1;
      } else {
        const [current] = await db.select({ status: schema.outboxEvents.status })
          .from(schema.outboxEvents).where(eq(schema.outboxEvents.id, event.id)).limit(1);
        if (current?.status === "dead_letter") result.deadLettered += 1;
        else result.requeued += 1;
      }
    }
    return result;
  }

  async function replayDeadLetters(userId?: string, localDate?: string): Promise<number> {
    const revived = await (userId === undefined
      ? db.update(schema.outboxEvents)
          .set({
            status: "pending", attempts: 0, lastError: null, availableAt: now(),
            processingStartedAt: null, lockedBy: null, lockExpiresAt: null,
          })
          .where(localDate === undefined
            ? eq(schema.outboxEvents.status, "dead_letter")
            : and(eq(schema.outboxEvents.status, "dead_letter"), eventMatchesDate(localDate)))
          .returning({ id: schema.outboxEvents.id })
      : db.update(schema.outboxEvents)
          .set({
            status: "pending", attempts: 0, lastError: null, availableAt: now(),
            processingStartedAt: null, lockedBy: null, lockExpiresAt: null,
          })
          .where(and(
            eq(schema.outboxEvents.status, "dead_letter"),
            eq(schema.outboxEvents.userId, userId),
            ...(localDate === undefined ? [] : [eventMatchesDate(localDate)]),
          ))
          .returning({ id: schema.outboxEvents.id }));
    return revived.length;
  }

  /** Full rebuild path: drop the read model row and rebuild from facts. */
  async function rebuildUserProjection(userId: string, localDate: string): Promise<void> {
    const tz = await resolveTimezone(userId);
    await db.delete(schema.dailyHealthStateProjection)
      .where(and(
        eq(schema.dailyHealthStateProjection.userId, userId),
        eq(schema.dailyHealthStateProjection.stateDate, localDate),
      ));
    await db.insert(schema.projectionCheckpoints).values({
      projectionName: "daily-health-state",
      checkpointKey: `${userId}:${localDate}`,
      status: "rebuilding",
    }).onConflictDoUpdate({
      target: [schema.projectionCheckpoints.projectionName, schema.projectionCheckpoints.checkpointKey],
      set: { status: "rebuilding", updatedAt: new Date() },
    });
    try {
      await dailyState.persistDailyProjection(userId, localDate, tz);
      await db.update(schema.projectionCheckpoints)
        .set({ status: "fresh", updatedAt: new Date() })
        .where(and(
          eq(schema.projectionCheckpoints.projectionName, "daily-health-state"),
          eq(schema.projectionCheckpoints.checkpointKey, `${userId}:${localDate}`),
        ));
    } catch (error) {
      await db.update(schema.projectionCheckpoints)
        .set({ status: "failed", updatedAt: new Date() })
        .where(and(
          eq(schema.projectionCheckpoints.projectionName, "daily-health-state"),
          eq(schema.projectionCheckpoints.checkpointKey, `${userId}:${localDate}`),
        ));
      throw error;
    }
  }

  async function getDiagnostics(userId: string, localDate: string) {
    const [projection] = await db.select().from(schema.dailyHealthStateProjection)
      .where(and(
        eq(schema.dailyHealthStateProjection.userId, userId),
        eq(schema.dailyHealthStateProjection.stateDate, localDate),
      )).limit(1);
    const [checkpoint] = await db.select().from(schema.projectionCheckpoints)
      .where(and(
        eq(schema.projectionCheckpoints.projectionName, "daily-health-state"),
        eq(schema.projectionCheckpoints.checkpointKey, `${userId}:${localDate}`),
      )).limit(1);
    const [counts] = await db.select({
      pending: sql<number>`count(*) filter (where ${schema.outboxEvents.status} = 'pending')::int`,
      processing: sql<number>`count(*) filter (where ${schema.outboxEvents.status} = 'processing')::int`,
      deadLetter: sql<number>`count(*) filter (where ${schema.outboxEvents.status} = 'dead_letter')::int`,
      oldestPendingAt: sql<Date | null>`min(${schema.outboxEvents.createdAt}) filter (where ${schema.outboxEvents.status} in ('pending', 'processing'))`,
    }).from(schema.outboxEvents)
      .where(and(
        eq(schema.outboxEvents.userId, userId),
        eventMatchesDate(localDate),
      ));
    const failures = await db.select({
      id: schema.outboxEvents.id,
      aggregateType: schema.outboxEvents.aggregateType,
      eventType: schema.outboxEvents.eventType,
      attempts: schema.outboxEvents.attempts,
      lastError: schema.outboxEvents.lastError,
      createdAt: schema.outboxEvents.createdAt,
    }).from(schema.outboxEvents)
      .where(and(
        eq(schema.outboxEvents.userId, userId),
        eq(schema.outboxEvents.status, "dead_letter"),
        eventMatchesDate(localDate),
      ))
      .orderBy(desc(schema.outboxEvents.createdAt))
      .limit(20);

    const pending = counts?.pending ?? 0;
    const processing = counts?.processing ?? 0;
    const deadLetter = counts?.deadLetter ?? 0;
    const status = checkpoint?.status === "failed" || deadLetter > 0
      ? "failed"
      : pending > 0 || processing > 0 || projection?.projectionStatus === "lagging"
        ? "lagging"
        : projection?.projectionStatus ?? checkpoint?.status ?? "missing";
    return {
      userId,
      localDate,
      status,
      projection: projection ? {
        revision: projection.revision,
        status: projection.projectionStatus,
        builtAt: projection.builtAt,
        updatedAt: projection.updatedAt,
      } : null,
      checkpoint: checkpoint ? {
        status: checkpoint.status,
        lastEventAt: checkpoint.lastEventAt,
        updatedAt: checkpoint.updatedAt,
      } : null,
      outbox: {
        pending,
        processing,
        deadLetter,
        oldestPendingAt: counts?.oldestPendingAt ?? null,
        failures,
      },
    };
  }

  return { runOnce, replayDeadLetters, rebuildUserProjection, getDiagnostics };
}

export type ProjectionWorker = ReturnType<typeof createProjectionWorker>;
