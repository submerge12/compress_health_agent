import type { HealthRepository, WaterLog } from "./store.js";

export interface LogWaterInput {
  date: string;
  description: string;
}

const ML_PATTERN = /(\d+(?:\.\d+)?)\s*(?:ml|毫升)/i;
const CUP_PATTERN = /(?:(\d+(?:\.\d+)?|one|two|three|一|二|两|三)\s*)?(?:cups?|glass(?:es)?|杯|杯水)/i;
const CUP_ML = 250;

export function logWater(input: LogWaterInput, repository: HealthRepository): WaterLog {
  const fields = requireInputObject(input, "input");
  const date = requireIsoDate(fields.date);
  const description = requireText(fields.description, "description");
  const amountMl = parseWaterAmountMl(description);
  return repository.insertWaterLog({ date, description, amountMl });
}

function parseWaterAmountMl(description: string): number {
  const explicit = description.match(ML_PATTERN);
  if (explicit !== null) {
    return positiveWholeNumber(Number(explicit[1]), "water amount ml");
  }
  const cup = description.match(CUP_PATTERN);
  if (cup !== null) {
    return positiveRoundedInteger(quantityFromText(cup[1]) * CUP_ML, "water amount ml");
  }
  throw new RangeError("water amount is required");
}

function quantityFromText(value: string | undefined): number {
  const text = value?.toLocaleLowerCase();
  const words: Record<string, number> = { one: 1, two: 2, three: 3, "一": 1, "二": 2, "两": 2, "三": 3 };
  if (text === undefined || text === "") {
    return 1;
  }
  return words[text] ?? Number(text);
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

function requireInputObject(value: LogWaterInput, name: string): Record<string, unknown> {
  const candidate: unknown = value;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new RangeError(`${name} must be an object`);
  }
  return candidate as Record<string, unknown>;
}

function positiveWholeNumber(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function positiveRoundedInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return Math.round(value);
}
