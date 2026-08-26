/**
 * Domain policy for singleton body observations.
 *
 * Sleep, fatigue, recovery, and weight may be corrected without deleting the
 * original fact. For one user/day/kind, the newest non-revoked fact is the
 * effective value. Callers must pass rows newest-first so PostgreSQL remains
 * the authority when two timestamps are closer than JavaScript's precision.
 */
export const SINGLETON_OBSERVATION_KINDS = [
  "sleep",
  "fatigue",
  "recovery",
  "weight",
] as const;

export type SingletonObservationKind = typeof SINGLETON_OBSERVATION_KINDS[number];

interface ObservationLike {
  observedOn: string;
  kind: string;
}

export function selectEffectiveSingletonObservations<T extends ObservationLike>(
  newestFirst: readonly T[],
): T[] {
  const singletonKinds = new Set<string>(SINGLETON_OBSERVATION_KINDS);
  const seen = new Set<string>();
  const effective: T[] = [];

  for (const observation of newestFirst) {
    if (!singletonKinds.has(observation.kind)) continue;
    const key = `${observation.observedOn}:${observation.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    effective.push(observation);
  }

  return effective;
}

export function latestEffectiveSingletonObservation<T extends ObservationLike>(
  newestFirst: readonly T[],
  kind: SingletonObservationKind,
): T | undefined {
  return selectEffectiveSingletonObservations(newestFirst)
    .find((observation) => observation.kind === kind);
}
