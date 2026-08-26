import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import {
  latestEffectiveSingletonObservation,
  selectEffectiveSingletonObservations,
} from "../domain/observation-policy.js";
import type {
  CueReferenceProfile,
  PlanCompileContext,
  PlanVersionDiff,
} from "./plan-change-compiler.js";
import { blockedPatternsForBodyPart } from "./prepared-session.js";

type Db = PostgresJsDatabase<typeof schema>;

export const PLAN_GOVERNANCE_VERSION = "plan-governance.v1";
const EVIDENCE_WINDOW_DAYS = 42;

export interface RecoveryEvidenceSnapshot {
  evidenceWindow: { from: string; through: string; days: number };
  completedCycles: number;
  sleepSummary: { observations: number; averageHours: number | null; lowSleepCount: number };
  fatigueSummary: { observations: number; averageLevel: number | null; highFatigueCount: number };
  painSummary: { activeConstraints: number; blockingConstraints: number };
  completionRate: number;
  sufficientForHighFrequency: boolean;
  insufficiencyReasons: string[];
}

export interface PlanGovernanceMetadata {
  schemaVersion: typeof PLAN_GOVERNANCE_VERSION;
  proposalArgumentHash: string;
  reviewedBy: "deterministic_plan_governance.v1";
  reviewStatus: "approved" | "activation_blocked";
  reviewReasons: string[];
  rollbackTargetVersionId: string;
  validationQuestions: string[];
  highFrequencyCycle: boolean;
  recoveryEvidence: RecoveryEvidenceSnapshot | null;
}

export interface ActivationGovernanceReview {
  reviewedBy: "deterministic_plan_governance.v1";
  allowed: boolean;
  reasons: string[];
  rollbackTargetVersionId: string;
  validationQuestions: string[];
  diff: PlanVersionDiff;
  evidence: RecoveryEvidenceSnapshot | null;
}

export async function loadPlanCompileContext(input: {
  db: Db;
  userId: string;
  onDate: string;
  reflection: typeof schema.trainingReflections.$inferSelect;
  changes: readonly Record<string, unknown>[];
}): Promise<PlanCompileContext> {
  const exerciseRows = await input.db.select({
    slug: schema.exerciseDefinitions.slug,
    nameZh: schema.exerciseDefinitions.nameZh,
    movementPattern: schema.exerciseDefinitions.movementPattern,
    trainingPurpose: schema.exerciseDefinitions.trainingPurpose,
    primaryMuscles: schema.exerciseDefinitions.primaryMuscles,
    stabilityDemand: schema.exerciseDefinitions.stabilityDemand,
    equipment: schema.exerciseDefinitions.equipment,
    rangeOfMotion: schema.exerciseDefinitions.rangeOfMotion,
    contraindicationTags: schema.exerciseDefinitions.contraindicationTags,
  }).from(schema.exerciseDefinitions);
  const exerciseCatalog = new Map(exerciseRows.map((exercise) => [exercise.slug, exercise]));

  const constraints = await input.db.select().from(schema.healthConstraints).where(and(
    eq(schema.healthConstraints.userId, input.userId),
    isNull(schema.healthConstraints.liftedAt),
    sql`${schema.healthConstraints.activeFrom} <= ${input.onDate}`,
    or(isNull(schema.healthConstraints.activeTo), sql`${schema.healthConstraints.activeTo} >= ${input.onDate}`),
  ));
  const blockedExerciseSlugs = new Set<string>();
  const blockedMovementPatterns = new Set<string>();
  const unavailableEquipment = new Set<string>();
  const activeJointConstraints = new Set<string>();
  for (const constraint of constraints) {
    if (constraint.severity !== "block") continue;
    const target = constraint.targetJson as {
      exerciseSlug?: string;
      movementPattern?: string;
      bodyPart?: string;
      joint?: string;
      equipment?: string;
      contraindicationTag?: string;
    };
    if (target.exerciseSlug) blockedExerciseSlugs.add(target.exerciseSlug);
    if (target.movementPattern) blockedMovementPatterns.add(target.movementPattern);
    for (const pattern of blockedPatternsForBodyPart(target.bodyPart)) blockedMovementPatterns.add(pattern);
    if (target.equipment) unavailableEquipment.add(target.equipment.trim().toLowerCase());
    if (target.joint) activeJointConstraints.add(target.joint);
    if (target.contraindicationTag) activeJointConstraints.add(target.contraindicationTag);
  }

  const cueReferenceIds = collectCueReferenceIds(input.changes);
  const cueReferences = await loadCueReferences(input.db, cueReferenceIds);
  return {
    exerciseCatalog,
    blockedExerciseSlugs,
    blockedMovementPatterns,
    unavailableEquipment,
    activeJointConstraints,
    cueReferences,
    reflectionIssueTargets: collectReflectionIssueTargets(input.reflection),
  };
}

export function isHighFrequencyCycleChange(diff: PlanVersionDiff): boolean {
  const cycle = diff.cyclePattern;
  if (!cycle) return false;
  const beforeTraining = cycle.before.filter((role) => role !== "REST").length;
  const afterTraining = cycle.after.filter((role) => role !== "REST").length;
  const beforeRatio = beforeTraining / cycle.before.length;
  const afterRatio = afterTraining / cycle.after.length;
  const beforeRun = maximumTrainingRun(cycle.before);
  const afterRun = maximumTrainingRun(cycle.after);
  return (afterRatio > beforeRatio && afterRatio >= 0.75)
    || (afterRun > beforeRun && afterRun >= 3);
}

export async function createPlanGovernanceMetadata(input: {
  db: Db;
  userId: string;
  onDate: string;
  parentVersionId: string;
  proposalArgumentHash: string;
  diff: PlanVersionDiff;
  requestedValidationQuestions: string[];
}): Promise<PlanGovernanceMetadata> {
  const highFrequencyCycle = isHighFrequencyCycleChange(input.diff);
  const recoveryEvidence = highFrequencyCycle
    ? await collectRecoveryEvidence(input.db, input.userId, input.onDate)
    : null;
  const validationQuestions = uniqueNonEmpty([
    ...input.requestedValidationQuestions,
    ...input.diff.changes.flatMap((change) => change.assessment?.nextValidation ?? []),
    ...(highFrequencyCycle
      ? ["下一循环结束后确认睡眠、疲劳、疼痛与完成率是否仍在安全范围内。"]
      : []),
    "下一次训练后确认本版本是否改善目标问题且未产生新疼痛。",
  ]);
  const reviewStatus = recoveryEvidence?.sufficientForHighFrequency === false
    ? "activation_blocked" as const
    : "approved" as const;
  return {
    schemaVersion: PLAN_GOVERNANCE_VERSION,
    proposalArgumentHash: input.proposalArgumentHash,
    reviewedBy: "deterministic_plan_governance.v1",
    reviewStatus,
    reviewReasons: recoveryEvidence?.insufficiencyReasons ?? ["deterministic structural and safety checks passed"],
    rollbackTargetVersionId: input.parentVersionId,
    validationQuestions,
    highFrequencyCycle,
    recoveryEvidence,
  };
}

export async function evaluateActivationGovernance(input: {
  db: Db;
  userId: string;
  onDate: string;
  currentVersionId: string;
  targetVersionId: string;
  direction: "forward" | "rollback";
  targetContent: Record<string, unknown>;
  targetValidationQuestions: string[] | null;
  diff: PlanVersionDiff;
}): Promise<ActivationGovernanceReview> {
  if (input.direction === "rollback") {
    return {
      reviewedBy: "deterministic_plan_governance.v1",
      allowed: true,
      reasons: ["direct-parent rollback restores the immutable prior version"],
      rollbackTargetVersionId: input.currentVersionId,
      validationQuestions: input.targetValidationQuestions ?? [],
      diff: input.diff,
      evidence: null,
    };
  }

  const stored = input.targetContent["governance"] as Partial<PlanGovernanceMetadata> | undefined;
  const reasons: string[] = [];
  if (stored?.schemaVersion !== PLAN_GOVERNANCE_VERSION) reasons.push("missing current deterministic governance review");
  if (stored?.rollbackTargetVersionId !== input.currentVersionId) reasons.push("rollback target does not match active parent");
  const validationQuestions = uniqueNonEmpty([
    ...(input.targetValidationQuestions ?? []),
    ...(stored?.validationQuestions ?? []),
  ]);
  if (validationQuestions.length === 0) reasons.push("activation requires validation questions");
  const highFrequency = stored?.highFrequencyCycle === true || isHighFrequencyCycleChange(input.diff);
  const evidence = highFrequency ? await collectRecoveryEvidence(input.db, input.userId, input.onDate) : null;
  if (evidence && !evidence.sufficientForHighFrequency) reasons.push(...evidence.insufficiencyReasons);
  if (highFrequency) reasons.push(...await currentReadinessBlocks(input.db, input.userId, input.onDate));

  return {
    reviewedBy: "deterministic_plan_governance.v1",
    allowed: reasons.length === 0,
    reasons: reasons.length > 0 ? uniqueNonEmpty(reasons) : ["deterministic activation review passed"],
    rollbackTargetVersionId: input.currentVersionId,
    validationQuestions,
    diff: input.diff,
    evidence,
  };
}

async function loadCueReferences(db: Db, ids: string[]): Promise<Map<string, CueReferenceProfile>> {
  const result = new Map<string, CueReferenceProfile>();
  const validIds = ids.filter(isUuid);
  for (const id of ids) {
    if (!isUuid(id)) result.set(id, { valid: false, reason: "segment id is not a UUID" });
  }
  if (validIds.length === 0) return result;
  const rows = await db.select({
    id: schema.videoSegments.id,
    reviewStatus: schema.videoSegments.reviewStatus,
    supersededById: schema.videoSegments.supersededById,
    startMs: schema.videoSegments.startMs,
    endMs: schema.videoSegments.endMs,
    exerciseSlug: schema.videoSegments.exerciseSlug,
    movementPattern: schema.videoSegments.movementPattern,
    bodyPart: schema.videoSegments.bodyPart,
    category: schema.videoSegments.category,
    probeStatus: schema.mediaAssets.probeStatus,
    fullDecodeStatus: schema.mediaAssets.fullDecodeStatus,
    durationMs: schema.mediaAssets.durationMs,
    decodeErrorAtMs: schema.mediaAssets.decodeErrorAtMs,
    assetUsableUntilMs: schema.mediaAssets.usableVideoUntilMs,
    pairingUsableUntilMs: schema.mediaPairings.usableUntilMs,
    subtitleEndMs: schema.mediaPairings.subtitleEndMs,
  })
    .from(schema.videoSegments)
    .innerJoin(schema.mediaPairings, eq(schema.videoSegments.pairingId, schema.mediaPairings.id))
    .innerJoin(schema.mediaAssets, eq(schema.mediaPairings.videoAssetId, schema.mediaAssets.id))
    .where(inArray(schema.videoSegments.id, validIds));
  for (const row of rows) {
    const assetLimit = row.fullDecodeStatus === "ok"
      ? minimumPositive(row.assetUsableUntilMs, row.durationMs)
      : row.fullDecodeStatus === "decode_errors"
        ? minimumPositive(row.assetUsableUntilMs, row.decodeErrorAtMs)
        : null;
    const effectiveLimit = row.pairingUsableUntilMs === null || row.subtitleEndMs === null || assetLimit === null
      ? null
      : minimumPositive(row.pairingUsableUntilMs, row.subtitleEndMs, assetLimit);
    const invalidReason = row.reviewStatus !== "confirmed" ? "segment is not confirmed"
      : row.supersededById !== null ? "segment is superseded"
      : row.probeStatus !== "ok" ? "video probe did not pass"
      : !["ok", "decode_errors"].includes(row.fullDecodeStatus) ? "full decode status is unusable"
      : effectiveLimit === null ? "usable media window is unknown"
      : row.startMs < 0 || row.endMs <= row.startMs || row.endMs > effectiveLimit
        ? "segment is outside the verified media window"
        : undefined;
    result.set(row.id, {
      valid: invalidReason === undefined,
      ...(invalidReason ? { reason: invalidReason } : {}),
      exerciseSlug: row.exerciseSlug,
      movementPattern: row.movementPattern,
      bodyPart: row.bodyPart,
      problemTags: [row.category],
    });
  }
  return result;
}

async function collectRecoveryEvidence(db: Db, userId: string, through: string): Promise<RecoveryEvidenceSnapshot> {
  const from = addDays(through, -(EVIDENCE_WINDOW_DAYS - 1));
  const observations = await db.select().from(schema.healthObservationEvents)
    .where(and(
      eq(schema.healthObservationEvents.userId, userId),
      gte(schema.healthObservationEvents.observedOn, from),
      isNull(schema.healthObservationEvents.revokedAt),
    ))
    .orderBy(desc(schema.healthObservationEvents.observedOn), desc(schema.healthObservationEvents.createdAt));
  const effective = selectEffectiveSingletonObservations(observations);
  const sleepHours = effective
    .filter((observation) => observation.kind === "sleep")
    .map((observation) => (observation.valueJson as { hours?: unknown }).hours)
    .filter((hours): hours is number => typeof hours === "number" && Number.isFinite(hours));
  const fatigueLevels = effective
    .filter((observation) => observation.kind === "fatigue")
    .map((observation) => (observation.valueJson as { level?: unknown }).level)
    .filter((level): level is number => typeof level === "number" && Number.isFinite(level));

  const constraints = await db.select().from(schema.healthConstraints).where(and(
    eq(schema.healthConstraints.userId, userId),
    isNull(schema.healthConstraints.liftedAt),
    sql`${schema.healthConstraints.activeFrom} <= ${through}`,
    or(isNull(schema.healthConstraints.activeTo), sql`${schema.healthConstraints.activeTo} >= ${through}`),
  ));
  const instances = await db.select().from(schema.trainingCycleInstances).where(and(
    eq(schema.trainingCycleInstances.userId, userId),
    eq(schema.trainingCycleInstances.status, "retired"),
    gte(schema.trainingCycleInstances.startedAt, new Date(`${from}T00:00:00.000Z`)),
  ));
  const positions = instances.length === 0 ? [] : await db.select().from(schema.trainingCyclePositions)
    .where(inArray(schema.trainingCyclePositions.cycleInstanceId, instances.map((instance) => instance.id)));
  const positionsByInstance = new Map<string, typeof positions>();
  for (const position of positions) {
    const list = positionsByInstance.get(position.cycleInstanceId) ?? [];
    list.push(position);
    positionsByInstance.set(position.cycleInstanceId, list);
  }
  const completedCycles = instances.filter((instance) => {
    const cyclePositions = positionsByInstance.get(instance.id) ?? [];
    return cyclePositions.some((position) => position.status === "completed")
      && cyclePositions.every((position) => !["skipped_readiness", "pending"].includes(position.status));
  }).length;

  const sessions = await db.select({ status: schema.trainingSessions.status })
    .from(schema.trainingSessions)
    .where(and(
      eq(schema.trainingSessions.userId, userId),
      gte(schema.trainingSessions.sessionDate, from),
    ));
  const settledSessions = sessions.filter((session) => ["completed", "interrupted", "cancelled"].includes(session.status));
  const completionRate = settledSessions.length === 0
    ? 0
    : settledSessions.filter((session) => session.status === "completed").length / settledSessions.length;
  const sleepAverage = average(sleepHours);
  const fatigueAverage = average(fatigueLevels);
  const blockingConstraints = constraints.filter((constraint) => constraint.severity === "block").length;
  const insufficiencyReasons = [
    ...(completedCycles < 2 ? [`requires two completed recovery-safe cycles; found ${completedCycles}`] : []),
    ...(sleepHours.length < 2 || sleepAverage === null || sleepAverage < 7
      ? ["at least two sleep observations averaging 7 hours are required"] : []),
    ...(fatigueLevels.length < 2
      ? ["at least two fatigue observations are required"]
      : fatigueLevels.some((level) => level >= 4) ? ["high fatigue exists in the evidence window"] : []),
    ...(blockingConstraints > 0 ? ["an active blocking pain or health constraint exists"] : []),
    ...(completionRate < 0.85 ? [`completion rate ${completionRate.toFixed(2)} is below 0.85`] : []),
  ];
  return {
    evidenceWindow: { from, through, days: EVIDENCE_WINDOW_DAYS },
    completedCycles,
    sleepSummary: {
      observations: sleepHours.length,
      averageHours: sleepAverage,
      lowSleepCount: sleepHours.filter((hours) => hours < 5.5).length,
    },
    fatigueSummary: {
      observations: fatigueLevels.length,
      averageLevel: fatigueAverage,
      highFatigueCount: fatigueLevels.filter((level) => level >= 4).length,
    },
    painSummary: { activeConstraints: constraints.length, blockingConstraints },
    completionRate,
    sufficientForHighFrequency: insufficiencyReasons.length === 0,
    insufficiencyReasons,
  };
}

async function currentReadinessBlocks(db: Db, userId: string, onDate: string): Promise<string[]> {
  const observations = await db.select().from(schema.healthObservationEvents).where(and(
    eq(schema.healthObservationEvents.userId, userId),
    gte(schema.healthObservationEvents.observedOn, addDays(onDate, -2)),
    isNull(schema.healthObservationEvents.revokedAt),
  )).orderBy(desc(schema.healthObservationEvents.observedOn), desc(schema.healthObservationEvents.createdAt));
  const sleep = latestEffectiveSingletonObservation(observations, "sleep");
  const fatigue = latestEffectiveSingletonObservation(observations, "fatigue");
  const hours = (sleep?.valueJson as { hours?: unknown } | undefined)?.hours;
  const level = (fatigue?.valueJson as { level?: unknown } | undefined)?.level;
  return [
    ...(typeof hours === "number" && hours < 5.5 ? ["current low sleep blocks high-frequency activation"] : []),
    ...(typeof level === "number" && level >= 4 ? ["current high fatigue blocks high-frequency activation"] : []),
  ];
}

function collectCueReferenceIds(changes: readonly Record<string, unknown>[]): string[] {
  return uniqueNonEmpty(changes.flatMap((change) => {
    if (change["kind"] !== "update_cue_refs" && change["kind"] !== "add_exercise") return [];
    return Array.isArray(change["cueRefs"])
      ? change["cueRefs"].filter((value): value is string => typeof value === "string")
      : [];
  }));
}

function collectReflectionIssueTargets(reflection: typeof schema.trainingReflections.$inferSelect): Set<string> {
  const targets = new Set<string>();
  const visit = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, key));
      return;
    }
    if (value !== null && typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([entryKey, entry]) => visit(entry, entryKey));
      return;
    }
    if (typeof value === "string" && [
      "exerciseSlug", "movementPattern", "bodyPart", "problem", "problemTag", "kind", "target",
    ].includes(key ?? "")) targets.add(value);
  };
  visit(reflection.unresolvedIssuesJson);
  visit(reflection.painSummaryJson);
  return targets;
}

function maximumTrainingRun(pattern: string[]): number {
  let run = 0;
  let maximum = 0;
  for (let index = 0; index < pattern.length * 2; index += 1) {
    run = pattern[index % pattern.length] === "REST" ? 0 : Math.min(run + 1, pattern.length + 1);
    maximum = Math.max(maximum, run);
  }
  return maximum;
}

function minimumPositive(...values: Array<number | null | undefined>): number | null {
  const candidates = values.filter(
    (value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value > 0,
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function addDays(localDate: string, days: number): string {
  const value = new Date(`${localDate}T00:00:00.000Z`);
  if (Number.isNaN(value.getTime())) throw new RangeError(`invalid local date: ${localDate}`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
