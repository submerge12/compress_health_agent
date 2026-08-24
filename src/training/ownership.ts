/**
 * WO-HS-02 / M17: object-level ownership checks.
 *
 * Every write/read on a nested aggregate must verify the full chain
 * user → session → exercise (etc.), not merely that a UUID exists. All
 * helpers throw NotFoundError (404 upstream) — never leak existence of
 * another user's objects via 403-vs-404 distinctions.
 */
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

export class NotOwnedError extends Error {
  readonly code = "not_found";
  constructor(readonly objectType: string) {
    super(`${objectType} not found for current user`);
  }
}

export function createOwnership(db: Db) {
  async function requireOwnedTrainingSession(userId: string, sessionId: string) {
    const [row] = await db.select().from(schema.trainingSessions)
      .where(and(eq(schema.trainingSessions.id, sessionId), eq(schema.trainingSessions.userId, userId)))
      .limit(1);
    if (!row) throw new NotOwnedError("training_session");
    return row;
  }

  async function requireOwnedSessionExercise(userId: string, sessionId: string, sessionExerciseId: string) {
    const session = await requireOwnedTrainingSession(userId, sessionId);
    const [exercise] = await db.select().from(schema.trainingSessionExercises)
      .where(and(
        eq(schema.trainingSessionExercises.id, sessionExerciseId),
        eq(schema.trainingSessionExercises.sessionId, sessionId),
      ))
      .limit(1);
    if (!exercise) throw new NotOwnedError("session_exercise");
    return { session, exercise };
  }

  async function requireOwnedReflection(userId: string, reflectionId: string) {
    const [row] = await db.select().from(schema.trainingReflections)
      .where(and(
        eq(schema.trainingReflections.id, reflectionId),
        eq(schema.trainingReflections.userId, userId),
      ))
      .limit(1);
    if (!row) throw new NotOwnedError("training_reflection");
    return row;
  }

  async function requireOwnedConstraint(userId: string, constraintId: string) {
    const [row] = await db.select().from(schema.healthConstraints)
      .where(and(
        eq(schema.healthConstraints.id, constraintId),
        eq(schema.healthConstraints.userId, userId),
      ))
      .limit(1);
    if (!row) throw new NotOwnedError("health_constraint");
    return row;
  }

  async function requireOwnedDietLog(userId: string, logId: string) {
    const [row] = await db.select().from(schema.dietLogs)
      .where(and(eq(schema.dietLogs.id, logId), eq(schema.dietLogs.userId, userId)))
      .limit(1);
    if (!row) throw new NotOwnedError("diet_log");
    return row;
  }

  return {
    requireOwnedTrainingSession,
    requireOwnedSessionExercise,
    requireOwnedReflection,
    requireOwnedConstraint,
    requireOwnedDietLog,
  };
}
