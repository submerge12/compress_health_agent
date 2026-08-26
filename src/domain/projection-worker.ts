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

import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import {
  createDailyStateService,
  type DailyStateReadModel,
  type DailyStateService,
} from "./daily-state.js";
import { createTimezoneResolver, createUserLocalDateResolver } from "./timezone.js";
import { createRepository, type Repository } from "../db/repository.js";

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
  leaseLost: number;
}

export interface ProjectionWorkerOptions {
  workerId?: string;
  leaseMs?: number;
  batchSize?: number;
  now?: () => Date;
  /** Fault-injection/adapter seam. Return false when this worker no longer owns the row. */
  renewLease?: (eventId: string, expiresAt: Date, workerId: string) => Promise<boolean>;
  /** Test/fault seam used to hold projection work without taking database locks. */
  beforeProjection?: (eventId: string) => Promise<void>;
}

type ProcessOutcome =
  | { kind: "success"; state: DailyStateReadModel }
  | { kind: "unsupported"; lastError: string }
  | { kind: "failed"; lastError: string };

export class ProjectionReplayError extends Error {
  readonly code = "projection_replay_not_drained";

  constructor(readonly diagnostics: Awaited<ReturnType<ProjectionWorker["getDiagnostics"]>>) {
    super(
      `projection replay did not drain: pending=${diagnostics.outbox.pending}, `
      + `processing=${diagnostics.outbox.processing}, deadLetter=${diagnostics.outbox.deadLetter}`,
    );
  }
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
    localDate?: string,
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
          ...(localDate === undefined ? [] : [eventMatchesDate(localDate)]),
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

  function activelyOwnedEvent(eventId: string, at: Date) {
    return and(
      ownedEvent(eventId),
      gt(schema.outboxEvents.lockExpiresAt, at),
    );
  }

  async function renewLease(eventId: string, expiresAt: Date): Promise<boolean> {
    if (options.renewLease) return options.renewLease(eventId, expiresAt, workerId);
    const renewed = await db.update(schema.outboxEvents)
      .set({ lockExpiresAt: expiresAt })
      .where(activelyOwnedEvent(eventId, now()))
      .returning({ id: schema.outboxEvents.id });
    return renewed.length === 1;
  }

  function startLeaseHeartbeat(eventId: string): {
    stop: () => Promise<void>;
    leaseWasLost: () => boolean;
    heartbeatError: () => string | undefined;
  } {
    const intervalMs = Math.max(25, Math.floor(leaseMs / 3));
    let stopped = false;
    let leaseLost = false;
    let lastHeartbeatError: string | undefined;
    let pending = Promise.resolve();
    const beat = async () => {
      if (stopped || leaseLost) return;
      const heartbeatAt = now();
      try {
        if (!await renewLease(eventId, new Date(heartbeatAt.getTime() + leaseMs))) {
          leaseLost = true;
        }
      } catch (error) {
        leaseLost = true;
        lastHeartbeatError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      }
    };
    const timer = setInterval(() => {
      pending = pending.then(beat);
    }, intervalMs);
    timer.unref();
    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await pending;
      },
      leaseWasLost: () => leaseLost,
      heartbeatError: () => lastHeartbeatError,
    };
  }

  async function processOne(event: typeof schema.outboxEvents.$inferSelect): Promise<ProcessOutcome> {
    try {
      if (!SUPPORTED_AGGREGATE_TYPES.has(event.aggregateType)) {
        throw new Error(`unsupported_event_type:${event.aggregateType}`);
      }
      await options.beforeProjection?.(event.id);
      // Every known aggregate feeds the user/day projection of its event day.
      const tz = await resolveTimezone(event.userId);
      const state = await dailyState.buildDailyState(event.userId, await extractEventDay(event), tz);
      return { kind: "success", state };
    } catch (error) {
      if (String(error instanceof Error ? error.message : error).startsWith("unsupported_event_type")) {
        return { kind: "unsupported", lastError: `unsupported_event_type:${event.aggregateType}` };
      }
      const lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      return { kind: "failed", lastError };
    }
  }

  async function recordLeaseLoss(
    event: typeof schema.outboxEvents.$inferSelect,
    heartbeatError?: string,
  ): Promise<void> {
    await db.insert(schema.interactionEvents).values({
      userId: event.userId,
      actor: "projection-worker",
      stage: "projection",
      stageCode: "lease_lost",
      detailJson: {
        aggregateType: event.aggregateType,
        eventType: event.eventType,
        outboxId: event.id,
        workerId,
        ...(heartbeatError ? { heartbeatError } : {}),
      },
    });
  }

  async function commitSuccessfulProjection(
    event: typeof schema.outboxEvents.$inferSelect,
    state: DailyStateReadModel,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const commitAt = now();
      const [owned] = await tx.select({ id: schema.outboxEvents.id })
        .from(schema.outboxEvents)
        .where(activelyOwnedEvent(event.id, commitAt))
        .limit(1)
        .for("update");
      if (!owned) return false;

      const transactionDb = tx as unknown as Db;
      const transactionState = createDailyStateService(
        transactionDb,
        createRepository(transactionDb),
      );
      await transactionState.persistBuiltProjection(state);
      const completed = await tx.update(schema.outboxEvents).set({
        status: "done",
        processedAt: commitAt,
        lockedBy: null,
        lockExpiresAt: null,
      }).where(activelyOwnedEvent(event.id, commitAt)).returning({ id: schema.outboxEvents.id });
      if (completed.length !== 1) {
        throw new Error("projection lease changed while its row was locked");
      }
      return true;
    });
  }

  async function runOnce(
    runAt = now(),
    onlyUserId?: string,
    localDate?: string,
  ): Promise<WorkerRunResult> {
    const result: WorkerRunResult = {
      processed: 0,
      succeeded: 0,
      deadLettered: 0,
      requeued: 0,
      leaseLost: 0,
    };
    for (let i = 0; i < batchSize; i++) {
      const event = await claimNext(runAt, onlyUserId, localDate);
      if (!event) break;
      result.processed += 1;
      const heartbeat = startLeaseHeartbeat(event.id);
      const outcome = await processOne(event);
      await heartbeat.stop();
      if (heartbeat.leaseWasLost()) {
        result.leaseLost += 1;
        await recordLeaseLoss(event, heartbeat.heartbeatError());
        continue;
      }

      if (outcome.kind === "success") {
        if (await commitSuccessfulProjection(event, outcome.state)) {
          result.succeeded += 1;
        } else {
          result.leaseLost += 1;
          await recordLeaseLoss(event);
        }
        continue;
      }

      if (outcome.kind === "unsupported") {
        const deadLettered = await db.update(schema.outboxEvents).set({
          status: "dead_letter",
          lastError: outcome.lastError,
          lockedBy: null,
          lockExpiresAt: null,
        }).where(activelyOwnedEvent(event.id, now())).returning({ id: schema.outboxEvents.id });
        if (deadLettered.length === 1) {
          await db.insert(schema.interactionEvents).values({
            userId: event.userId,
            actor: "projection-worker",
            stage: "projection",
            stageCode: "unsupported_event_type",
            detailJson: { aggregateType: event.aggregateType, eventType: event.eventType, outboxId: event.id },
          });
          result.deadLettered += 1;
        } else {
          result.leaseLost += 1;
          await recordLeaseLoss(event);
        }
        continue;
      }

      const nextAttempt = event.attempts; // already incremented at claim time
      const finalAttempt = nextAttempt >= MAX_ATTEMPTS;
      const failed = await db.update(schema.outboxEvents).set(finalAttempt
        ? {
            status: "dead_letter",
            lastError: outcome.lastError,
            lockedBy: null,
            lockExpiresAt: null,
          }
        : {
            status: "pending",
            lastError: outcome.lastError,
            availableAt: new Date(now().getTime() + backoffMs(nextAttempt)),
            lockedBy: null,
            lockExpiresAt: null,
          })
        .where(activelyOwnedEvent(event.id, now()))
        .returning({ id: schema.outboxEvents.id });
      if (failed.length === 0) {
        result.leaseLost += 1;
        await recordLeaseLoss(event);
      } else if (finalAttempt) {
        result.deadLettered += 1;
      } else {
        result.requeued += 1;
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

  async function drainUserDate(
    userId: string,
    localDate: string,
    maxBatches = 100,
  ): Promise<{ processed: number; succeeded: number; diagnostics: Awaited<ReturnType<typeof getDiagnostics>> }> {
    let processed = 0;
    let succeeded = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const result = await runOnce(now(), userId, localDate);
      processed += result.processed;
      succeeded += result.succeeded;
      if (result.processed === 0) break;
    }
    const diagnostics = await getDiagnostics(userId, localDate);
    if (
      diagnostics.outbox.pending > 0
      || diagnostics.outbox.processing > 0
      || diagnostics.outbox.deadLetter > 0
    ) {
      throw new ProjectionReplayError(diagnostics);
    }
    return { processed, succeeded, diagnostics };
  }

  /** Full rebuild path: overwrite from facts while preserving revision monotonicity. */
  async function rebuildUserProjection(userId: string, localDate: string): Promise<void> {
    const tz = await resolveTimezone(userId);
    await db.update(schema.dailyHealthStateProjection)
      .set({ projectionStatus: "rebuilding", updatedAt: now() })
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
      await db.update(schema.dailyHealthStateProjection)
        .set({ projectionStatus: "failed", updatedAt: now() })
        .where(and(
          eq(schema.dailyHealthStateProjection.userId, userId),
          eq(schema.dailyHealthStateProjection.stateDate, localDate),
        ));
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

  return {
    runOnce,
    replayDeadLetters,
    drainUserDate,
    rebuildUserProjection,
    getDiagnostics,
  };
}

export type ProjectionWorker = ReturnType<typeof createProjectionWorker>;
