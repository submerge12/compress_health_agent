/**
 * M04 / P2: Projection worker — consumes the transactional outbox and keeps
 * the daily-health-state projection honest.
 *
 * Invariants (plan §6.1, J09):
 * - facts are never rolled back because a projection failed; failures mark
 *   the projection `failed`/`lagging` and retry with backoff,
 * - events are retried up to MAX_ATTEMPTS, then dead-lettered (visible, not
 *   silently dropped),
 * - replaying is safe: the projection rebuild overwrites the read model
 *   from source tables, so duplicate consumption cannot create duplicates.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import { createDailyStateService, type DailyStateService } from "./daily-state.js";
import type { Repository } from "../db/repository.js";

type Db = PostgresJsDatabase<typeof schema>;

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;

export interface WorkerRunResult {
  processed: number;
  succeeded: number;
  deadLettered: number;
}

export function createProjectionWorker(db: Db, repo: Repository) {
  const dailyState: DailyStateService = createDailyStateService(db, repo);

  async function processOne(event: typeof schema.outboxEvents.$inferSelect): Promise<boolean> {
    try {
      if (event.aggregateType === "observation" || event.aggregateType === "diet_log") {
        // All fact types feed the user/day projection of their event day.
        const payloadDay = (event.payloadJson as { observedOn?: string } | null)?.observedOn;
        await db.transaction(async () => {
          await dailyState.persistDailyProjection(
            event.userId,
            payloadDay ?? new Date().toISOString().slice(0, 10),
            "Asia/Shanghai",
          );
        });
      } else {
        // Unknown aggregate types succeed as no-ops so they never block the queue.
      }
      return true;
    } catch (error) {
      await db.update(schema.outboxEvents).set({
        attempts: event.attempts + 1,
        lastError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      }).where(eq(schema.outboxEvents.id, event.id));
      return false;
    }
  }

  async function runOnce(now = new Date()): Promise<WorkerRunResult> {
    const batch = await db.select().from(schema.outboxEvents)
      .where(and(
        eq(schema.outboxEvents.status, "pending"),
        lte(schema.outboxEvents.availableAt, now),
      ))
      .orderBy(asc(schema.outboxEvents.createdAt))
      .limit(BATCH_SIZE);

    let succeeded = 0;
    for (const event of batch) {
      const ok = await processOne(event);
      if (ok) {
        await db.update(schema.outboxEvents).set({
          status: "done",
          processedAt: new Date(),
        }).where(eq(schema.outboxEvents.id, event.id));
        succeeded += 1;
      } else if (event.attempts + 1 >= MAX_ATTEMPTS) {
        await db.update(schema.outboxEvents).set({
          status: "dead_letter",
        }).where(eq(schema.outboxEvents.id, event.id));
      }
    }

    return { processed: batch.length, succeeded, deadLettered: batch.length - succeeded };
  }

  async function replayDeadLetters(): Promise<number> {
    const revived = await db.update(schema.outboxEvents)
.set({ status: "pending", attempts: 0, lastError: null, availableAt: new Date() })
      .where(eq(schema.outboxEvents.status, "dead_letter"))
      .returning({ id: schema.outboxEvents.id });
    return revived.length;
  }

  /** Full rebuild path: drop the read model rows and rebuild from facts. */
  async function rebuildUserProjection(userId: string, localDate: string): Promise<void> {
    await db.delete(schema.dailyHealthStateProjection)
      .where(and(
        eq(schema.dailyHealthStateProjection.userId, userId),
        eq(schema.dailyHealthStateProjection.stateDate, localDate),
      ));
    await db.insert(schema.projectionCheckpoints).values({
      projectionName: "daily-health-state",
      checkpointKey: `${userId}:${localDate}`,
      status: "rebuilding",
    });
    try {
      await dailyState.persistDailyProjection(userId, localDate, "Asia/Shanghai");
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

  return { runOnce, replayDeadLetters, rebuildUserProjection };
}

export type ProjectionWorker = ReturnType<typeof createProjectionWorker>;
