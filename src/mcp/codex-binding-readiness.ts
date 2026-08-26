import { createHash } from "node:crypto";

import { count, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import { localDateInTimezone } from "../domain/timezone.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface CodexBindingReadiness {
  bindingFingerprint: string;
  locale: string;
  timezone: string;
  localDate: string;
  hasProfile: boolean;
  history: {
    observations: number;
    physicalConditions: number;
    dietLogs: number;
    trainingSessions: number;
    total: number;
  };
  readyForRealJourneys: boolean;
  blockers: string[];
}

/**
 * Verify an exact existing-user binding without returning identity or health
 * payload fields. This function is deliberately read-only.
 */
export async function inspectCodexBinding(
  db: Db,
  externalUserId: string,
  now = new Date(),
): Promise<CodexBindingReadiness | null> {
  const [user] = await db.select({
    id: schema.users.id,
    locale: schema.users.locale,
    timezone: schema.users.timezone,
  }).from(schema.users)
    .where(eq(schema.users.externalId, externalUserId))
    .limit(1);
  if (!user) return null;

  const [profile, observations, physicalConditions, dietLogs, trainingSessions] = await Promise.all([
    db.select({ value: count() }).from(schema.bmrProfiles)
      .where(eq(schema.bmrProfiles.userId, user.id)),
    db.select({ value: count() }).from(schema.healthObservationEvents)
      .where(eq(schema.healthObservationEvents.userId, user.id)),
    db.select({ value: count() }).from(schema.physicalConditions)
      .where(eq(schema.physicalConditions.userId, user.id)),
    db.select({ value: count() }).from(schema.dietLogs)
      .where(eq(schema.dietLogs.userId, user.id)),
    db.select({ value: count() }).from(schema.trainingSessions)
      .where(eq(schema.trainingSessions.userId, user.id)),
  ]);

  const history = {
    observations: numberValue(observations[0]?.value),
    physicalConditions: numberValue(physicalConditions[0]?.value),
    dietLogs: numberValue(dietLogs[0]?.value),
    trainingSessions: numberValue(trainingSessions[0]?.value),
    total: 0,
  };
  history.total = history.observations
    + history.physicalConditions
    + history.dietLogs
    + history.trainingSessions;

  const hasProfile = numberValue(profile[0]?.value) > 0;
  const blockers: string[] = [];
  if (!hasProfile) blockers.push("profile_missing");
  if (history.total === 0) blockers.push("health_history_missing");

  return {
    bindingFingerprint: createHash("sha256").update(externalUserId).digest("hex").slice(0, 12),
    locale: user.locale,
    timezone: user.timezone,
    localDate: localDateInTimezone(user.timezone, now),
    hasProfile,
    history,
    readyForRealJourneys: blockers.length === 0,
    blockers,
  };
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
