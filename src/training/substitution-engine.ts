/**
 * M07 / P0-6: exercise substitution engine and post-training reflection.
 *
 * The substitution rule is deterministic code, never model discretion
 * (plan §12.3/§14.3): same training purpose → prefer same movement pattern →
 * respect stability/load deltas → transfer ONLY the unfinished set budget →
 * explain retained/lost. Active block constraints always win.
 *
 * P0-6 changes:
 * - propose() filters candidates through active block constraints
 *   (movement pattern AND body-part families), contraindication tags, and
 *   candidates that already failed repeatedly for this user;
 * - the proposal is PERSISTED (substitution_proposals) with constraint and
 *   equipment snapshots; apply() receives ONLY (proposalId, chosenSlug) —
 *   clients can no longer re-assemble a proposal body;
 * - apply() re-checks remaining budget inside the transaction.
 */
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { NotOwnedError } from "./ownership.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import { blockedPatternsForBodyPart } from "./prepared-session.js";

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

export type SubstitutionReasonCode =
  | "equipment_occupied"
  | "equipment_unavailable"
  | "comfort"
  | "preference";

export interface SubstitutionAvailability {
  reasonCode: SubstitutionReasonCode;
  unavailableEquipment: string[];
  availableEquipment?: string[];
  occupiedExerciseSlug?: string;
}

export interface SubstitutionProposalView {
  substitutionProposalId: string;
  originalSessionExerciseId: string;
  originalSlug: string;
  remainingSets: number; // the ONLY budget a replacement may inherit
  candidates: SubstitutionCandidate[];
  equipmentAvailability: SubstitutionAvailability;
  volumeNote: string;
  expiresAt: string;
}

export class SubstitutionProposalError extends Error {
  readonly code = "substitution_proposal_invalid";
  constructor(readonly reason: string) {
    super(`substitution proposal invalid: ${reason}`);
  }
}

/** How many consecutive failed substitutions of one target trigger exclusion. */
const REPEATED_FAILURE_THRESHOLD = 2;

export function createSubstitutionEngine(db: Db) {
  /**
   * Propose replacements for an unfinished session exercise and persist them.
   * Candidates are filtered by: active block constraints (pattern + body-part
   * family), contraindication tags, repeated user rejections, self.
   */
  async function propose(
    userId: string,
    sessionId: string,
    sessionExerciseId: string,
    availability: SubstitutionAvailability = {
      reasonCode: "preference",
      unavailableEquipment: [],
    },
  ): Promise<SubstitutionProposalView> {
    // WO-HS-02: verify user -> session -> exercise before touching anything.
    const [session] = await db.select().from(schema.trainingSessions)
      .where(and(eq(schema.trainingSessions.id, sessionId), eq(schema.trainingSessions.userId, userId)))
      .limit(1);
    if (!session) throw new NotOwnedError("training_session");
    const [original] = await db.select().from(schema.trainingSessionExercises)
      .where(and(
        eq(schema.trainingSessionExercises.id, sessionExerciseId),
        eq(schema.trainingSessionExercises.sessionId, sessionId),
      ))
      .limit(1);
    if (!original) throw new NotOwnedError("session_exercise");

    const [definition] = await db.select().from(schema.exerciseDefinitions)
      .where(eq(schema.exerciseDefinitions.slug, original.exerciseSlug))
      .limit(1);
    if (!definition) throw new RangeError(`no definition for ${original.exerciseSlug}`);
    if (
      availability.occupiedExerciseSlug !== undefined
      && availability.occupiedExerciseSlug !== original.exerciseSlug
    ) {
      throw new RangeError("occupiedExerciseSlug does not match the session exercise");
    }

    const doneSets = await db.select({ setNumber: schema.trainingSetLogs.setNumber })
      .from(schema.trainingSetLogs)
      .where(eq(schema.trainingSetLogs.sessionExerciseId, original.id));
    const remainingSets = Math.max(original.targetSets - doneSets.length, 0);

    const [userSubs] = [await db.select().from(schema.exerciseSubstitutions)
      .where(and(
        eq(schema.exerciseSubstitutions.userId, userId),
        eq(schema.exerciseSubstitutions.fromExerciseSlug, original.exerciseSlug),
      ))];

    // ── P0-6 candidate exclusions ──
    const activeConstraints = await db.select().from(schema.healthConstraints).where(and(
      eq(schema.healthConstraints.userId, userId),
      isNull(schema.healthConstraints.liftedAt),
      sql`${schema.healthConstraints.activeFrom} <= ${session.sessionDate}`,
    ));
    const blockedPatterns = new Set<string>();
    for (const c of activeConstraints) {
      if (c.severity !== "block") continue;
      const target = c.targetJson as { movementPattern?: string; bodyPart?: string };
      if (target.movementPattern) blockedPatterns.add(target.movementPattern);
      for (const p of blockedPatternsForBodyPart(target.bodyPart)) blockedPatterns.add(p);
    }
    const contraindicated = new Set(definition.contraindicationTags);

    const rejectedSlugs = new Set<string>();
    try {
      const pastRejections = await db.select({
        slug: schema.userDecisionEvents.subjectJson,
        createdAt: schema.userDecisionEvents.createdAt,
      })
        .from(schema.userDecisionEvents)
        .where(and(
          eq(schema.userDecisionEvents.userId, userId),
          eq(schema.userDecisionEvents.decisionType, "rejected"),
          gte(schema.userDecisionEvents.createdAt, new Date(Date.now() - 30 * 86400_000)),
        ))
        .orderBy(desc(schema.userDecisionEvents.createdAt))
        .limit(100);
      const counts = new Map<string, number>();
      for (const row of pastRejections) {
        const subject = row.slug as { type?: string; to?: string } | null;
        if (subject?.type === "exercise_substitution" && typeof subject.to === "string") {
          counts.set(subject.to, (counts.get(subject.to) ?? 0) + 1);
        }
      }
      for (const [slug, n] of counts) {
        if (n >= REPEATED_FAILURE_THRESHOLD) rejectedSlugs.add(slug);
      }
    } catch {
      // Decision-history filtering is best-effort; absence must not break propose.
    }

    // Candidate pool: same pattern first, then user's declared alternates,
    // then same-muscle fallbacks — all filtered through definitions.
    const all = await db.select().from(schema.exerciseDefinitions);
    const userAlternateSlugs = new Set(userSubs.map((s) => s.toExerciseSlug));
    const unavailable = new Set(
      availability.unavailableEquipment.map((value) => value.trim().toLowerCase()).filter(Boolean),
    );
    const available = new Set(
      (availability.availableEquipment ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    );
    const equipmentIsUnavailable = (slug: string, equipment: string | null) => (
      unavailable.has(slug.toLowerCase())
      || (equipment !== null && unavailable.has(equipment.toLowerCase()))
    );
    const equipmentIsAvailable = (equipment: string | null) => (
      available.size === 0
      || (equipment !== null && available.has(equipment.toLowerCase()))
    );

    const scored = all
      .filter((e) => e.slug !== original.exerciseSlug)
      .filter((e) => e.trainingPurpose === definition.trainingPurpose)
      .filter((e) => !equipmentIsUnavailable(e.slug, e.equipment))
      .filter((e) => equipmentIsAvailable(e.equipment))
      .filter((e) => !blockedPatterns.has(e.movementPattern)) // active constraints win
      .filter((e) => !e.contraindicationTags.some((tag) => contraindicated.has(tag)))
      .filter((e) => !rejectedSlugs.has(e.slug)) // repeatedly rejected by this user
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
    if (candidates.length === 0) {
      throw new SubstitutionProposalError("no_candidate_matches_constraints_and_equipment");
    }

    // Persist: apply() will only accept the id + chosen slug.
    return db.transaction(async (tx) => {
      // Supersede earlier pending proposals for the same exercise.
      await tx.update(schema.substitutionProposals)
        .set({ status: "expired" })
        .where(and(
          eq(schema.substitutionProposals.userId, userId),
          eq(schema.substitutionProposals.sessionExerciseId, sessionExerciseId),
          eq(schema.substitutionProposals.status, "pending"),
        ));

      const [saved] = await tx.insert(schema.substitutionProposals).values({
        userId,
        sessionId,
        sessionExerciseId,
        sourceRevision: -1,
        remainingSets,
        candidateJson: candidates as unknown as Array<Record<string, unknown>>,
        constraintSnapshotJson: activeConstraints.map((c) => ({
          id: c.id, severity: c.severity, target: c.targetJson,
        })) as unknown as Array<Record<string, unknown>>,
        equipmentSnapshotJson: {
          originalEquipment: definition.equipment,
          originalStabilityDemand: definition.stabilityDemand,
          reasonCode: availability.reasonCode,
          unavailableEquipment: [...unavailable],
          availableEquipment: [...available],
          occupiedExerciseSlug: availability.occupiedExerciseSlug ?? null,
        },
      }).returning();
      if (!saved) throw new Error("substitution proposal insert returned no row");

      return {
        substitutionProposalId: saved.id,
        originalSessionExerciseId: original.id,
        originalSlug: original.exerciseSlug,
        remainingSets,
        candidates,
        equipmentAvailability: {
          reasonCode: availability.reasonCode,
          unavailableEquipment: [...unavailable],
          ...(available.size > 0 ? { availableEquipment: [...available] } : {}),
          ...(availability.occupiedExerciseSlug
            ? { occupiedExerciseSlug: availability.occupiedExerciseSlug }
            : {}),
        },
        volumeNote: `仅转移未完成的 ${remainingSets} 组；已完成 ${doneSets.length} 组保留为 actual，不叠加`,
        expiresAt: saved.expiresAt.toISOString(),
      };
    });
  }

  /**
   * Apply a PERSISTED proposal: mark the original replaced, insert the
   * replacement with targetSets == remainingSets (hard invariant), link both
   * directions, record the decision event. The client supplies only the
   * proposal id and chosen slug.
   */
  async function apply(input: {
    userId: string;
    substitutionProposalId: string;
    chosenSlug: string;
    reason: string;
    journeyId?: string;
  }): Promise<{ replacementId: string }> {
    return db.transaction(async (tx) => {
      const [proposal] = await tx.select().from(schema.substitutionProposals)
        .where(and(
          eq(schema.substitutionProposals.id, input.substitutionProposalId),
          eq(schema.substitutionProposals.userId, input.userId),
          eq(schema.substitutionProposals.status, "pending"),
        ))
        .limit(1)
        .for("update");
      if (!proposal || proposal.expiresAt < new Date()) {
        throw new SubstitutionProposalError("proposal_missing_or_expired");
      }

      const [ownedSession] = await tx.select().from(schema.trainingSessions)
        .where(and(eq(schema.trainingSessions.id, proposal.sessionId), eq(schema.trainingSessions.userId, input.userId)))
        .limit(1);
      if (!ownedSession) throw new NotOwnedError("training_session");
      if (ownedSession.status !== "in_progress") {
        throw new SubstitutionProposalError(`session_not_in_progress_${ownedSession.status}`);
      }

      const candidates = proposal.candidateJson as Array<{ slug?: unknown }>;
      if (!candidates.some((c) => String(c.slug ?? "") === input.chosenSlug)) {
        throw new RangeError("chosen slug is not one of the proposed candidates");
      }

      const [original] = await tx.select().from(schema.trainingSessionExercises)
        .where(eq(schema.trainingSessionExercises.id, proposal.sessionExerciseId))
        .limit(1);
      if (!original) throw new NotOwnedError("session_exercise");

      const doneCount = await tx.select({ n: sql<number>`count(*)::int` })
        .from(schema.trainingSetLogs)
        .where(eq(schema.trainingSetLogs.sessionExerciseId, proposal.sessionExerciseId));
      const remaining = Math.max((original?.targetSets ?? 0) - (doneCount[0]?.n ?? 0), 0);
      if (remaining !== proposal.remainingSets) {
        throw new SubstitutionProposalError("remaining_set_budget_changed_since_proposal");
      }

      const [replacement] = await tx.insert(schema.trainingSessionExercises).values({
        sessionId: proposal.sessionId,
        exerciseSlug: input.chosenSlug,
        orderIndex: original?.orderIndex ?? 0,
        targetSets: remaining, // ← the invariant: inherit remaining, not full target
        status: "pending",
        replacementForId: proposal.sessionExerciseId,
      }).returning();
      if (!replacement) throw new Error("replacement insert returned no row");

      await tx.update(schema.trainingSessionExercises)
        .set({ status: "replaced", replacedById: replacement.id, updatedAt: new Date() })
        .where(eq(schema.trainingSessionExercises.id, proposal.sessionExerciseId));

      await tx.update(schema.substitutionProposals)
        .set({ status: "applied", appliedAt: new Date() })
        .where(eq(schema.substitutionProposals.id, proposal.id));

      await tx.insert(schema.outboxEvents).values({
        userId: input.userId,
        aggregateType: "training_substitution",
        aggregateId: replacement.id,
        eventType: "training.substitution_applied",
        payloadJson: {
          observedOn: ownedSession.sessionDate,
          sessionId: proposal.sessionId,
          from: original?.exerciseSlug ?? null,
          to: input.chosenSlug,
          transferredSets: remaining,
        },
      });

      await tx.insert(schema.userDecisionEvents).values({
        userId: input.userId,
        decisionType: "accepted",
        subjectJson: {
          type: "exercise_substitution",
          observedOn: ownedSession.sessionDate,
          sessionId: ownedSession.id,
          originalExerciseId: original.id,
          replacementExerciseId: replacement.id,
          from: original?.exerciseSlug ?? null,
          to: input.chosenSlug,
          transferredSets: remaining,
          reason: input.reason,
        },
        journeyId: input.journeyId ?? null,
      });

      return { replacementId: replacement.id };
    });
  }

  async function readPendingProposal(userId: string, proposalId: string): Promise<{
    substitutionProposalId: string;
    candidates: SubstitutionCandidate[];
    expiresAt: string;
  }> {
    const [proposal] = await db.select().from(schema.substitutionProposals)
      .where(and(
        eq(schema.substitutionProposals.id, proposalId),
        eq(schema.substitutionProposals.userId, userId),
        eq(schema.substitutionProposals.status, "pending"),
      ))
      .limit(1);
    if (!proposal || proposal.expiresAt <= new Date()) {
      throw new SubstitutionProposalError("proposal_missing_or_expired");
    }
    return {
      substitutionProposalId: proposal.id,
      candidates: proposal.candidateJson as unknown as SubstitutionCandidate[],
      expiresAt: proposal.expiresAt.toISOString(),
    };
  }

  return { propose, apply, readPendingProposal };
}
