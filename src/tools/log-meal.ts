import type { DietLog, HealthRepository } from "./store.js";
import {
  type MealCatalog,
  parseMealItems,
  nutritionEstimate,
} from "./nutrition-estimate.js";

export interface LogMealInput {
  date: string;
  mealType: string;
  description: string;
}

const MEAL_TYPES = new Set(["breakfast", "lunch", "dinner", "snack"]);

export function logMeal(
  input: LogMealInput,
  repository: HealthRepository,
  catalog: MealCatalog,
): DietLog {
  const fields = requireInputObject(input, "input");
  const date = requireIsoDate(fields.date);
  const mealType = requireMealType(fields.mealType);
  const description = requireText(fields.description, "description");
  const estimate = nutritionEstimate({ description }, catalog);
  return repository.insertDietLog({
    date,
    mealType,
    description,
    items: parseMealItems(description, catalog),
    kcal: estimate.kcal,
    proteinGrams: estimate.proteinGrams,
    carbsGrams: estimate.carbsGrams,
    fatGrams: estimate.fatGrams,
    sodiumMg: estimate.sodiumMg,
    micronutrients: estimate.micronutrients,
  });
}

function requireMealType(value: unknown): string {
  const mealType = requireText(value, "mealType").toLocaleLowerCase();
  if (!MEAL_TYPES.has(mealType)) {
    throw new RangeError(`mealType must be one of: ${[...MEAL_TYPES].join(", ")}`);
  }
  return mealType;
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

function requireInputObject(value: LogMealInput, name: string): Record<string, unknown> {
  const candidate: unknown = value;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new RangeError(`${name} must be an object`);
  }
  return candidate as Record<string, unknown>;
}
