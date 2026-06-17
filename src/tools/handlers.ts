import type { ToolContext } from "./context.js";
import type {
  BmrProfileRow,
  DietLogRow,
  WaterLogRow,
  ExerciseLogRow,
  WeightLogRow,
  MealPlanEntryRow,
} from "../db/repository.js";
import { calculateCaloriePlan } from "../engine/calorie.js";
import type { CalorieProfile, CaloriePlan } from "../engine/types.js";
import {
  nutritionEstimate,
  parseMealItems,
  type NutritionEstimateInput,
  type NutritionEstimateResult,
} from "./nutrition-estimate.js";
import {
  generateWeeklyReport,
  type WeeklyReport,
  type WeeklyReportDay,
} from "./weekly-report.js";
import {
  recipeRecommend,
  type RecipeRecommendInput,
  type RecipeRecommendResult,
} from "./recipe-recommend.js";
import {
  generateMealPlan as generateMealPlanCore,
  type GenerateMealPlanResult,
  type GenerateMealPlanInput,
} from "./generate-meal-plan.js";
import {
  updateCookingRecord as updateCookingRecordCore,
  type UpdateCookingRecordInput,
  type UpdateCookingRecordResult,
} from "./update-cooking-record.js";
import type { MealPlanEntry, MealType } from "../engine/meal-planner.js";
import { loadCandidateDishes, loadUserPreferences } from "./candidate-loader.js";

// ── Shared validation ──

function requireIsoDate(value: unknown): string {
  if (typeof value !== "string") throw new RangeError("date must be a string");
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) throw new RangeError("date must use YYYY-MM-DD format");
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new RangeError("date must be a real YYYY-MM-DD date");
  }
  return trimmed;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new RangeError(`${name} is required`);
  return trimmed;
}

const MEAL_TYPES = new Set(["breakfast", "lunch", "dinner", "snack"]);

function requireMealType(value: unknown): string {
  const mt = requireText(value, "mealType").toLowerCase();
  if (!MEAL_TYPES.has(mt)) throw new RangeError(`mealType must be one of: ${[...MEAL_TYPES].join(", ")}`);
  return mt;
}

// ── 0. Set Profile ──

export interface SetProfileInput {
  sex: "male" | "female";
  ageYears: number;
  heightCm: number;
  weightKg: number;
  activityLevel: "sedentary" | "lightly_active" | "moderately_active" | "strength_training";
  goal: string;
}

export interface SetProfileResult {
  profile: BmrProfileRow;
  plan: CaloriePlan;
}

export async function handleSetProfile(ctx: ToolContext, input: SetProfileInput): Promise<SetProfileResult> {
  const p: CalorieProfile = {
    sex: input.sex,
    ageYears: input.ageYears,
    heightCm: input.heightCm,
    weightKg: input.weightKg,
    activityLevel: input.activityLevel,
    goal: input.goal as CalorieProfile["goal"],
  };
  const plan = calculateCaloriePlan(p);
  const profile = await ctx.repo.upsertBmrProfile(ctx.userId, {
    sex: p.sex,
    ageYears: p.ageYears,
    heightCm: p.heightCm,
    weightKg: p.weightKg,
    activityLevel: p.activityLevel,
    goal: p.goal,
    bmrKcal: plan.bmrKcal,
    tdeeKcal: plan.tdeeKcal,
    targetKcal: plan.targetKcal,
    proteinTargetGrams: plan.macros.proteinGrams,
    carbsTargetGrams: plan.macros.carbsGrams,
    fatTargetGrams: plan.macros.fatGrams,
  });
  return { profile, plan };
}

// ── 1. Nutrition Estimate (read-only) ──

export async function handleNutritionEstimate(
  ctx: ToolContext,
  input: NutritionEstimateInput,
): Promise<NutritionEstimateResult> {
  return nutritionEstimate(input, ctx.catalog);
}

// ── 2. Log Meal ──

export interface LogMealInput {
  date: string;
  mealType: string;
  description: string;
}

export async function handleLogMeal(ctx: ToolContext, input: LogMealInput): Promise<DietLogRow> {
  const date = requireIsoDate(input.date);
  const mealType = requireMealType(input.mealType);
  const description = requireText(input.description, "description");

  const estimate = nutritionEstimate({ description }, ctx.catalog);
  const items = parseMealItems(description, ctx.catalog);

  return ctx.repo.insertDietLog({
    userId: ctx.userId,
    logDate: date,
    mealType,
    description,
    source: "agent",
    ingredientsJson: items.map((i) => ({ slug: i.slug, grams: i.grams })),
    seasoningsJson: [],
    caloriesKcal: estimate.kcal,
    proteinGrams: estimate.proteinGrams,
    carbsGrams: estimate.carbsGrams,
    fatGrams: estimate.fatGrams,
    sodiumMg: estimate.sodiumMg,
  });
}

// ── 3. Log Water ──

const ML_PATTERN = /(\d+(?:\.\d+)?)\s*(?:ml|毫升)/i;
const CUP_PATTERN = /(?:(\d+(?:\.\d+)?|one|two|three|一|二|两|三)\s*)?(?:cups?|glass(?:es)?|杯|杯水)/i;
const CUP_ML = 250;

const WORD_QUANTITIES: Record<string, number> = {
  one: 1, two: 2, three: 3, "一": 1, "二": 2, "两": 2, "三": 3,
};

function parseWaterAmountMl(description: string): number {
  const explicit = description.match(ML_PATTERN);
  if (explicit) return Math.round(Number(explicit[1]));
  const cup = description.match(CUP_PATTERN);
  if (cup) {
    const qty = cup[1] ? (WORD_QUANTITIES[cup[1].toLowerCase()] ?? Number(cup[1])) : 1;
    return Math.round(qty * CUP_ML);
  }
  throw new RangeError("water amount is required");
}

export interface LogWaterInput {
  date: string;
  description: string;
}

export async function handleLogWater(ctx: ToolContext, input: LogWaterInput): Promise<WaterLogRow> {
  const date = requireIsoDate(input.date);
  const description = requireText(input.description, "description");
  const amountMl = parseWaterAmountMl(description);
  return ctx.repo.insertWaterLog(ctx.userId, date, amountMl);
}

// ── 4. Log Exercise ──

type ExerciseType = "running" | "walking" | "cycling" | "swimming" | "strength";

const DURATION_PATTERN = /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min|分钟)/i;
const KCAL_PER_MINUTE: Record<ExerciseType, number> = {
  running: 9.333, walking: 4, cycling: 7, swimming: 8, strength: 5,
};
const TYPE_PATTERNS: Array<[ExerciseType, RegExp]> = [
  ["running", /running|run|跑步/i],
  ["walking", /walking|walk|散步|走路/i],
  ["cycling", /cycling|biking|bike|骑行|骑车/i],
  ["swimming", /swimming|swim|游泳/i],
  ["strength", /strength|weights?|lifting|力量|举铁/i],
];

export interface LogExerciseInput {
  date: string;
  description: string;
}

export async function handleLogExercise(ctx: ToolContext, input: LogExerciseInput): Promise<ExerciseLogRow> {
  const date = requireIsoDate(input.date);
  const description = requireText(input.description, "description");

  const typeMatch = TYPE_PATTERNS.find(([, p]) => p.test(description));
  if (!typeMatch) throw new RangeError("exercise type must be running, walking, cycling, swimming, or strength");
  const activityType = typeMatch[0];

  const durMatch = description.match(DURATION_PATTERN);
  if (!durMatch) throw new RangeError("exercise duration minutes is required");
  const durationMinutes = Number(durMatch[1]);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new RangeError("durationMinutes must be positive");

  const caloriesBurnedKcal = Math.round(durationMinutes * KCAL_PER_MINUTE[activityType]);

  return ctx.repo.insertExerciseLog({
    userId: ctx.userId,
    logDate: date,
    activityType,
    durationMinutes,
    caloriesBurnedKcal,
    intensity: null,
    notes: description,
  });
}

// ── 5. Log Weight ──

const WEIGHT_PATTERN = /(\d+(?:\.\d+)?)\s*(?:kg|公斤|千克)/i;

export interface LogWeightInput {
  date: string;
  description: string;
}

export async function handleLogWeight(ctx: ToolContext, input: LogWeightInput): Promise<WeightLogRow> {
  const description = requireText(input.description, "description");

  const match = description.match(WEIGHT_PATTERN);
  if (!match) throw new RangeError("weight kg is required");
  const weightKg = Number(match[1]);
  if (!Number.isFinite(weightKg) || weightKg <= 0) throw new RangeError("weightKg must be positive");

  return ctx.repo.insertWeightLog(ctx.userId, {
    weightKg,
    bodyFatPercent: null,
    waistCm: null,
    notes: description,
  });
}

// ── 6. Daily Summary (read-only) ──

export interface DailySummaryInput {
  date: string;
}

export interface DailySummaryResult {
  date: string;
  eaten: { kcal: number; proteinGrams: number; carbsGrams: number; fatGrams: number; sodiumMg: number };
  target: { kcal: number; proteinGrams: number; carbsGrams: number; fatGrams: number };
  remaining: { kcal: number; proteinGrams: number; carbsGrams: number; fatGrams: number };
  water: { totalMl: number; targetMl: number; logs: number };
  exercise: { kcalBurned: number; durationMinutes: number; targetMinutes: number; logs: number };
  mealCount: number;
  warnings: string[];
}

export async function handleDailySummary(ctx: ToolContext, input: DailySummaryInput): Promise<DailySummaryResult> {
  const date = requireIsoDate(input.date);

  const [dietLogs, waterLogs, exerciseLogs, bmrProfile] = await Promise.all([
    ctx.repo.listDietLogs(ctx.userId, date),
    ctx.repo.listWaterLogs(ctx.userId, date),
    ctx.repo.listExerciseLogs(ctx.userId, date),
    ctx.repo.getLatestBmrProfile(ctx.userId),
  ]);

  const target = {
    kcal: bmrProfile?.targetKcal ?? 2000,
    proteinGrams: bmrProfile?.proteinTargetGrams ?? 60,
    carbsGrams: bmrProfile?.carbsTargetGrams ?? 250,
    fatGrams: bmrProfile?.fatTargetGrams ?? 65,
  };

  const eaten = {
    kcal: sum(dietLogs.map((l) => l.caloriesKcal)),
    proteinGrams: round1(sum(dietLogs.map((l) => l.proteinGrams))),
    carbsGrams: round1(sum(dietLogs.map((l) => l.carbsGrams))),
    fatGrams: round1(sum(dietLogs.map((l) => l.fatGrams))),
    sodiumMg: sum(dietLogs.map((l) => l.sodiumMg)),
  };

  const warnings: string[] = [];
  if (eaten.sodiumMg > 2300) warnings.push("sodium_over_2300mg");

  return {
    date,
    eaten,
    target,
    remaining: {
      kcal: target.kcal - eaten.kcal,
      proteinGrams: round1(target.proteinGrams - eaten.proteinGrams),
      carbsGrams: round1(target.carbsGrams - eaten.carbsGrams),
      fatGrams: round1(target.fatGrams - eaten.fatGrams),
    },
    water: { totalMl: sum(waterLogs.map((w) => w.amountMl)), targetMl: 2000, logs: waterLogs.length },
    exercise: {
      kcalBurned: sum(exerciseLogs.map((e) => e.caloriesBurnedKcal)),
      durationMinutes: sum(exerciseLogs.map((e) => e.durationMinutes)),
      targetMinutes: 30,
      logs: exerciseLogs.length,
    },
    mealCount: dietLogs.length,
    warnings,
  };
}

// ── 7. Weekly Report (read-only) ──

export interface WeeklyReportInput {
  endDate: string;
  sodiumLimitMg?: number;
}

export async function handleWeeklyReport(ctx: ToolContext, input: WeeklyReportInput): Promise<WeeklyReport> {
  const endDate = requireIsoDate(input.endDate);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  const startDate = start.toISOString().slice(0, 10);

  const [dietLogs, bmrProfile] = await Promise.all([
    ctx.repo.listDietLogsRange(ctx.userId, startDate, endDate),
    ctx.repo.getLatestBmrProfile(ctx.userId),
  ]);

  const targetKcal = bmrProfile?.targetKcal ?? 2000;
  const days: WeeklyReportDay[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayLogs = dietLogs.filter((l) => l.logDate === dateStr);
    days.push({
      date: dateStr,
      targetKcal,
      kcal: sum(dayLogs.map((l) => l.caloriesKcal)),
      proteinGrams: sum(dayLogs.map((l) => l.proteinGrams)),
      carbsGrams: sum(dayLogs.map((l) => l.carbsGrams)),
      fatGrams: sum(dayLogs.map((l) => l.fatGrams)),
      sodiumMg: sum(dayLogs.map((l) => l.sodiumMg)),
    });
  }

  return generateWeeklyReport({ days, sodiumLimitMg: input.sodiumLimitMg });
}

// ── 8. Recipe Recommend (read-only) ──

export async function handleRecipeRecommend(
  _ctx: ToolContext,
  input: RecipeRecommendInput,
): Promise<RecipeRecommendResult> {
  return recipeRecommend(input);
}

// ── 9. Generate Meal Plan ──

export async function handleGenerateMealPlan(
  ctx: ToolContext,
  input: Omit<GenerateMealPlanInput, "store">,
): Promise<GenerateMealPlanResult> {
  const entries: MealPlanEntry[] = [];
  const store = {
    insertMealPlanEntry: (entry: MealPlanEntry) => { entries.push(entry); },
  };
  const result = generateMealPlanCore({ ...input, store });

  for (const entry of entries) {
    await ctx.repo.insertMealPlanEntry({
      userId: ctx.userId,
      planDate: entry.date,
      mealType: entry.mealType,
      dishName: entry.dish.name,
      recipeSlug: entry.dish.slug,
      status: "planned",
      ingredientsJson: (entry.dish.ingredients ?? []).map((i) => ({ slug: i.slug, grams: i.grams })),
      seasoningsJson: (entry.dish.seasonings ?? []).map((s) => ({ slug: s })),
      caloriesKcal: entry.nutrition.kcal,
      proteinGrams: entry.nutrition.proteinGrams,
      carbsGrams: entry.nutrition.carbsGrams,
      fatGrams: entry.nutrition.fatGrams,
      sodiumMg: entry.nutrition.sodiumMg ?? 0,
    });
  }

  return result;
}

// ── 10. Meal Check-in ──

export type MealCheckinStatus = "followed" | "substituted" | "skipped";

export interface MealCheckinInput {
  date: string;
  mealType: string;
  status: MealCheckinStatus;
  actualDescription?: string;
}

export interface MealCheckinResult {
  entryId: string;
  status: MealCheckinStatus;
  dietLogId?: string;
}

export async function handleMealCheckin(ctx: ToolContext, input: MealCheckinInput): Promise<MealCheckinResult> {
  const date = requireIsoDate(input.date);
  const mealType = requireMealType(input.mealType);
  const status = input.status;

  const entries = await ctx.repo.listMealPlanEntries(ctx.userId, date);
  const entry = entries.find((e) => e.mealType === mealType);
  if (!entry) throw new RangeError(`No planned ${mealType} entry for ${date}`);

  await ctx.repo.updateMealPlanStatus(entry.id, status);

  if (status === "skipped") {
    return { entryId: entry.id, status };
  }

  let description = entry.dishName;
  let kcal = entry.caloriesKcal;
  let protein = entry.proteinGrams;
  let carbs = entry.carbsGrams;
  let fat = entry.fatGrams;
  let sodium = entry.sodiumMg;

  if (status === "substituted" && input.actualDescription) {
    description = input.actualDescription;
    const estimate = nutritionEstimate({ description }, ctx.catalog);
    kcal = estimate.kcal;
    protein = estimate.proteinGrams;
    carbs = estimate.carbsGrams;
    fat = estimate.fatGrams;
    sodium = estimate.sodiumMg;
  }

  const dietLog = await ctx.repo.insertDietLog({
    userId: ctx.userId,
    logDate: date,
    mealType,
    description,
    source: status === "followed" ? "planned" : "substituted",
    ingredientsJson: entry.ingredientsJson,
    seasoningsJson: entry.seasoningsJson,
    caloriesKcal: kcal,
    proteinGrams: protein,
    carbsGrams: carbs,
    fatGrams: fat,
    sodiumMg: sodium,
  });

  return { entryId: entry.id, status, dietLogId: dietLog.id };
}

// ── 11. Update Cooking Record ──

export async function handleUpdateCookingRecord(
  ctx: ToolContext,
  input: Omit<UpdateCookingRecordInput, "store">,
): Promise<UpdateCookingRecordResult> {
  const result = updateCookingRecordCore({ ...input });
  await ctx.repo.upsertCookingRecord(ctx.userId, result.record.ingredientSlug, {
    description: result.record.notes,
    notes: result.record.notes,
  });
  return { ...result, stored: true };
}

// ── 12. Smart Generate Meal Plan (auto-loads candidates & targets) ──

export interface SmartGenerateMealPlanInput {
  startDate?: string;
}

export async function handleSmartGenerateMealPlan(
  ctx: ToolContext,
  input: SmartGenerateMealPlanInput,
): Promise<GenerateMealPlanResult> {
  const startDate = input.startDate
    ? requireIsoDate(input.startDate)
    : tomorrow();

  const [bmrProfile, candidates, preferences] = await Promise.all([
    ctx.repo.getLatestBmrProfile(ctx.userId),
    loadCandidateDishes(ctx),
    loadUserPreferences(ctx),
  ]);

  const dailyKcalTarget = bmrProfile?.targetKcal ?? 2000;

  return handleGenerateMealPlan(ctx, {
    startDate,
    dailyKcalTarget,
    presetDishes: candidates,
    preferences,
  });
}

// ── 13. Smart Recipe Recommend (auto-loads candidates) ──

export interface SmartRecipeRecommendInput {
  mealType: string;
  maxKcal?: number;
}

export async function handleSmartRecipeRecommend(
  ctx: ToolContext,
  input: SmartRecipeRecommendInput,
): Promise<RecipeRecommendResult> {
  const mealType = requireText(input.mealType, "mealType").toLowerCase() as MealType;
  if (!["breakfast", "lunch", "dinner"].includes(mealType)) {
    throw new RangeError("mealType must be breakfast, lunch, or dinner");
  }

  const [bmrProfile, candidates, preferences] = await Promise.all([
    ctx.repo.getLatestBmrProfile(ctx.userId),
    loadCandidateDishes(ctx),
    loadUserPreferences(ctx),
  ]);

  const dailyTarget = bmrProfile?.targetKcal ?? 2000;
  const MEAL_SPLIT: Record<string, number> = { breakfast: 0.25, lunch: 0.40, dinner: 0.35 };
  const maxKcal = input.maxKcal ?? Math.round(dailyTarget * (MEAL_SPLIT[mealType] ?? 0.35));

  return handleRecipeRecommend(ctx, {
    mealType,
    maxKcal,
    candidates: [...candidates],
    preferences,
  });
}

// ── Helpers ──

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function sum(values: number[]): number {
  return values.reduce((t, v) => t + v, 0);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
