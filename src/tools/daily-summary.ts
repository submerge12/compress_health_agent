import type {
  DietLog,
  ExerciseLog,
  HealthRepository,
  NutrientSnapshot,
  PhysicalCondition,
} from "./store.js";
import { dailyThresholdWarnings } from "./daily-thresholds.js";

export interface DailyTargets {
  kcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
}

export interface DailySummaryInput {
  date: string;
  target: DailyTargets;
}

export interface DailySummaryResult {
  date: string;
  eaten: Omit<NutrientSnapshot, "micronutrients">;
  target: DailyTargets;
  remaining: DailyTargets;
  water: { totalMl: number; logs: number };
  exercise: { kcalBurned: number; durationMinutes: number; logs: number };
  latestPhysicalCondition?: PhysicalCondition;
  warnings: string[];
}

export function dailySummary(
  input: DailySummaryInput,
  repository: HealthRepository,
): DailySummaryResult {
  const fields = requireInputObject(input, "input");
  const date = requireIsoDate(fields.date);
  const target = validateTarget(fields.target);
  const dietLogs = repository.listDietLogs(date);
  const waterLogs = repository.listWaterLogs(date);
  const exerciseLogs = repository.listExerciseLogs(date);
  const conditions = repository.listPhysicalConditions(date);
  const eaten = sumDietLogs(dietLogs);
  return {
    date,
    eaten,
    target: { ...target },
    remaining: remainingFrom(target, eaten),
    water: { totalMl: sum(waterLogs.map((row) => row.amountMl)), logs: waterLogs.length },
    exercise: exerciseTotals(exerciseLogs),
    latestPhysicalCondition: latestCondition(conditions),
    warnings: dailyThresholdWarnings(eaten, target),
  };
}

function sumDietLogs(logs: DietLog[]): Omit<NutrientSnapshot, "micronutrients"> {
  return {
    kcal: sum(logs.map((row) => row.kcal)),
    proteinGrams: roundTo(sum(logs.map((row) => row.proteinGrams)), 1),
    carbsGrams: roundTo(sum(logs.map((row) => row.carbsGrams)), 1),
    fatGrams: roundTo(sum(logs.map((row) => row.fatGrams)), 1),
    sodiumMg: sum(logs.map((row) => row.sodiumMg)),
  };
}

function remainingFrom(target: DailyTargets, eaten: Omit<NutrientSnapshot, "micronutrients">): DailyTargets {
  return {
    kcal: target.kcal - eaten.kcal,
    proteinGrams: roundTo(target.proteinGrams - eaten.proteinGrams, 1),
    carbsGrams: roundTo(target.carbsGrams - eaten.carbsGrams, 1),
    fatGrams: roundTo(target.fatGrams - eaten.fatGrams, 1),
  };
}

function exerciseTotals(logs: ExerciseLog[]): DailySummaryResult["exercise"] {
  return {
    kcalBurned: sum(logs.map((row) => row.kcalBurned)),
    durationMinutes: roundTo(sum(logs.map((row) => row.durationMinutes)), 1),
    logs: logs.length,
  };
}

function latestCondition(conditions: PhysicalCondition[]): PhysicalCondition | undefined {
  if (conditions.length === 0) {
    return undefined;
  }
  return conditions[conditions.length - 1];
}

function validateTarget(target: unknown): DailyTargets {
  const fields = requireRecord(target, "target");
  return {
    kcal: positiveNumber(fields.kcal, "target.kcal"),
    proteinGrams: positiveNumber(fields.proteinGrams, "target.proteinGrams"),
    carbsGrams: positiveNumber(fields.carbsGrams, "target.carbsGrams"),
    fatGrams: positiveNumber(fields.fatGrams, "target.fatGrams"),
  };
}

function requireIsoDate(value: unknown): string {
  const date = requireText(value, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError("date must use YYYY-MM-DD format");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RangeError("date must be a real YYYY-MM-DD date");
  }
  return date;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new RangeError(`${name} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RangeError(`${name} is required`);
  }
  return trimmed;
}

function requireInputObject(value: DailySummaryInput, name: string): Record<string, unknown> {
  return requireRecord(value, name);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
