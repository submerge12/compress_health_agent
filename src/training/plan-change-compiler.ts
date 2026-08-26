type PlanDayItem = Record<string, unknown> & { exerciseSlug: string };

export interface PlanExerciseProfile {
  nameZh?: string;
  movementPattern?: string;
  trainingPurpose?: string;
  primaryMuscles?: string[];
  stabilityDemand?: string;
  equipment?: string | null;
  rangeOfMotion?: string;
  contraindicationTags?: string[];
}

export interface CueReferenceProfile {
  valid: boolean;
  reason?: string;
  exerciseSlug?: string | null;
  movementPattern?: string | null;
  bodyPart?: string | null;
  problemTags?: string[];
}

export interface PlanCompileContext {
  exerciseCatalog?: ReadonlyMap<string, PlanExerciseProfile>;
  blockedExerciseSlugs?: ReadonlySet<string>;
  blockedMovementPatterns?: ReadonlySet<string>;
  unavailableEquipment?: ReadonlySet<string>;
  activeJointConstraints?: ReadonlySet<string>;
  cueReferences?: ReadonlyMap<string, CueReferenceProfile>;
  reflectionIssueTargets?: ReadonlySet<string>;
}

export type PlanChange =
  | { kind: "reorder_exercises"; dayRole: string; order: string[] }
  | { kind: "replace_exercise"; dayRole: string; exerciseSlug: string; replacementExerciseSlug: string }
  | { kind: "update_sets"; dayRole: string; exerciseSlug: string; sets: number }
  | {
      kind: "update_rep_range";
      dayRole: string;
      exerciseSlug: string;
      repRangeLow: number;
      repRangeHigh: number;
    }
  | {
      kind: "update_rir";
      dayRole: string;
      exerciseSlug: string;
      rirLow: number;
      rirHigh: number;
    }
  | { kind: "update_alternatives"; dayRole: string; exerciseSlug: string; alternatives: string[] }
  | { kind: "update_cycle_pattern"; cyclePattern: string[] }
  | { kind: "update_cue_refs"; dayRole: string; exerciseSlug: string; cueRefs: string[] }
  | { kind: "remove_exercise"; dayRole: string; exerciseSlug: string }
  | {
      kind: "add_exercise";
      dayRole: string;
      exerciseSlug: string;
      sets: number;
      repRangeLow?: number;
      repRangeHigh?: number;
      rirLow?: number;
      rirHigh?: number;
      alternatives?: string[];
      cueRefs?: string[];
      note?: string;
    };

export interface PlanChangeDiff {
  kind: string;
  target: { dayRole?: string; exerciseSlug?: string };
  before: unknown;
  after: unknown;
  assessment?: {
    preserved: string[];
    lost: string[];
    volume: { beforeSets: number | null; afterSets: number | null; changed: boolean };
    allowedBecause: string[];
    nextValidation: string[];
  };
}

export interface PlanVersionDiff {
  changes: PlanChangeDiff[];
  changedDays: Array<{
    dayRole: string;
    beforeOrder: string[];
    afterOrder: string[];
  }>;
  cyclePattern?: { before: string[]; after: string[] };
}

export interface CompiledPlanContent extends Record<string, unknown> {
  days: Record<string, PlanDayItem[]>;
  cyclePattern: string[];
}

export class PlanChangeValidationError extends RangeError {
  readonly code = "validation_failed";
  constructor(readonly changeIndex: number, message: string) {
    super(`changes[${changeIndex}]: ${message}`);
  }
}

const MAX_SETS_PER_EXERCISE = 10;
const MAX_SETS_PER_DAY = 40;
const MAX_CYCLE_LENGTH = 14;
const MAX_LIST_REFS = 20;

export function compilePlanChanges(
  parentContent: Record<string, unknown>,
  rawChanges: readonly unknown[],
  options: PlanCompileContext = {},
): {
  content: CompiledPlanContent;
  changes: PlanChange[];
  diff: PlanVersionDiff;
} {
  if (rawChanges.length === 0) throw new PlanChangeValidationError(0, "at least one plan change is required");
  const parentDays = normalizePlanDays(parentContent);
  if (Object.keys(parentDays).length === 0) throw new PlanChangeValidationError(0, "active plan has no executable days");
  const days = cloneDays(parentDays);
  const parentCycle = normalizeCycle(parentContent["cyclePattern"], Object.keys(parentDays), 0);
  let cyclePattern = [...parentCycle];
  const changes = rawChanges.map(parsePlanChange);
  const diffs: PlanChangeDiff[] = [];

  changes.forEach((change, index) => {
    const fail = (message: string): never => { throw new PlanChangeValidationError(index, message); };
    switch (change.kind) {
      case "reorder_exercises": {
        const list = requireDay(days, change.dayRole, fail);
        const available = new Set(list.map((item) => item.exerciseSlug));
        if (new Set(change.order).size !== change.order.length) fail("reorder contains duplicate exercise slugs");
        const unknown = change.order.filter((slug) => !available.has(slug));
        if (unknown.length > 0) fail(`reorder contains unknown exercises: ${unknown.join(", ")}`);
        const before = exerciseOrder(list);
        const rank = new Map(change.order.map((slug, order) => [slug, order]));
        const reordered = list
          .map((item, originalIndex) => ({ item, originalIndex }))
          .sort((left, right) => {
            const leftRank = rank.get(left.item.exerciseSlug);
            const rightRank = rank.get(right.item.exerciseSlug);
            if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
            if (leftRank !== undefined) return -1;
            if (rightRank !== undefined) return 1;
            return left.originalIndex - right.originalIndex;
          })
          .map(({ item }) => item);
        applyOrder(reordered);
        const after = exerciseOrder(reordered);
        if (same(before, after)) fail(`reorder for day ${change.dayRole} has no effect`);
        days[change.dayRole] = reordered;
        diffs.push(diff(change, before, after));
        break;
      }
      case "replace_exercise": {
        const list = requireDay(days, change.dayRole, fail);
        const { item, index: itemIndex } = requireExercise(list, change.exerciseSlug, fail);
        if (list.some((candidate) => candidate.exerciseSlug === change.replacementExerciseSlug)) {
          fail(`exercise ${change.replacementExerciseSlug} already exists on day ${change.dayRole}`);
        }
        if (!options.exerciseCatalog) fail("exercise catalog is required for replacement validation");
        const originalProfile = requireCatalogExercise(change.exerciseSlug, options.exerciseCatalog, fail)!;
        const catalog = requireCatalogExercise(change.replacementExerciseSlug, options.exerciseCatalog, fail)!;
        const assessment = assessReplacement(item, originalProfile, catalog, change, options, fail);
        const replacement: PlanDayItem = replacementPrescription(item, change.replacementExerciseSlug, catalog);
        list[itemIndex] = replacement;
        diffs.push(diff(change, clone(item), clone(replacement), assessment));
        break;
      }
      case "update_sets": {
        validateSets(change.sets, fail);
        const { item } = requireTarget(days, change, fail);
        const before = { sets: item["sets"] ?? null };
        const after = { sets: change.sets };
        if (same(before, after)) fail("sets change has no effect");
        item["sets"] = change.sets;
        diffs.push(diff(change, before, after));
        break;
      }
      case "update_rep_range": {
        validateRange(change.repRangeLow, change.repRangeHigh, "rep range", 1, 100, fail);
        const { item } = requireTarget(days, change, fail);
        const before = { repRangeLow: item["repRangeLow"] ?? null, repRangeHigh: item["repRangeHigh"] ?? null };
        const after = { repRangeLow: change.repRangeLow, repRangeHigh: change.repRangeHigh };
        if (same(before, after)) fail("rep range change has no effect");
        Object.assign(item, after);
        diffs.push(diff(change, before, after));
        break;
      }
      case "update_rir": {
        validateRange(change.rirLow, change.rirHigh, "RIR", 0, 10, fail);
        const { item } = requireTarget(days, change, fail);
        const before = { rirLow: item["rirLow"] ?? null, rirHigh: item["rirHigh"] ?? null };
        const after = { rirLow: change.rirLow, rirHigh: change.rirHigh };
        if (same(before, after)) fail("RIR change has no effect");
        Object.assign(item, after);
        diffs.push(diff(change, before, after));
        break;
      }
      case "update_alternatives": {
        const alternatives = validateRefs(change.alternatives, "alternatives", fail);
        if (alternatives.includes(change.exerciseSlug)) fail("an exercise cannot be its own alternative");
        alternatives.forEach((slug) => requireCatalogExercise(slug, options.exerciseCatalog, fail));
        const { item } = requireTarget(days, change, fail);
        const before = { alternatives: [...asStringArray(item["alternates"])] };
        const after = { alternatives };
        if (same(before, after)) fail("alternatives change has no effect");
        item["alternates"] = alternatives;
        diffs.push(diff(change, before, after));
        break;
      }
      case "update_cue_refs": {
        const cueRefs = validateRefs(change.cueRefs, "cueRefs", fail);
        const { item } = requireTarget(days, change, fail);
        validateCueReferences(cueRefs, item, options, fail);
        const before = { cueRefs: [...asStringArray(item["cueRefs"])] };
        const after = { cueRefs };
        if (same(before, after)) fail("cue refs change has no effect");
        item["cueRefs"] = cueRefs;
        diffs.push(diff(change, before, after));
        break;
      }
      case "update_cycle_pattern": {
        const after = normalizeCycle(change.cyclePattern, Object.keys(days), index);
        validateCycleStructure(after, days, options.exerciseCatalog, fail);
        const before = [...cyclePattern];
        if (same(before, after)) fail("cycle pattern change has no effect");
        cyclePattern = after;
        diffs.push(diff(change, before, after));
        break;
      }
      case "remove_exercise": {
        const list = requireDay(days, change.dayRole, fail);
        const { item, index: itemIndex } = requireExercise(list, change.exerciseSlug, fail);
        if (list.length === 1) fail(`plan change would leave day ${change.dayRole} empty`);
        list.splice(itemIndex, 1);
        applyOrder(list);
        diffs.push(diff(change, clone(item), null));
        break;
      }
      case "add_exercise": {
        const list = requireDay(days, change.dayRole, fail);
        if (list.some((item) => item.exerciseSlug === change.exerciseSlug)) {
          fail(`exercise ${change.exerciseSlug} already exists on day ${change.dayRole}`);
        }
        validateSets(change.sets, fail);
        const catalog = requireCatalogExercise(change.exerciseSlug, options.exerciseCatalog, fail);
        validateOptionalPrescription(change, fail);
        const alternatives = change.alternatives
          ? validateRefs(change.alternatives, "alternatives", fail)
          : undefined;
        if (alternatives?.includes(change.exerciseSlug)) {
          fail("an exercise cannot be its own alternative");
        }
        alternatives?.forEach((slug) => requireCatalogExercise(slug, options.exerciseCatalog, fail));
        const created: PlanDayItem = {
          order: list.length + 1,
          exerciseSlug: change.exerciseSlug,
          sets: change.sets,
          ...(catalog?.nameZh ? { nameZh: catalog.nameZh } : {}),
          ...(catalog?.movementPattern ? { movementPattern: catalog.movementPattern } : {}),
          ...(change.repRangeLow !== undefined ? { repRangeLow: change.repRangeLow } : {}),
          ...(change.repRangeHigh !== undefined ? { repRangeHigh: change.repRangeHigh } : {}),
          ...(change.rirLow !== undefined ? { rirLow: change.rirLow } : {}),
          ...(change.rirHigh !== undefined ? { rirHigh: change.rirHigh } : {}),
          ...(alternatives ? { alternates: alternatives } : {}),
          ...(change.cueRefs ? {
            cueRefs: validateAndReturnCueRefs(change.cueRefs, createdCueTarget(change.exerciseSlug, catalog), options, fail),
          } : {}),
          ...(change.note ? { note: change.note } : {}),
        };
        list.push(created);
        diffs.push(diff(change, null, clone(created)));
        break;
      }
    }
    validateDayVolumes(days, fail);
  });

  const content: CompiledPlanContent = {
    ...clone(parentContent),
    days,
    cyclePattern,
  };
  return {
    content,
    changes,
    diff: buildDiff(parentDays, days, parentCycle, cyclePattern, diffs),
  };
}

export function diffPlanContents(
  beforeContent: Record<string, unknown>,
  afterContent: Record<string, unknown>,
  requestedChanges: Array<Record<string, unknown>> = [],
): PlanVersionDiff {
  const beforeDays = normalizePlanDays(beforeContent);
  const afterDays = normalizePlanDays(afterContent);
  const roles = [...new Set([...Object.keys(beforeDays), ...Object.keys(afterDays)])].sort();
  const changes: PlanChangeDiff[] = roles.flatMap((dayRole) => {
    const before = beforeDays[dayRole] ?? [];
    const after = afterDays[dayRole] ?? [];
    return same(before, after) ? [] : [{
      kind: "compiled_day",
      target: { dayRole },
      before: clone(before),
      after: clone(after),
      ...(requestedChanges.length > 0 ? { requestedChanges: clone(requestedChanges) } : {}),
    } as PlanChangeDiff];
  });
  const knownRoles = roles.length > 0 ? roles : ["A", "B", "C"];
  const beforeCycle = normalizeCycle(beforeContent["cyclePattern"], knownRoles, 0);
  const afterCycle = normalizeCycle(afterContent["cyclePattern"], knownRoles, 0);
  if (!same(beforeCycle, afterCycle)) {
    changes.push({
      kind: "update_cycle_pattern",
      target: {},
      before: beforeCycle,
      after: afterCycle,
    });
  }
  return buildDiff(beforeDays, afterDays, beforeCycle, afterCycle, changes);
}

export function normalizePlanDays(content: Record<string, unknown>): Record<string, PlanDayItem[]> {
  const normalized: Record<string, PlanDayItem[]> = {};
  const rawDays = content["days"];
  if (Array.isArray(rawDays)) {
    for (const value of rawDays) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const day = value as { dayRole?: string; name?: string; items?: unknown[] };
      const key = (day.dayRole
        ?? (day.name?.startsWith("胸") ? "A"
          : day.name?.includes("背") || day.name?.includes("肩后束") ? "B"
          : day.name?.includes("腿") ? "C" : undefined)
        ?? "").toUpperCase();
      if (key && Array.isArray(day.items)) normalized[key] = normalizeItems(day.items);
    }
    return normalized;
  }
  if (rawDays !== null && typeof rawDays === "object") {
    for (const [role, items] of Object.entries(rawDays as Record<string, unknown>)) {
      if (Array.isArray(items)) normalized[role.toUpperCase()] = normalizeItems(items);
    }
  }
  return normalized;
}

function parsePlanChange(raw: unknown, index: number): PlanChange {
  const fail = (message: string): never => { throw new PlanChangeValidationError(index, message); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("must be an object");
  const change = raw as Record<string, unknown>;
  const rawKind = requiredString(change, "kind", fail);
  const kind = rawKind === "reorder" ? "reorder_exercises" : rawKind;
  if (kind === "update_cycle_pattern") {
    return { kind, cyclePattern: stringArray(change["cyclePattern"], "cyclePattern", fail) };
  }
  const dayRole = requiredString(change, "dayRole", fail).toUpperCase();
  if (kind === "reorder_exercises") {
    return { kind, dayRole, order: stringArray(change["order"], "order", fail) };
  }
  const exerciseSlug = requiredString(change, "exerciseSlug", fail);
  switch (kind) {
    case "replace_exercise":
      return {
        kind,
        dayRole,
        exerciseSlug,
        replacementExerciseSlug: requiredString(
          { value: change["replacementExerciseSlug"] ?? change["toExerciseSlug"] },
          "value",
          fail,
        ),
      };
    case "update_sets":
      return { kind, dayRole, exerciseSlug, sets: numberField(change, "sets", fail) };
    case "update_rep_range":
      return {
        kind,
        dayRole,
        exerciseSlug,
        repRangeLow: numberField(change, "repRangeLow", fail),
        repRangeHigh: numberField(change, "repRangeHigh", fail),
      };
    case "update_rir":
      return {
        kind,
        dayRole,
        exerciseSlug,
        rirLow: numberField(change, "rirLow", fail),
        rirHigh: numberField(change, "rirHigh", fail),
      };
    case "update_alternatives":
      return { kind, dayRole, exerciseSlug, alternatives: stringArray(change["alternatives"], "alternatives", fail) };
    case "update_cue_refs":
      return { kind, dayRole, exerciseSlug, cueRefs: stringArray(change["cueRefs"], "cueRefs", fail) };
    case "remove_exercise":
      return { kind, dayRole, exerciseSlug };
    case "add_exercise": {
      const optionalNumber = (name: string): number | undefined => change[name] === undefined
        ? undefined
        : numberField(change, name, fail);
      const repRangeLow = optionalNumber("repRangeLow");
      const repRangeHigh = optionalNumber("repRangeHigh");
      const rirLow = optionalNumber("rirLow");
      const rirHigh = optionalNumber("rirHigh");
      return {
        kind,
        dayRole,
        exerciseSlug,
        sets: numberField(change, "sets", fail),
        ...(repRangeLow !== undefined ? { repRangeLow } : {}),
        ...(repRangeHigh !== undefined ? { repRangeHigh } : {}),
        ...(rirLow !== undefined ? { rirLow } : {}),
        ...(rirHigh !== undefined ? { rirHigh } : {}),
        ...(change["alternatives"] !== undefined
          ? { alternatives: stringArray(change["alternatives"], "alternatives", fail) } : {}),
        ...(change["cueRefs"] !== undefined
          ? { cueRefs: stringArray(change["cueRefs"], "cueRefs", fail) } : {}),
        ...(typeof change["note"] === "string" && change["note"].trim()
          ? { note: change["note"].trim().slice(0, 500) } : {}),
      } as PlanChange;
    }
    default:
      return fail(`unsupported plan change kind: ${kind}`);
  }
}

function buildDiff(
  beforeDays: Record<string, PlanDayItem[]>,
  afterDays: Record<string, PlanDayItem[]>,
  beforeCycle: string[],
  afterCycle: string[],
  changes: PlanChangeDiff[],
): PlanVersionDiff {
  const roles = [...new Set([...Object.keys(beforeDays), ...Object.keys(afterDays)])].sort();
  return {
    changes,
    changedDays: roles.flatMap((dayRole) => {
      const before = beforeDays[dayRole] ?? [];
      const after = afterDays[dayRole] ?? [];
      return same(before, after) ? [] : [{
        dayRole,
        beforeOrder: exerciseOrder(before),
        afterOrder: exerciseOrder(after),
      }];
    }),
    ...(!same(beforeCycle, afterCycle)
      ? { cyclePattern: { before: beforeCycle, after: afterCycle } }
      : {}),
  };
}

function diff(
  change: PlanChange,
  before: unknown,
  after: unknown,
  assessment?: PlanChangeDiff["assessment"],
): PlanChangeDiff {
  return {
    kind: change.kind,
    target: {
      ...("dayRole" in change ? { dayRole: change.dayRole } : {}),
      ...("exerciseSlug" in change ? { exerciseSlug: change.exerciseSlug } : {}),
    },
    before,
    after,
    ...(assessment ? { assessment } : {}),
  };
}

const PRESCRIPTION_KEYS = [
  "order",
  "sets",
  "repRangeLow",
  "repRangeHigh",
  "rirLow",
  "rirHigh",
  "tempo",
  "restSeconds",
] as const;

function replacementPrescription(
  source: PlanDayItem,
  replacementExerciseSlug: string,
  profile: PlanExerciseProfile,
): PlanDayItem {
  const prescription: Record<string, unknown> = {};
  for (const key of PRESCRIPTION_KEYS) {
    if (source[key] !== undefined) prescription[key] = clone(source[key]);
  }
  return {
    ...prescription,
    exerciseSlug: replacementExerciseSlug,
    ...(profile.nameZh ? { nameZh: profile.nameZh } : {}),
    ...(profile.movementPattern ? { movementPattern: profile.movementPattern } : {}),
    ...(profile.trainingPurpose ? { trainingPurpose: profile.trainingPurpose } : {}),
    ...(profile.primaryMuscles ? { primaryMuscles: [...profile.primaryMuscles] } : {}),
    ...(profile.equipment !== undefined ? { equipment: profile.equipment } : {}),
    ...(profile.stabilityDemand ? { stabilityDemand: profile.stabilityDemand } : {}),
    ...(profile.rangeOfMotion ? { rangeOfMotion: profile.rangeOfMotion } : {}),
  } as PlanDayItem;
}

function assessReplacement(
  source: PlanDayItem,
  original: PlanExerciseProfile,
  replacement: PlanExerciseProfile,
  change: Extract<PlanChange, { kind: "replace_exercise" }>,
  context: PlanCompileContext,
  fail: (message: string) => never,
): NonNullable<PlanChangeDiff["assessment"]> {
  const required = (profile: PlanExerciseProfile, label: string) => {
    if (!profile.trainingPurpose) fail(`${label} exercise has no training purpose`);
    if (!profile.movementPattern) fail(`${label} exercise has no movement pattern`);
    if (!profile.primaryMuscles || profile.primaryMuscles.length === 0) fail(`${label} exercise has no primary muscles`);
    if (!profile.stabilityDemand) fail(`${label} exercise has no stability demand`);
    if (profile.equipment === undefined) fail(`${label} exercise has no equipment profile`);
    if (!profile.rangeOfMotion) fail(`${label} exercise has no range-of-motion profile`);
  };
  required(original, "original");
  required(replacement, "replacement");

  if (original.trainingPurpose !== replacement.trainingPurpose) {
    fail(`training purpose mismatch: ${original.trainingPurpose} -> ${replacement.trainingPurpose}`);
  }
  const originalMuscles = new Set(original.primaryMuscles);
  const sharedMuscles = replacement.primaryMuscles!.filter((muscle) => originalMuscles.has(muscle));
  if (sharedMuscles.length === 0) {
    fail(`primary muscle mismatch: ${original.primaryMuscles!.join("|")} -> ${replacement.primaryMuscles!.join("|")}`);
  }
  const originalCoverage = sharedMuscles.length / original.primaryMuscles!.length;
  if (original.movementPattern !== replacement.movementPattern && originalCoverage < 0.5) {
    fail(`movement pattern mismatch loses primary-muscle purpose: ${original.movementPattern} -> ${replacement.movementPattern}`);
  }

  if (context.blockedExerciseSlugs?.has(change.replacementExerciseSlug)) {
    fail(`replacement exercise ${change.replacementExerciseSlug} is blocked by an active pain constraint`);
  }
  if (context.blockedMovementPatterns?.has(replacement.movementPattern!)) {
    fail(`replacement movement pattern ${replacement.movementPattern} is blocked by an active pain constraint`);
  }
  const equipment = replacement.equipment?.trim().toLowerCase();
  if (equipment && context.unavailableEquipment?.has(equipment)) {
    fail(`replacement equipment ${replacement.equipment} is unavailable`);
  }
  const jointConflicts = (replacement.contraindicationTags ?? [])
    .filter((tag) => context.activeJointConstraints?.has(tag));
  if (jointConflicts.length > 0) {
    fail(`replacement conflicts with active joint constraints: ${jointConflicts.join(", ")}`);
  }

  const stabilityRank = new Map([["low", 0], ["medium", 1], ["high", 2]]);
  const originalStability = stabilityRank.get(original.stabilityDemand!);
  const replacementStability = stabilityRank.get(replacement.stabilityDemand!);
  if (originalStability === undefined || replacementStability === undefined) {
    fail("stability demand must be low, medium, or high");
  }
  if (replacementStability > originalStability + 1) {
    fail(`stability demand increases too far: ${original.stabilityDemand} -> ${replacement.stabilityDemand}`);
  }

  const romRank = new Map([["reduced", 0], ["full", 1], ["extended", 2]]);
  const originalRom = romRank.get(original.rangeOfMotion!);
  const replacementRom = romRank.get(replacement.rangeOfMotion!);
  if (originalRom === undefined || replacementRom === undefined) {
    fail("range of motion must be reduced, full, or extended");
  }
  if (replacementRom > originalRom) {
    fail(`range of motion increases without validation: ${original.rangeOfMotion} -> ${replacement.rangeOfMotion}`);
  }

  const beforeSets = finiteNumberOrNull(source["sets"]);
  const afterSets = beforeSets;
  const preserved = [
    `training purpose: ${original.trainingPurpose}`,
    `primary muscles: ${sharedMuscles.join(", ")}`,
    ...(original.movementPattern === replacement.movementPattern
      ? [`movement pattern: ${original.movementPattern}`] : []),
  ];
  const lost = [
    ...(original.movementPattern !== replacement.movementPattern
      ? [`movement pattern changes: ${original.movementPattern} -> ${replacement.movementPattern}`] : []),
    ...original.primaryMuscles!.filter((muscle) => !replacement.primaryMuscles!.includes(muscle))
      .map((muscle) => `primary muscle emphasis: ${muscle}`),
    ...(original.equipment !== replacement.equipment
      ? [`equipment familiarity: ${String(original.equipment)} -> ${String(replacement.equipment)}`] : []),
    ...(original.stabilityDemand !== replacement.stabilityDemand
      ? [`stability demand: ${original.stabilityDemand} -> ${replacement.stabilityDemand}`] : []),
    ...(original.rangeOfMotion !== replacement.rangeOfMotion
      ? [`range of motion: ${original.rangeOfMotion} -> ${replacement.rangeOfMotion}`] : []),
  ];
  return {
    preserved,
    lost,
    volume: { beforeSets, afterSets, changed: beforeSets !== afterSets },
    allowedBecause: [
      "training purpose matches",
      "primary-muscle overlap is sufficient",
      "active pain, joint, equipment, stability, and range-of-motion checks passed",
    ],
    nextValidation: [
      `validate target-muscle feel and pain response for ${change.replacementExerciseSlug}`,
      "confirm prescribed volume and technique quality before retaining the replacement",
    ],
  };
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validateAndReturnCueRefs(
  refs: string[],
  target: PlanDayItem,
  context: PlanCompileContext,
  fail: (message: string) => never,
): string[] {
  const validated = validateRefs(refs, "cueRefs", fail);
  validateCueReferences(validated, target, context, fail);
  return validated;
}

function createdCueTarget(exerciseSlug: string, profile: PlanExerciseProfile | undefined): PlanDayItem {
  return {
    exerciseSlug,
    ...(profile?.movementPattern ? { movementPattern: profile.movementPattern } : {}),
  };
}

function validateCueReferences(
  refs: string[],
  target: PlanDayItem,
  context: PlanCompileContext,
  fail: (message: string) => never,
): void {
  if (!context.cueReferences) fail("validated media segment catalog is required for cue refs");
  const targetProfile = context.exerciseCatalog?.get(target.exerciseSlug);
  const movementPattern = targetProfile?.movementPattern
    ?? (typeof target["movementPattern"] === "string" ? target["movementPattern"] : undefined);
  const primaryMuscles = new Set(targetProfile?.primaryMuscles ?? asStringArray(target["primaryMuscles"]));
  for (const ref of refs) {
    const segment = context.cueReferences.get(ref);
    if (!segment) fail(`cue reference ${ref} does not exist`);
    if (!segment.valid) fail(`cue reference ${ref} is invalid: ${segment.reason ?? "media integrity check failed"}`);
    const issueMatch = [
      segment.exerciseSlug,
      segment.movementPattern,
      segment.bodyPart,
      ...(segment.problemTags ?? []),
    ].some((value) => typeof value === "string" && context.reflectionIssueTargets?.has(value));
    const matches = segment.exerciseSlug === target.exerciseSlug
      || (movementPattern !== undefined && segment.movementPattern === movementPattern)
      || (segment.bodyPart !== null && segment.bodyPart !== undefined && primaryMuscles.has(segment.bodyPart))
      || issueMatch;
    if (!matches) fail(`cue reference ${ref} does not match the target exercise, body part, movement, or reflection problem`);
  }
}

function validateCycleStructure(
  cycle: string[],
  days: Record<string, PlanDayItem[]>,
  catalog: ReadonlyMap<string, PlanExerciseProfile> | undefined,
  fail: (message: string) => never,
): void {
  let run = 0;
  let maximumRun = 0;
  for (let index = 0; index < cycle.length * 2; index += 1) {
    const role = cycle[index % cycle.length]!;
    run = role === "REST" ? 0 : Math.min(run + 1, cycle.length + 1);
    maximumRun = Math.max(maximumRun, run);
  }
  if (maximumRun > 3) fail("cyclePattern cannot exceed three consecutive training days, including the repeat boundary");

  const musclesByRole = new Map<string, Set<string>>();
  for (const [role, items] of Object.entries(days)) {
    const muscles = new Set<string>();
    for (const item of items) {
      const profile = catalog?.get(item.exerciseSlug);
      for (const muscle of profile?.primaryMuscles ?? asStringArray(item["primaryMuscles"])) muscles.add(muscle);
    }
    musclesByRole.set(role, muscles);
  }
  for (let index = 0; index < cycle.length; index += 1) {
    const current = cycle[index]!;
    const next = cycle[(index + 1) % cycle.length]!;
    if (current === "REST" || next === "REST") continue;
    if (current === next) fail(`cyclePattern repeats body-part day ${current} on consecutive positions`);
    const currentMuscles = musclesByRole.get(current) ?? new Set<string>();
    const overlap = [...(musclesByRole.get(next) ?? [])].filter((muscle) => currentMuscles.has(muscle));
    if (overlap.length > 0) {
      fail(`cyclePattern trains the same primary muscles on consecutive positions: ${overlap.join(", ")}`);
    }
  }
}

function requireTarget(
  days: Record<string, PlanDayItem[]>,
  target: { dayRole: string; exerciseSlug: string },
  fail: (message: string) => never,
) {
  return requireExercise(requireDay(days, target.dayRole, fail), target.exerciseSlug, fail);
}

function requireDay(
  days: Record<string, PlanDayItem[]>,
  role: string,
  fail: (message: string) => never,
): PlanDayItem[] {
  const list = days[role];
  return list ?? fail(`day ${role} is not in the active plan`);
}

function requireExercise(
  list: PlanDayItem[],
  slug: string,
  fail: (message: string) => never,
): { item: PlanDayItem; index: number } {
  const index = list.findIndex((item) => item.exerciseSlug === slug);
  if (index < 0) fail(`exercise ${slug} is not on target day`);
  return { item: list[index]!, index };
}

function requireCatalogExercise(
  slug: string,
  catalog: ReadonlyMap<string, { nameZh?: string; movementPattern?: string }> | undefined,
  fail: (message: string) => never,
) {
  if (!catalog) return undefined;
  const exercise = catalog.get(slug);
  return exercise ?? fail(`exercise ${slug} is not in the exercise catalog`);
}

function validateSets(value: number, fail: (message: string) => never): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SETS_PER_EXERCISE) {
    fail(`sets must be an integer between 1 and ${MAX_SETS_PER_EXERCISE}`);
  }
}

function validateOptionalPrescription(
  change: Extract<PlanChange, { kind: "add_exercise" }>,
  fail: (message: string) => never,
): void {
  if (change.repRangeLow !== undefined || change.repRangeHigh !== undefined) {
    if (change.repRangeLow === undefined || change.repRangeHigh === undefined) {
      fail("rep range requires both repRangeLow and repRangeHigh");
    }
    validateRange(change.repRangeLow, change.repRangeHigh, "rep range", 1, 100, fail);
  }
  if (change.rirLow !== undefined || change.rirHigh !== undefined) {
    if (change.rirLow === undefined || change.rirHigh === undefined) {
      fail("RIR requires both rirLow and rirHigh");
    }
    validateRange(change.rirLow, change.rirHigh, "RIR", 0, 10, fail);
  }
}

function validateRange(
  low: number,
  high: number,
  label: string,
  minimum: number,
  maximum: number,
  fail: (message: string) => never,
): void {
  if (!Number.isInteger(low) || !Number.isInteger(high) || low < minimum || high > maximum || low > high) {
    fail(`${label} must be ordered integers between ${minimum} and ${maximum}`);
  }
}

function validateDayVolumes(
  days: Record<string, PlanDayItem[]>,
  fail: (message: string) => never,
): void {
  for (const [role, items] of Object.entries(days)) {
    if (items.length === 0) fail(`plan change would leave day ${role} empty`);
    const total = items.reduce((sum, item) => sum + Number(item["sets"] ?? 0), 0);
    if (!Number.isFinite(total) || total < 1 || total > MAX_SETS_PER_DAY) {
      fail(`day ${role} total sets must remain between 1 and ${MAX_SETS_PER_DAY}`);
    }
  }
}

function normalizeCycle(raw: unknown, dayRoles: string[], index: number): string[] {
  const fail = (message: string): never => { throw new PlanChangeValidationError(index, message); };
  const cycle = raw === undefined
    ? ["A", "B", "REST", "C", "REST"].filter((role) => role === "REST" || dayRoles.includes(role))
    : stringArray(raw, "cyclePattern", fail).map((role) => role.toUpperCase());
  if (cycle.length < 2 || cycle.length > MAX_CYCLE_LENGTH) {
    fail(`cyclePattern must contain 2-${MAX_CYCLE_LENGTH} positions`);
  }
  const allowed = new Set([...dayRoles, "REST"]);
  const unknown = cycle.filter((role) => !allowed.has(role));
  if (unknown.length > 0) fail(`cyclePattern contains unknown roles: ${unknown.join(", ")}`);
  if (!cycle.some((role) => role !== "REST")) fail("cyclePattern must contain a training day");
  if (!cycle.includes("REST")) fail("cyclePattern must contain at least one REST position");
  return cycle;
}

function validateRefs(
  values: string[],
  label: string,
  fail: (message: string) => never,
): string[] {
  if (values.length > MAX_LIST_REFS) fail(`${label} must contain at most ${MAX_LIST_REFS} entries`);
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
  if (values.some((value) => value.length > 200)) fail(`${label} entries must contain at most 200 characters`);
  return [...values];
}

function normalizeItems(items: unknown[]): PlanDayItem[] {
  return items.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = clone(raw as Record<string, unknown>);
    const slug = typeof item["exerciseSlug"] === "string" ? item["exerciseSlug"].trim() : "";
    return slug ? [{ ...item, exerciseSlug: slug, order: index + 1 }] : [];
  });
}

function cloneDays(days: Record<string, PlanDayItem[]>): Record<string, PlanDayItem[]> {
  return Object.fromEntries(Object.entries(days).map(([role, items]) => [role, items.map(clone)]));
}

function applyOrder(items: PlanDayItem[]): void {
  items.forEach((item, index) => { item["order"] = index + 1; });
}

function exerciseOrder(items: PlanDayItem[]): string[] {
  return items.map((item) => item.exerciseSlug);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  fail: (message: string) => never,
): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim() === "") fail(`${key} is required`);
  return raw.trim();
}

function numberField(
  value: Record<string, unknown>,
  key: string,
  fail: (message: string) => never,
): number {
  const raw = value[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) fail(`${key} must be a finite number`);
  return raw;
}

function stringArray(raw: unknown, label: string, fail: (message: string) => never): string[] {
  if (!Array.isArray(raw) || raw.length === 0) fail(`${label} must be a non-empty array`);
  return raw.map((value, index) => {
    if (typeof value !== "string" || value.trim() === "") fail(`${label}[${index}] must be a non-empty string`);
    return value.trim();
  });
}

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
