import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import { calculateCaloriePlan } from "../engine/calorie.js";
import type { ActivityLevel, CalorieProfile, Goal } from "../engine/types.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface EffectiveBodyProfileInput {
  effectiveDate: string;
  sex: CalorieProfile["sex"];
  ageYears: number;
  heightCm: number;
  weightKg: number;
  goalWeightKg: number;
  activityLevel: ActivityLevel;
  goal: Goal;
  trainingCadence: string;
  trainingSplit: string;
}

export function createBodyProfileService(db: Db) {
  async function recordEffectiveProfile(userId: string, input: EffectiveBodyProfileInput) {
    validateEffectiveDate(input.effectiveDate);
    validateGoalWeight(input.weightKg, input.goalWeightKg, input.goal);
    const trainingCadence = boundedText(input.trainingCadence, "trainingCadence");
    const trainingSplit = boundedText(input.trainingSplit, "trainingSplit");
    const plan = calculateCaloriePlan({
      sex: input.sex,
      ageYears: input.ageYears,
      heightCm: input.heightCm,
      weightKg: input.weightKg,
      activityLevel: input.activityLevel,
      goal: input.goal,
    });

    const [created] = await db.insert(schema.bmrProfiles).values({
      userId,
      effectiveDate: input.effectiveDate,
      sex: input.sex,
      ageYears: input.ageYears,
      heightCm: input.heightCm,
      weightKg: input.weightKg,
      goalWeightKg: input.goalWeightKg,
      activityLevel: input.activityLevel,
      goal: input.goal,
      trainingCadence,
      trainingSplit,
      bmrKcal: plan.bmrKcal,
      tdeeKcal: plan.tdeeKcal,
      targetKcal: plan.targetKcal,
      proteinTargetGrams: plan.macros.proteinGrams,
      carbsTargetGrams: plan.macros.carbsGrams,
      fatTargetGrams: plan.macros.fatGrams,
    }).returning();
    if (!created) throw new Error("body profile insert returned no row");

    const [outbox] = await db.insert(schema.outboxEvents).values({
      userId,
      aggregateType: "body_profile",
      aggregateId: created.id,
      eventType: "body_profile.version_recorded",
      payloadJson: {
        observedOn: input.effectiveDate,
        profileId: created.id,
      },
    }).returning({ id: schema.outboxEvents.id });
    if (!outbox) throw new Error("body profile outbox insert returned no row");

    const [readBack] = await db.select().from(schema.bmrProfiles).where(and(
      eq(schema.bmrProfiles.id, created.id),
      eq(schema.bmrProfiles.userId, userId),
    )).limit(1);
    if (!readBack) throw new Error("body profile read-back failed");

    return { profile: readBack, plan, outboxEventId: outbox.id };
  }

  return { recordEffectiveProfile };
}

function validateEffectiveDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError("effectiveDate must be an ISO date");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError("effectiveDate must be a real ISO date");
  }
}

function validateGoalWeight(weightKg: number, goalWeightKg: number, goal: Goal): void {
  if (!Number.isFinite(goalWeightKg) || goalWeightKg <= 0 || goalWeightKg > 500) {
    throw new RangeError("goalWeightKg must be between 0 and 500");
  }
  if (goal.startsWith("fat_loss") && goalWeightKg >= weightKg) {
    throw new RangeError("fat-loss goalWeightKg must be lower than weightKg");
  }
  if (goal.startsWith("muscle_gain") && goalWeightKg <= weightKg) {
    throw new RangeError("muscle-gain goalWeightKg must be higher than weightKg");
  }
}

function boundedText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 100) {
    throw new RangeError(`${field} must contain 1 to 100 characters`);
  }
  return normalized;
}
