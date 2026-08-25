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
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
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
        },
        source: "user",
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
        payloadJson: { observedOn: input.observedOn },
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

  return { execute, lift };
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
   * Consume a pending proposal for starting a session. Throws on:
   * - missing/expired/consumed proposal,
   * - stale: any health constraint created AFTER the proposal snapshot
   *   (a new pain between prepare and start invalidates it).
   */
  async function consumeValidProposal(input: {
    userId: string;
    proposalId: string;
    sessionDate: string;
    dayRole: string;
  }): Promise<{ proposalJson: Record<string, unknown>; planVersionId: string | null }> {
    return db.transaction(async (tx) => {
      const [proposal] = await tx.select().from(schema.preparedTrainingProposals)
        .where(and(
          eq(schema.preparedTrainingProposals.id, input.proposalId),
          eq(schema.preparedTrainingProposals.userId, input.userId),
          eq(schema.preparedTrainingProposals.status, "pending"),
        ))
        .limit(1);
      if (!proposal || proposal.expiresAt < new Date()) {
        throw new ProposalStaleError("proposal_missing_or_expired");
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

      await tx.update(schema.preparedTrainingProposals)
        .set({ status: "consumed", consumedAt: new Date() })
        .where(eq(schema.preparedTrainingProposals.id, proposal.id));

      const proposalJson = proposal.proposalJson as Record<string, unknown>;
      const exercises = (proposalJson.proposedExercises ?? []) as Array<Record<string, unknown>>;
      if (exercises.length === 0) throw new ProposalStaleError("proposal_has_no_exercises");

      return { proposalJson, planVersionId: proposal.planVersionId };
    });
  }

  return { saveProposal, consumeValidProposal };
}

export class ProposalStaleError extends Error {
  readonly code = "proposal_stale";
  constructor(readonly reason: string) {
    super(`training proposal is stale: ${reason}`);
  }
}
