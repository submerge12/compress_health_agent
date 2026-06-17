import type { HealthRepository, PhysicalCondition, PhysicalConditionInsert } from "./store.js";

export interface LogWeightInput {
  date: string;
  description: string;
}

const WEIGHT_PATTERN = /(\d+(?:\.\d+)?)\s*(?:kg|公斤|千克)/i;
const BP_PATTERN = /(\d{2,3})\s*\/\s*(\d{2,3})/;

export function logWeight(input: LogWeightInput, repository: HealthRepository): PhysicalCondition {
  const fields = requireInputObject(input, "input");
  const date = requireIsoDate(fields.date);
  const description = requireText(fields.description, "description");
  const weightKg = parseWeightKg(description);
  const bloodPressure = parseBloodPressure(description);
  const row: PhysicalConditionInsert = { date, description, weightKg };
  if (bloodPressure !== undefined) {
    row.bpSystolic = bloodPressure.systolic;
    row.bpDiastolic = bloodPressure.diastolic;
  }
  return repository.insertPhysicalCondition(row);
}

function parseWeightKg(description: string): number {
  const match = description.match(WEIGHT_PATTERN);
  if (match === null) {
    throw new RangeError("weight kg is required");
  }
  return positiveNumber(Number(match[1]), "weightKg");
}

function parseBloodPressure(description: string): { systolic: number; diastolic: number } | undefined {
  const match = description.match(BP_PATTERN);
  if (match === null) {
    return undefined;
  }
  return {
    systolic: positiveNumber(Number(match[1]), "bpSystolic"),
    diastolic: positiveNumber(Number(match[2]), "bpDiastolic"),
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

function requireInputObject(value: LogWeightInput, name: string): Record<string, unknown> {
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
