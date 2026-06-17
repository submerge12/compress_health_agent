import type { ExerciseLog, ExerciseType, HealthRepository } from "./store.js";

export interface LogExerciseInput {
  date: string;
  description: string;
}

const DURATION_PATTERN = /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min|分钟)/i;
const KCAL_PER_MINUTE: Record<ExerciseType, number> = {
  running: 9.333333333,
  walking: 4,
  cycling: 7,
  swimming: 8,
  strength: 5,
};

const TYPE_PATTERNS: Array<[ExerciseType, RegExp]> = [
  ["running", /running|run|跑步/i],
  ["walking", /walking|walk|散步|走路/i],
  ["cycling", /cycling|biking|bike|骑行|骑车/i],
  ["swimming", /swimming|swim|游泳/i],
  ["strength", /strength|weights?|lifting|力量|举铁/i],
];

export function logExercise(input: LogExerciseInput, repository: HealthRepository): ExerciseLog {
  const fields = requireInputObject(input, "input");
  const date = requireIsoDate(fields.date);
  const description = requireText(fields.description, "description");
  const type = parseExerciseType(description);
  const durationMinutes = parseDurationMinutes(description);
  const kcalBurned = Math.round(durationMinutes * KCAL_PER_MINUTE[type]);
  return repository.insertExerciseLog({ date, description, type, durationMinutes, kcalBurned });
}

function parseExerciseType(description: string): ExerciseType {
  const match = TYPE_PATTERNS.find(([, pattern]) => pattern.test(description));
  if (match === undefined) {
    throw new RangeError("exercise type must be running, walking, cycling, swimming, or strength");
  }
  return match[0];
}

function parseDurationMinutes(description: string): number {
  const match = description.match(DURATION_PATTERN);
  if (match === null) {
    throw new RangeError("exercise duration minutes is required");
  }
  return positiveNumber(Number(match[1]), "durationMinutes");
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

function requireInputObject(value: LogExerciseInput, name: string): Record<string, unknown> {
  const candidate: unknown = value;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new RangeError(`${name} must be an object`);
  }
  return candidate as Record<string, unknown>;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}
