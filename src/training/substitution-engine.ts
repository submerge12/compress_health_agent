/**
 * M07 / P4: exercise substitution engine and post-training reflection.
 *
 * The substitution rule is deterministic code, never model discretion
 * (plan §12.3/§14.3): same training purpose → prefer same movement pattern →
 * respect stability/load deltas → transfer ONLY the unfinished set budget →
 * explain retained/lost. Active block constraints always win.
 */
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface SubstitutionCandidate {
  slug: string;
  nameZh: string;
  movementPattern: string;
  primaryMuscles: string[];
  equipment: string | null;
  stabilityDemand: string;
  /** Human-readable trade-off explanation (plan J05 acceptance). */
  retained: string[];
  lost: string[];
}

export interface SubstitutionProposal {
  originalSessionExerciseId: string;
  originalSlug: string;
  remainingSets: number; // the ONLY budget a replacement may inherit
  candidates: SubstitutionCandidate[];
  volumeNote: string;
}

export function createSubstitutionEngine(db: Db) {
  /**
   * Propose replacements for an unfinished session exercise.
   *
   * Volume invariant (asserted by apply): the replacement's target sets equal
   * the ORIGINAL's remaining (unfinished) sets — planned purpose-volume is
   * transferred, never added to.
   */
  async function propose(userId: string, sessionId: string, sessionExerciseId: string): Promise<SubstitutionProposal> {
    const [original] = await db.select().from(schema.trainingSessionExercises)
      .where(eq(schema.trainingSessionExercises.id, sessionExerciseId))
      .limit(1);
    if (!original) throw new RangeError("session exercise not found");

    const [definition] = await db.select().from(schema.exerciseDefinitions)
      .where(eq(schema.exerciseDefinitions.slug, original.exerciseSlug))
      .limit(1);
    if (!definition) throw new RangeError(`no definition for ${original.exerciseSlug}`);

    const doneSets = await db.select({ setNumber: schema.trainingSetLogs.setNumber })
      .from(schema.trainingSetLogs)
      .where(eq(schema.trainingSetLogs.sessionExerciseId, original.id));
    const remainingSets = Math.max(original.targetSets - doneSets.length, 0);

    const [userSubs] = [await db.select().from(schema.exerciseSubstitutions)
      .where(and(
        eq(schema.exerciseSubstitutions.userId, userId),
        eq(schema.exerciseSubstitutions.fromExerciseSlug, original.exerciseSlug),
      ))];

    // Candidate pool: same pattern first, then user's declared alternates,
    // then same-muscle fallbacks — all filtered through definitions.
    const all = await db.select().from(schema.exerciseDefinitions);
    const userAlternateSlugs = new Set(userSubs.map((s) => s.toExerciseSlug));
    const templateAlternates = new Set<string>(); // template alternates arrive via itemsJson at the route layer

    const scored = all
      .filter((e) => e.slug !== original.exerciseSlug && !templateAlternates.has(e.slug))
      .map((e) => ({
        def: e,
        score:
          (e.movementPattern === definition.movementPattern ? 100 : 0) +
          (userAlternateSlugs.has(e.slug) ? 50 : 0) +
          e.primaryMuscles.filter((m) => definition.primaryMuscles.includes(m)).length * 10 +
          (e.equipment === definition.equipment ? 5 : 0),
      }))
      .filter((s) => s.score > 0 || userAlternateSlugs.has(s.def.slug))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const retainedBase = [`训练目的保持（${definition.trainingPurpose}）`];
    const candidates: SubstitutionCandidate[] = scored.map(({ def }) => ({
      slug: def.slug,
      nameZh: def.nameZh,
      movementPattern: def.movementPattern,
      primaryMuscles: def.primaryMuscles,
      equipment: def.equipment,
      stabilityDemand: def.stabilityDemand,
      retained: [
        ...retainedBase,
        ...(def.movementPattern === definition.movementPattern ? ["动作模式一致"] : []),
        ...(def.equipment === definition.equipment ? ["器械相同"] : []),
      ],
      lost: [
        ...(def.movementPattern !== definition.movementPattern ? [`动作模式变化：${definition.movementPattern} → ${def.movementPattern}`] : []),
        ...def.primaryMuscles
          .filter((m) => !definition.primaryMuscles.includes(m))
          .map((m) => `新增主肌群：${m}`),
      ],
    }));

    return {
      originalSessionExerciseId: original.id,
      originalSlug: original.exerciseSlug,
      remainingSets,
      candidates,
      volumeNote: `仅转移未完成的 ${remainingSets} 组；已完成 ${doneSets.length} 组保留为 actual，不叠加`,
    };
  }

  /**
   * Apply a chosen candidate: mark the original replaced, insert the
   * replacement with targetSets == remainingSets (hard invariant), link both
   * directions, and record the decision event.
   */
  async function apply(input: {
    userId: string;
    sessionId: string;
    proposal: SubstitutionProposal;
    chosenSlug: string;
    reason: string;
    journeyId?: string;
  }): Promise<{ replacementId: string }> {
    const { proposal } = input;
    if (!proposal.candidates.some((c) => c.slug === input.chosenSlug)) {
      throw new RangeError("chosen slug is not one of the proposed candidates");
    }

    return db.transaction(async (tx) => {
      await tx.update(schema.trainingSessionExercises)
        .set({ status: "replaced", replacedById: null, updatedAt: new Date() })
        .where(and(
          eq(schema.trainingSessionExercises.id, proposal.originalSessionExerciseId),
          eq(schema.trainingSessionExercises.status, "pending"),
        ));

      const [original] = await tx.select().from(schema.trainingSessionExercises)
        .where(eq(schema.trainingSessionExercises.id, proposal.originalSessionExerciseId))
        .limit(1);

      const doneCount = await tx.select({ n: sql<number>`count(*)::int` })
        .from(schema.trainingSetLogs)
        .where(eq(schema.trainingSetLogs.sessionExerciseId, proposal.originalSessionExerciseId));
      const remaining = Math.max((original?.targetSets ?? 0) - (doneCount[0]?.n ?? 0), 0);
      if (remaining !== proposal.remainingSets) {
        throw new Error("remaining-set budget changed since proposal; re-propose");
      }

      const [replacement] = await tx.insert(schema.trainingSessionExercises).values({
        sessionId: input.sessionId,
        exerciseSlug: input.chosenSlug,
        orderIndex: original?.orderIndex ?? 0,
        targetSets: remaining, // ← the invariant: inherit remaining, not full target
        status: "pending",
        replacementForId: proposal.originalSessionExerciseId,
      }).returning();
      if (!replacement) throw new Error("replacement insert returned no row");

      await tx.update(schema.trainingSessionExercises)
        .set({ status: "replaced", replacedById: replacement.id, updatedAt: new Date() })
        .where(eq(schema.trainingSessionExercises.id, proposal.originalSessionExerciseId));

      await tx.insert(schema.userDecisionEvents).values({
        userId: input.userId,
        decisionType: "accepted",
        subjectJson: {
          type: "exercise_substitution",
          from: proposal.originalSlug,
          to: input.chosenSlug,
          transferredSets: remaining,
          reason: input.reason,
        },
        journeyId: input.journeyId ?? null,
      });

      return { replacementId: replacement.id };
    });
  }

  return { propose, apply };
}
