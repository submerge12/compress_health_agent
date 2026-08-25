/**
 * WO-HS-06 / M20: pain command and prepared session flow.
 *
 * Pain command: one transaction records the observation, classifies risk,
 * creates a warn/block constraint, and emits outbox + interaction receipts.
 * The system does training-risk control only — never diagnosis (plan §九).
 *
 * Prepared proposals: prepare() persists the constraint-filtered plan as a
 * proposal; start() consumes ONLY a proposal, re-validating that no newer
 * constraint invalidates it. A new pain after prepare -> 409 proposal_stale.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface PainCommandInput {
  userId: string;
  observedOn: string;
  bodyPart?: string;
  severityHint?: "mild" | "sharp" | "worsening" | "unstable" | "unknown";
  description?: string;
  journeyId?: string;
  source?: string;
  context?: Record<string, unknown>;
}

export interface PainCommandResult {
  observationId: string;
  constraintId: string;
  severity: "warn" | "block";
  guidance: string;
}

/** Conservative training-risk classification; not medical advice. */
function classify(severityHint: PainCommandInput["severityHint"], bodyPart?: string): { severity: "warn" | "block"; guidance: string } {
  switch (severityHint) {
    case "sharp":
    case "unstable":
    case "worsening":
      return {
        severity: "block",
        guidance: "锐痛/不稳/加重属于高风险信号：已阻止相关动作模式，建议必要时寻求专业人员评估。",
      };
    case "mild":
      return {
        severity: "warn",
        guidance: "轻度酸痛：训练时降低强度并观察，若加重请停止。",
      };
    default:
      // Unknown -> conservative temporary block pending cheap confirmation.
      return {
        severity: "block",
        guidance: "不确定的疼痛先按保守处理：已暂时限制相关动作，确认情况后可调整。",
      };
  }
}

export function createPainCommand(db: Db) {
  async function execute(input: PainCommandInput): Promise<PainCommandResult> {
    const { severity, guidance } = classify(input.severityHint, input.bodyPart);

    return db.transaction(async (tx) => {
      const [observation] = await tx.insert(schema.healthObservationEvents).values({
        userId: input.userId,
        observedOn: input.observedOn,
        kind: "pain",
        valueJson: {
          bodyPart: input.bodyPart ?? null,
          severityHint: input.severityHint ?? "unknown",
          ...(input.description ? { description: input.description } : {}),
          ...(input.context ? { context: input.context } : {}),
        },
        source: input.source ?? "user",
        journeyId: input.journeyId ?? null,
      }).returning();
      if (!observation) throw new Error("pain observation insert returned no row");

      const constraintRows = await tx.insert(schema.healthConstraints).values({
        userId: input.userId,
        constraintType: "pain",
        // Joint pain blocks the whole movement pattern family conservatively.
        severity,
        targetJson: { bodyPart: input.bodyPart ?? "unknown", scope: "movement_family" },
        reason: `${input.bodyPart ?? "部位不明"}疼痛（${input.severityHint ?? "unknown"}）`,
        activeFrom: input.observedOn,
        sourceObservationId: observation.id,
      }).returning();
      if (!constraintRows[0]) throw new Error("constraint insert returned no row");
      const constraint = constraintRows[0];

      await tx.insert(schema.outboxEvents).values({
        userId: input.userId,
        aggregateType: "constraint",
        aggregateId: constraint.id,
        eventType: "health.pain_recorded",
        payloadJson: {
          observedOn: input.observedOn,
          ...(input.context ? { context: input.context } : {}),
        },
      });

      await tx.insert(schema.userDecisionEvents).values({
        userId: input.userId,
        decisionType: "accepted",
        subjectJson: {
          type: "pain_report",
          bodyPart: input.bodyPart ?? null,
          severity,
          observationId: observation.id,
          constraintId: constraint.id,
          ...(input.context ? { context: input.context } : {}),
        },
        journeyId: input.journeyId ?? null,
      });

      return { observationId: observation.id, constraintId: constraint.id, severity, guidance };
    });
  }

  /** Lift requires explicit confirmation upstream; always leaves an audit trail. */
  async function lift(userId: string, constraintId: string, liftedByActor: string): Promise<void> {
    const cas = await db.update(schema.healthConstraints)
      .set({ liftedAt: new Date(), liftedByActor, updatedAt: new Date() })
      .where(and(
        eq(schema.healthConstraints.id, constraintId),
        eq(schema.healthConstraints.userId, userId),
        isNull(schema.healthConstraints.liftedAt),
      ))
      .returning({ id: schema.healthConstraints.id });
    if (cas.length === 0) throw new Error("constraint already lifted or not owned");
  }

  async function resolveLift(input: {
    userId: string;
    constraintId: string;
    actor: string;
    confirmed: boolean;
  }) {
    const [constraint] = await db.select().from(schema.healthConstraints).where(and(
      eq(schema.healthConstraints.id, input.constraintId),
      eq(schema.healthConstraints.userId, input.userId),
      isNull(schema.healthConstraints.liftedAt),
    )).limit(1);
    if (!constraint) throw new RangeError("constraint not found or already lifted");
    if (input.confirmed) {
      await lift(input.userId, input.constraintId, input.actor);
    }
    const [decision] = await db.insert(schema.userDecisionEvents).values({
      userId: input.userId,
      decisionType: input.confirmed ? "accepted" : "rejected",
      subjectJson: { type: "constraint_lift", constraintId: input.constraintId },
    }).returning();
    if (!decision) throw new Error("constraint decision insert returned no row");
    const [outbox] = await db.insert(schema.outboxEvents).values({
      userId: input.userId,
      aggregateType: input.confirmed ? "constraint" : "user_decision",
      aggregateId: input.confirmed ? input.constraintId : decision.id,
      eventType: input.confirmed ? "constraint.lifted" : "constraint.lift_declined",
      payloadJson: { observedOn: constraint.activeFrom, constraintId: input.constraintId },
    }).returning({ id: schema.outboxEvents.id });
    const [readBack] = await db.select().from(schema.healthConstraints).where(and(
      eq(schema.healthConstraints.id, input.constraintId),
      eq(schema.healthConstraints.userId, input.userId),
    )).limit(1);
    if (!outbox || !readBack) throw new Error("constraint lift read-back failed");
    return { constraint: readBack, decisionId: decision.id, outboxId: outbox.id };
  }

  return { execute, lift, resolveLift };
}

/** Body-part → blocked movement patterns (conservative mapping). */
const BODY_PART_PATTERNS: Record<string, string[]> = {
  knee: ["squat", "single_leg_squat"],
  膝盖: ["squat", "single_leg_squat"],
  shoulder: ["horizontal_push", "vertical_push", "overhead_press"],
  肩: ["horizontal_push", "vertical_push", "overhead_press"],
  elbow: ["elbow_flexion", "elbow_extension"],
  肘: ["elbow_flexion", "elbow_extension"],
  lower_back: ["hinge", "squat"],
  腰: ["hinge", "squat"],
};

export function blockedPatternsForBodyPart(bodyPart: string | undefined | null): string[] {
  if (!bodyPart) return [];
  return BODY_PART_PATTERNS[bodyPart] ?? [];
}

export function createPreparedSessionService(db: Db) {
  /**
   * Persist a prepared proposal: the filtered exercise list + constraint
   * snapshot + current daily-state revision. Idempotent per user/day/role:
   * preparing again supersedes the previous pending proposal.
   */
  async function saveProposal(input: {
    userId: string;
    sessionDate: string;
    dayRole: string;
    planVersionId?: string | null;
    dailyStateRevision: number;
    proposedExercises: Array<Record<string, unknown>>;
    blockedExercises: Array<Record<string, unknown>>;
    activeConstraints: Array<Record<string, unknown>>;
  }): Promise<{ proposalId: string }> {
    return db.transaction(async (tx) => {
      await tx.update(schema.preparedTrainingProposals)
        .set({ status: "expired" })
        .where(and(
          eq(schema.preparedTrainingProposals.userId, input.userId),
          eq(schema.preparedTrainingProposals.sessionDate, input.sessionDate),
          eq(schema.preparedTrainingProposals.dayRole, input.dayRole),
          eq(schema.preparedTrainingProposals.status, "pending"),
        ));

      const [created] = await tx.insert(schema.preparedTrainingProposals).values({
        userId: input.userId,
        sessionDate: input.sessionDate,
        dayRole: input.dayRole,
        planVersionId: input.planVersionId ?? null,
        sourceDailyStateRevision: input.dailyStateRevision,
        proposalJson: {
          proposedExercises: input.proposedExercises,
          blockedExercises: input.blockedExercises,
        },
        constraintsSnapshotJson: input.activeConstraints,
      }).returning();
      if (!created) throw new Error("proposal insert returned no row");
      return { proposalId: created.id };
    });
  }

  /**
   * Consume a pending proposal and create the session ATOMICALLY (P0-3).
   * Previously consumption committed first and session creation ran after —
   * a failure in between burned the proposal with no retry path. Now:
   *
   *   SELECT proposal FOR UPDATE
   *   → validate user/date/day/status/expiry
   *   → validate no newer block constraint
   *   → insert training_sessions + training_session_exercises
   *   → mark proposal consumed + outbox + interaction receipt
   *   → commit
   *
   * The client may not reinterpret the proposal: request date/dayRole/
   * planVersionId must match what prepare persisted.
   */
  async function startSessionFromProposal(input: {
    userId: string;
    proposalId: string;
    /** Must equal the proposal's persisted values — mismatches are 409s. */
    sessionDate: string;
    dayRole?: "A" | "B" | "C";
    journeyId?: string;
  }): Promise<{
    sessionId: string;
    dayRole: "A" | "B" | "C";
    planVersionId: string | null;
    exerciseCount: number;
  }> {
    return db.transaction(async (tx) => {
      const [proposal] = await tx.select().from(schema.preparedTrainingProposals)
        .where(and(
          eq(schema.preparedTrainingProposals.id, input.proposalId),
          eq(schema.preparedTrainingProposals.userId, input.userId),
          eq(schema.preparedTrainingProposals.status, "pending"),
        ))
        .limit(1)
        .for("update");
      if (!proposal || proposal.expiresAt < new Date()) {
        throw new ProposalStaleError("proposal_missing_or_expired");
      }

      // The client cannot re-interpret the proposal by passing another date
      // or role: both must match the prepared values exactly.
      const proposedDate = String(proposal.sessionDate);
      const proposedRole = String(proposal.dayRole).trim().toUpperCase();
      if (input.sessionDate !== proposedDate) {
        throw new ProposalStaleError(`date_mismatch (proposal is for ${proposedDate})`);
      }
      if (input.dayRole !== undefined && input.dayRole !== proposedRole) {
        throw new ProposalStaleError(`day_role_mismatch (proposal is for ${proposedRole})`);
      }
      if (!["A", "B", "C"].includes(proposedRole)) {
        throw new ProposalStaleError(`unsupported_day_role_${proposedRole}`);
      }

      // Staleness: any constraint created after this proposal was made.
      const newerConstraints = await tx.select({ n: sql<number>`count(*)::int` })
        .from(schema.healthConstraints)
        .where(and(
          eq(schema.healthConstraints.userId, input.userId),
          isNull(schema.healthConstraints.liftedAt),
          gt(schema.healthConstraints.createdAt, proposal.createdAt),
        ));
      if ((newerConstraints[0]?.n ?? 0) > 0) {
        await tx.update(schema.preparedTrainingProposals)
          .set({ status: "stale" })
          .where(eq(schema.preparedTrainingProposals.id, proposal.id));
        throw new ProposalStaleError("new_constraint_after_prepare");
      }

      const proposalJson = proposal.proposalJson as Record<string, unknown>;
      const rawExercises = (proposalJson.proposedExercises ?? []) as Array<Record<string, unknown>>;
      const exercises = rawExercises
        .map((raw, index) => {
          const item = raw as {
            order?: unknown; exerciseSlug?: unknown; sets?: unknown;
            repRangeLow?: unknown; repRangeHigh?: unknown; rirLow?: unknown; rirHigh?: unknown;
          };
          return {
            orderIndex: Number(item.order ?? index + 1),
            exerciseSlug: String(item.exerciseSlug ?? ""),
            targetSets: Number(item.sets ?? 3),
            targetRepRangeLow: item.repRangeLow === undefined ? null : Number(item.repRangeLow),
            targetRepRangeHigh: item.repRangeHigh === undefined ? null : Number(item.repRangeHigh),
            targetRirLow: item.rirLow === undefined ? null : Number(item.rirLow),
            targetRirHigh: item.rirHigh === undefined ? null : Number(item.rirHigh),
          };
        })
        .filter((item) => item.exerciseSlug !== "");
      if (exercises.length === 0) throw new ProposalStaleError("proposal_has_no_exercises");

      const [session] = await tx.insert(schema.trainingSessions).values({
        userId: input.userId,
        sessionDate: proposedDate,
        planVersionId: proposal.planVersionId,
        status: "in_progress",
        startedAt: new Date(),
        journeyId: input.journeyId ?? null,
      }).returning();
      if (!session) throw new Error("session insert returned no row");

      await tx.insert(schema.trainingSessionExercises).values(exercises.map((item) => ({
        sessionId: session.id,
        exerciseSlug: item.exerciseSlug,
        orderIndex: item.orderIndex,
        targetSets: item.targetSets,
        targetRepRangeLow: item.targetRepRangeLow,
        targetRepRangeHigh: item.targetRepRangeHigh,
        targetRirLow: item.targetRirLow,
        targetRirHigh: item.targetRirHigh,
      })));

      await tx.update(schema.preparedTrainingProposals)
        .set({ status: "consumed", consumedAt: new Date() })
        .where(eq(schema.preparedTrainingProposals.id, proposal.id));

      await tx.insert(schema.outboxEvents).values({
        userId: input.userId,
        aggregateType: "training_session",
        aggregateId: session.id,
        eventType: "training.started",
        payloadJson: { observedOn: proposedDate, fromProposalId: proposal.id },
      });

      return {
        sessionId: session.id,
        dayRole: proposedRole as "A" | "B" | "C",
        planVersionId: proposal.planVersionId,
        exerciseCount: exercises.length,
      };
    });
  }

  return { saveProposal, startSessionFromProposal };
}

export class ProposalStaleError extends Error {
  readonly code = "proposal_stale";
  constructor(readonly reason: string) {
    super(`training proposal is stale: ${reason}`);
  }
}
