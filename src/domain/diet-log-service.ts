/**
 * M05 / P3: Unified diet logging — preview → commit → correct.
 *
 * One estimator, one persistence path for Web text, voice text, and the
 * agent (plan §7: "实际饮食" writes only to PostgreSQL through this service).
 *
 * Invariants:
 * - low-confidence estimates never masquerade as exact facts: `uncertain`
 *   is persisted and surfaced to the UI;
 * - a retry with the same idempotency key returns the ORIGINAL commit
 *   result without inserting a second fact;
 * - corrections create a new revision linked via correctionOfId and mark
 *   the old row supersededById — history stays auditable, statistics use
 *   the effective revision only;
 * - expectedRevision conflicts return StateConflictError (409 upstream)
 *   instead of silently overwriting concurrent edits.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import type { Repository } from "../db/repository.js";
import { handleNutritionEstimate } from "../tools/handlers.js";
import type { NutritionEstimateResult } from "../tools/nutrition-estimate.js";
import type { ToolContext } from "../tools/context.js";

type Db = PostgresJsDatabase<typeof schema>;
type DietLogRow = typeof schema.dietLogs.$inferSelect;

/** Below this the estimate must be confirmed/corrected before counting. */
export const UNCERTAIN = true;

export interface DietPreview {
  status: "ok" | "needs_confirmation";
  estimate: NutritionEstimateResult;
}

export interface DietCommitInput {
  userId: string;
  logDate: string;
  mealType: string;
  description: string;
  source?: string;
  journeyId?: string;
  idempotencyKey?: string;
  /** Optimistic concurrency against the daily projection revision. */
  expectedRevision?: number;
  /** Caller already resolved items (voice candidate confirmation). */
  overrideEstimate?: NutritionEstimateResult;
}

export interface DietCorrectionInput {
  userId: string;
  /** The log being corrected. */
  originalLogId: string;
  mealType?: string;
  description?: string;
  reason?: string;
  journeyId?: string;
  idempotencyKey?: string;
}

export function createDietLogService(db: Db, repo: Repository) {
  async function preview(ctx: ToolContext, input: {
    description: string;
    date: string;
    mealType: string;
  }): Promise<DietPreview> {
    const estimate = await handleNutritionEstimate(ctx, input);
    const needsConfirmation =
      (estimate.needsConfirmation?.length ?? 0) > 0 ||
      (estimate.unmatched?.length ?? 0) > 0 ||
      estimate.uncertain === true;
    return { status: needsConfirmation ? "needs_confirmation" : "ok", estimate };
  }

  async function assertRevision(userId: string, logDate: string, expectedRevision?: number): Promise<void> {
    if (expectedRevision === undefined) return;
    const [row] = await db.select({ revision: schema.dailyHealthStateProjection.revision })
      .from(schema.dailyHealthStateProjection)
      .where(and(
        eq(schema.dailyHealthStateProjection.userId, userId),
        eq(schema.dailyHealthStateProjection.stateDate, logDate),
      ))
      .limit(1);
    const current = row?.revision ?? -1;
    if (current !== expectedRevision) {
      throw new StateConflict(current);
    }
  }

  async function insertWithLineage(values: typeof schema.dietLogs.$inferInsert): Promise<DietLogRow> {
    const [created] = await db.insert(schema.dietLogs).values(values).returning();
    if (!created) throw new Error("diet log insert returned no row");
    return created;
  }

  async function markSuperseded(originalLogId: string, supersededById: string): Promise<void> {
    await db.update(schema.dietLogs)
      .set({ supersededById, updatedAt: new Date() })
      .where(and(eq(schema.dietLogs.id, originalLogId), isNull(schema.dietLogs.supersededById)));
  }

  return {
    preview,

    /**
     * Commit a reviewed estimate as a diet fact. Idempotent per
     * (userId, idempotencyKey): a replay returns the original row.
     */
    async commit(ctx: ToolContext, input: DietCommitInput): Promise<{ log: DietLogRow; replayed: boolean }> {
      if (input.idempotencyKey) {
        const [existing] = await db.select().from(schema.dietLogs)
          .where(and(
            eq(schema.dietLogs.userId, input.userId),
            eq(schema.dietLogs.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1);
        if (existing) return { log: existing, replayed: true };
      }

      await assertRevision(input.userId, input.logDate, input.expectedRevision);

      const estimate = input.overrideEstimate
        ?? await handleNutritionEstimate(ctx, { description: input.description });
      const unresolved =
        (estimate.needsConfirmation?.length ?? 0) > 0 ||
        (estimate.unmatched?.length ?? 0) > 0;
      if (unresolved && input.overrideEstimate === undefined) {
        // Direct commits accept only clean resolutions; anything ambiguous or
        // partially-unmatched goes through preview -> confirm -> override so a
        // fallback guess never becomes a silent "fact".
        throw new NeedsConfirmationError(estimate);
      }

      const uncertain = estimate.uncertain === true || (estimate.needsConfirmation?.length ?? 0) > 0;
      const confidence = uncertain ? 0 : 1; // coarse tier until M09 word-level scores

      const log = await insertWithLineage({
        userId: input.userId,
        logDate: input.logDate,
        mealType: input.mealType,
        description: input.description,
        source: input.source ?? "agent",
        ingredientsJson: estimate.items.map((item) => ({ slug: item.slug, grams: item.grams } as Record<string, unknown>)) as Array<Record<string, unknown>>,
        seasoningsJson: [],
        caloriesKcal: estimate.kcal,
        proteinGrams: estimate.proteinGrams,
        carbsGrams: estimate.carbsGrams,
        fatGrams: estimate.fatGrams,
        sodiumMg: estimate.sodiumMg,
        idempotencyKey: input.idempotencyKey ?? null,
        estimateConfidence: confidence,
        uncertain,
        journeyId: input.journeyId ?? null,
      });

      await db.insert(schema.outboxEvents).values({
        userId: input.userId,
        aggregateType: "diet_log",
        aggregateId: log.id,
        eventType: "diet.commit",
        payloadJson: { observedOn: input.logDate },
      });

      return { log, replayed: false };
    },

    /**
     * Correct an existing log: the original stays for audit, statistics use
     * the new revision (superseded rows are filtered by supersededById).
     */
    async correct(ctx: ToolContext, input: DietCorrectionInput): Promise<{
      original: DietLogRow;
      revised: DietLogRow;
    }> {
      const [original] = await db.select().from(schema.dietLogs)
        .where(and(eq(schema.dietLogs.id, input.originalLogId), eq(schema.dietLogs.userId, input.userId)))
        .limit(1);
      if (!original) throw new RangeError("original log not found");

      if (input.idempotencyKey) {
        const [existing] = await db.select().from(schema.dietLogs)
          .where(and(
            eq(schema.dietLogs.userId, input.userId),
            eq(schema.dietLogs.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1);
        if (existing && existing.correctionOfId === original.id) {
          return { original, revised: existing }; // correction replay
        }
      }

      const description = input.description ?? original.description;
      const mealType = input.mealType ?? original.mealType;
      const estimate = await handleNutritionEstimate(ctx, { description });
      const uncertain = (estimate.needsConfirmation?.length ?? 0) > 0 || estimate.uncertain === true;

      const revised = await insertWithLineage({
        userId: input.userId,
        logDate: original.logDate,
        mealType,
        description: `${description}${input.reason ? `（修正：${input.reason}）` : ""}`,
        source: original.source,
        ingredientsJson: estimate.items.map((item) => ({ slug: item.slug, grams: item.grams } as Record<string, unknown>)) as Array<Record<string, unknown>>,
        seasoningsJson: original.seasoningsJson,
        caloriesKcal: estimate.kcal,
        proteinGrams: estimate.proteinGrams,
        carbsGrams: estimate.carbsGrams,
        fatGrams: estimate.fatGrams,
        sodiumMg: estimate.sodiumMg,
        idempotencyKey: input.idempotencyKey ?? null,
        estimateConfidence: uncertain ? 0 : 1,
        uncertain,
        correctionOfId: original.id,
        journeyId: input.journeyId ?? null,
      });

      await markSuperseded(original.id, revised.id);
      await db.insert(schema.outboxEvents).values({
        userId: input.userId,
        aggregateType: "diet_log",
        aggregateId: revised.id,
        eventType: "diet.correct",
        payloadJson: { observedOn: original.logDate, correctedOf: original.id },
      });

      return { original, revised };
    },

    /** Effective logs for a day: excludes superseded revisions. */
    async listEffectiveLogs(userId: string, logDate: string) {
      return db.select().from(schema.dietLogs)
        .where(and(
          eq(schema.dietLogs.userId, userId),
          eq(schema.dietLogs.logDate, logDate),
          isNull(schema.dietLogs.supersededById),
        ))
        .orderBy(schema.dietLogs.loggedAt);
    },
  };
}

export class NeedsConfirmationError extends Error {
  readonly code = "needs_confirmation";
  constructor(readonly estimate: NutritionEstimateResult) {
    super("estimate has unresolved segments; confirm candidates first");
  }
}

export class StateConflict extends Error {
  readonly code = "state_conflict";
  constructor(readonly currentRevision: number) {
    super(`revision mismatch (current: ${currentRevision})`);
  }
}

export type DietLogService = ReturnType<typeof createDietLogService>;
