export interface SessionExerciseVolumeInput {
  id: string;
  exerciseSlug: string;
  targetSets: number;
  replacementForId: string | null;
  replacedById: string | null;
}

export interface SubstitutionLineage {
  originalExerciseId: string;
  replacementExerciseId: string;
  originalSlug: string;
  replacementSlug: string;
  originalPlannedSetBudget: number;
  inheritedSetBudget: number;
  originalCompletedSets: number;
  replacementCompletedSets: number;
  /** Compatibility keys retained while V1 consumers move to lineage fields. */
  replacementForId: string;
  slug: string;
}

export interface SessionVolumeSummary {
  plannedExercises: number;
  completedExercises: number;
  plannedSetBudget: number;
  completedSetBudget: number;
  completionRate: number;
  substitutions: SubstitutionLineage[];
}

/**
 * Aggregate set volume by original-plan lineage, not by physical rows.
 * Replacements inherit unfinished work; they never create a new set budget.
 */
export function summarizeSessionVolume(
  exercises: readonly SessionExerciseVolumeInput[],
  doneSetsByExercise: ReadonlyMap<string, number>,
): SessionVolumeSummary {
  const byId = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  const children = new Map<string, SessionExerciseVolumeInput[]>();
  for (const exercise of exercises) {
    if (exercise.replacementForId === null) continue;
    const siblings = children.get(exercise.replacementForId) ?? [];
    siblings.push(exercise);
    children.set(exercise.replacementForId, siblings);
  }

  const roots = exercises.filter((exercise) =>
    exercise.replacementForId === null || !byId.has(exercise.replacementForId));
  const visited = new Set<string>();
  const lineages: SessionExerciseVolumeInput[][] = [];

  const collectLineage = (root: SessionExerciseVolumeInput) => {
    const lineage: SessionExerciseVolumeInput[] = [];
    let current: SessionExerciseVolumeInput | undefined = root;
    while (current !== undefined && !visited.has(current.id)) {
      visited.add(current.id);
      lineage.push(current);
      current = current.replacedById !== null
        ? byId.get(current.replacedById)
        : children.get(current.id)?.[0];
    }
    if (lineage.length > 0) lineages.push(lineage);
  };

  for (const root of roots) collectLineage(root);
  for (const orphan of exercises) {
    if (!visited.has(orphan.id)) collectLineage(orphan);
  }

  let plannedSetBudget = 0;
  let completedSetBudget = 0;
  let completedExercises = 0;
  for (const lineage of lineages) {
    const original = lineage[0]!;
    const planned = Math.max(original.targetSets, 0);
    const logged = lineage.reduce(
      (sum, exercise) => sum + Math.max(doneSetsByExercise.get(exercise.id) ?? 0, 0),
      0,
    );
    const completed = Math.min(logged, planned);
    plannedSetBudget += planned;
    completedSetBudget += completed;
    if (planned > 0 && completed >= planned) completedExercises += 1;
  }

  const rootFor = (exercise: SessionExerciseVolumeInput): SessionExerciseVolumeInput => {
    let current = exercise;
    const seen = new Set<string>();
    while (current.replacementForId !== null && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.replacementForId);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const substitutions = exercises
    .filter((exercise) => exercise.replacementForId !== null)
    .map((replacement): SubstitutionLineage => {
      const original = byId.get(replacement.replacementForId!)!;
      const root = rootFor(original);
      return {
        originalExerciseId: original.id,
        replacementExerciseId: replacement.id,
        originalSlug: original.exerciseSlug,
        replacementSlug: replacement.exerciseSlug,
        originalPlannedSetBudget: root.targetSets,
        inheritedSetBudget: replacement.targetSets,
        originalCompletedSets: doneSetsByExercise.get(original.id) ?? 0,
        replacementCompletedSets: doneSetsByExercise.get(replacement.id) ?? 0,
        replacementForId: original.id,
        slug: replacement.exerciseSlug,
      };
    });

  return {
    plannedExercises: lineages.length,
    completedExercises,
    plannedSetBudget,
    completedSetBudget,
    completionRate: plannedSetBudget === 0 ? 0 : completedSetBudget / plannedSetBudget,
    substitutions,
  };
}
