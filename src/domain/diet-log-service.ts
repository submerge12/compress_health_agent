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
import type {
  NutritionEstimateResult,
  NutritionResolutionMode,
} from "../tools/nutrition-estimate.js";
import { FALLBACK_FOOD_SLUG } from "../tools/nutrition-estimate.js";
import type { ToolContext } from "../tools/context.js";
import { aggregateNutrition } from "../engine/nutrition.js";
import { resolveNaturalPortion } from "../engine/natural-units.js";
import type { NutritionEntry } from "../engine/types.js";
import { extractExplicitPortion } from "../tools/portion-text.js";

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
  /** Caller already resolved every ambiguous food candidate. */
  overrideEstimate?: NutritionEstimateResult;
}

export function createDietLogService(db: Db, repo: Repository) {
  async function preview(ctx: ToolContext, input: {
    description: string;
    date: string;
    mealType: string;
    resolutionMode?: NutritionResolutionMode;
  }): Promise<DietPreview> {
    const estimate = await handleNutritionEstimate(ctx, input);
    const needsConfirmation = input.resolutionMode !== "agent_estimate" && (
      (estimate.needsConfirmation?.length ?? 0) > 0 ||
      (estimate.unmatched?.length ?? 0) > 0 ||
      estimate.uncertain === true
    );
    return { status: needsConfirmation ? "needs_confirmation" : "ok", estimate };
  }

  async function previewCorrection(ctx: ToolContext, input: {
    userId: string;
    originalLogId: string;
    description?: string;
    mealType?: string;
  }) {
    const [original] = await db.select().from(schema.dietLogs)
      .where(and(
        eq(schema.dietLogs.id, input.originalLogId),
        eq(schema.dietLogs.userId, input.userId),
      ))
      .limit(1);
    if (!original) throw new RangeError("original log not found");
    if (original.supersededById !== null) throw new StateConflict(-1);

    const description = input.description ?? original.description;
    const mealType = input.mealType ?? original.mealType;
    const result = await preview(ctx, {
      description,
      date: original.logDate,
      mealType,
    });
    return { ...result, original, description, mealType };
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

  return {
    preview,
    previewCorrection,

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

      // WO-HS-03: fact + outbox commit atomically - a failure in either
      // rolls back both, so no receipt-less fact or fact-less receipt.
      const log = await db.transaction(async (tx) => {
        const [created] = await tx.insert(schema.dietLogs).values({
          userId: input.userId,
          logDate: input.logDate,
          mealType: input.mealType,
          description: input.description,
          source: input.source ?? "agent",
          ingredientsJson: [
            ...estimate.items.map((item) => ({ slug: item.slug, grams: item.grams })),
            ...(estimate.fallbackEstimates ?? []).map((item) => ({
              slug: FALLBACK_FOOD_SLUG,
              grams: item.grams,
            })),
          ] as Array<Record<string, unknown>>,
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
        }).returning();
        if (!created) throw new Error("diet log insert returned no row");

        await tx.insert(schema.outboxEvents).values({
          userId: input.userId,
          aggregateType: "diet_log",
          aggregateId: created.id,
          eventType: "diet.commit",
          payloadJson: { observedOn: input.logDate },
        });
        return created;
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
      // WO-HS-03: lock the original FOR UPDATE inside the transaction so two
      // concurrent corrections cannot both supersede; the loser replays the
      // winner's revision instead of creating a duplicate.
      return db.transaction(async (tx): Promise<{ original: DietLogRow; revised: DietLogRow }> => {
        const lockedRows = await tx.select().from(schema.dietLogs)
          .where(and(
            eq(schema.dietLogs.id, input.originalLogId),
            eq(schema.dietLogs.userId, input.userId),
          ))
          .for("update")
          .limit(1);
        const original = lockedRows[0] as DietLogRow | undefined;
        if (!original) throw new RangeError("original log not found");

        if (original.supersededById !== null) {
          if (input.idempotencyKey) {
            const [priorRevision] = await tx.select().from(schema.dietLogs)
              .where(and(
                eq(schema.dietLogs.id, original.supersededById),
                eq(schema.dietLogs.correctionOfId, original.id),
                eq(schema.dietLogs.idempotencyKey, input.idempotencyKey),
              ))
              .limit(1);
            if (priorRevision) return { original, revised: priorRevision };
          }
          throw new StateConflict(-1);
        }

        if (input.idempotencyKey) {
          const [existing] = await tx.select().from(schema.dietLogs)
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
        const estimate = input.overrideEstimate
          ?? await handleNutritionEstimate(ctx, { description });
        const unresolved =
          (estimate.needsConfirmation?.length ?? 0) > 0
          || (estimate.unmatched?.length ?? 0) > 0;
        if (unresolved && input.overrideEstimate === undefined) {
          throw new NeedsConfirmationError(estimate);
        }
        const uncertain =
          unresolved
          || estimate.uncertain === true;

        const [revised] = await tx.insert(schema.dietLogs).values({
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
        }).returning();
        if (!revised) throw new Error("revised insert returned no row");

        // CAS: only supersede if still unsuperseded (belt-and-braces with lock).
        const cas = await tx.update(schema.dietLogs)
          .set({ supersededById: revised.id, updatedAt: new Date() })
          .where(and(
            eq(schema.dietLogs.id, original.id),
            isNull(schema.dietLogs.supersededById),
          ))
          .returning({ id: schema.dietLogs.id });
        if (cas.length === 0) throw new StateConflict(-1);

        await tx.insert(schema.outboxEvents).values({
          userId: input.userId,
          aggregateType: "diet_log",
          aggregateId: revised.id,
          eventType: "diet.correct",
          payloadJson: { observedOn: original.logDate, correctedOf: original.id },
        });

        return { original, revised };
      });
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

/** Resolve one user-selected candidate into a clean nutrition estimate. */
export async function resolveConfirmedFoodCandidates(
  ctx: ToolContext,
  estimate: NutritionEstimateResult,
  selections: Record<string, string>,
): Promise<NutritionEstimateResult> {
  const diagnostics = estimate.needsConfirmation ?? [];
  const unmatched = estimate.unmatched ?? [];
  const items: NutritionEntry[] = estimate.items.map((item) => ({ ...item }));
  diagnostics.forEach((diagnostic, index) => {
    const choice = selections[`candidate_${index}`];
    if (!choice) throw new CandidateSelectionError(`confirmation_response_missing_${index}`);
    const selected = diagnostic.candidates.find((candidate) =>
      candidate.slug === choice || candidate.label === choice);
    if (!selected) throw new CandidateSelectionError(`candidate_not_offered_${index}`);
    const food = ctx.catalog.foods.find((entry) => entry.slug === selected.slug);
    if (!food) throw new CandidateSelectionError(`candidate_missing_from_catalog_${selected.slug}`);
    items.push({ slug: selected.slug, grams: gramsForSelection(diagnostic.segment, food, ctx) });
  });
  for (let index = 0; index < unmatched.length; index++) {
    const diagnostic = unmatched[index]!;
    const choice = selections[`unmatched_${index}`];
    if (!choice) throw new CandidateSelectionError(`unmatched_response_missing_${index}`);
    const portion = extractExplicitPortion(diagnostic.segment) ?? "";
    const resolved = await handleNutritionEstimate(ctx, {
      description: `${choice}${portion}`,
    });
    if ((resolved.needsConfirmation?.length ?? 0) > 0 || (resolved.unmatched?.length ?? 0) > 0) {
      throw new CandidateSelectionError(`unmatched_choice_did_not_resolve_${index}`);
    }
    items.push(...resolved.items);
  }

  const merged = [...items.reduce((bySlug, item) => {
    bySlug.set(item.slug, (bySlug.get(item.slug) ?? 0) + item.grams);
    return bySlug;
  }, new Map<string, number>())].map(([slug, grams]) => ({ slug, grams }));
  const totals = aggregateNutrition({
    foods: merged,
    foodRecords: ctx.catalog.foods,
    requireWeightType: true,
  }).total;
  return {
    description: estimate.description,
    items: merged,
    kcal: totals.kcal,
    proteinGrams: totals.proteinGrams,
    carbsGrams: totals.carbsGrams,
    fatGrams: totals.fatGrams,
    sodiumMg: totals.sodiumMg,
    micronutrients: totals.micronutrients,
  };
}

function gramsForSelection(
  segment: string,
  food: ToolContext["catalog"]["foods"][number],
  ctx: ToolContext,
): number {
  const portion = extractExplicitPortion(segment);
  if (portion) return resolveNaturalPortion(portion, food, ctx.catalog.naturalUnits).grams;
  return food.defaultGrams ?? 100;
}

export class CandidateSelectionError extends Error {
  readonly code = "proposal_stale";
  constructor(readonly reason: string) {
    super(`food candidate rejected: ${reason}`);
  }
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
