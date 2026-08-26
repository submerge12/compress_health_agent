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
  assertNutritionEstimateResolved,
  FALLBACK_FOOD_SLUG,
  nutritionEstimate,
  nutritionEstimateWithSemanticFallback,
  type FallbackEstimateDiagnostic,
  type NutritionEstimateInput,
  type NutritionEstimateResult,
  type SemanticNutritionResolutionOptions,
  type WeightBasisDiagnostic,
} from "./nutrition-estimate.js";
import {
  generateWeeklyReport,
  type WeeklyReport,
  type WeeklyReportDay,
} from "./weekly-report.js";
import { dailyThresholdWarnings } from "./daily-thresholds.js";
import {
  recipeRecommend,
  type RecipeRecommendInput,
  type RecipeRecommendResult,
} from "./recipe-recommend.js";
import {
  buildPoolRequest,
  generateMealPlan as generateMealPlanCore,
  type GenerateMealPlanDependencies,
  type GenerateMealPlanResult,
  type GenerateMealPlanInput,
} from "./generate-meal-plan.js";
import { selectWeeklyPool } from "../engine/pool-selection.js";
import {
  updateCookingRecord as updateCookingRecordCore,
  type UpdateCookingRecordInput,
  type UpdateCookingRecordResult,
} from "./update-cooking-record.js";
import {
  proposeDish,
  userDishRowFromResolvedDish,
  type ProposeDishInput,
  type ResolvedDish,
} from "./add-dish.js";
import type { MealPlanEntry, MealType } from "../engine/meal-planner.js";
import {
  DEFAULT_STAPLE,
  STAPLES,
  addNutrition,
  dishNutrition,
  solveProteinTopUps,
  solveStaplePortionsForDay,
  stapleNutrition,
  type ProteinTopUpPortion,
  type StaplePortion,
} from "../engine/meal-composition.js";
import {
  hasRejectedIngredient,
  hasRejectedSeasoning,
  type RecipeDish,
  type RecipeNutrition,
} from "../engine/recipe-engine.js";
import {
  ENERGY_TOLERANCE_RATIO,
  MAX_ENERGY_TOLERANCE_RATIO,
  PROTEIN_FLOOR_RATIO,
} from "../engine/scoring-weights.js";
import { loadCandidateDishes, loadUserPreferences } from "./candidate-loader.js";
import { renderTemplate, type Language } from "../i18n.js";

export {
  handleRemember,
  handleRecall,
  type RecallInput,
  type RecallResult,
  type RememberInput,
  type RememberResult,
} from "./memory.js";

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

// ── 0b. Get Profile (read-only) ──

export interface GetProfileResult {
  profile: BmrProfileRow | null;
}

/**
 * Read the user's saved physical profile and computed targets. Returns
 * { profile: null } when the user has no profile yet, so the agent can tell a
 * returning user (skip onboarding) from a new one.
 */
export async function handleGetProfile(
  ctx: ToolContext,
  _input: Record<string, unknown>,
): Promise<GetProfileResult> {
  const profile = await ctx.repo.getLatestBmrProfile(ctx.userId);
  return { profile: profile ?? null };
}

// ── 1. Nutrition Estimate (read-only) ──

export async function handleNutritionEstimate(
  ctx: ToolContext,
  input: NutritionEstimateInput,
): Promise<NutritionEstimateResult> {
  return estimateNutrition(ctx, input);
}

// ── 2. Log Meal ──

export interface LogMealInput {
  date: string;
  mealType: string;
  description: string;
}

export type LogMealResult = DietLogRow & {
  basisWarnings?: WeightBasisDiagnostic[];
  fallbackEstimates?: FallbackEstimateDiagnostic[];
  uncertain?: boolean;
};

export async function handleLogMeal(ctx: ToolContext, input: LogMealInput): Promise<LogMealResult> {
  const date = requireIsoDate(input.date);
  const mealType = requireMealType(input.mealType);
  const description = requireText(input.description, "description");

  const estimate = await estimateNutrition(ctx, { description });
  assertNutritionEstimateResolved(estimate);

  const row = await ctx.repo.insertDietLog({
    userId: ctx.userId,
    logDate: date,
    mealType,
    description,
    source: "agent",
    ingredientsJson: ingredientsJsonFromEstimate(estimate),
    seasoningsJson: [],
    caloriesKcal: estimate.kcal,
    proteinGrams: estimate.proteinGrams,
    carbsGrams: estimate.carbsGrams,
    fatGrams: estimate.fatGrams,
    sodiumMg: estimate.sodiumMg,
  });
  return {
    ...row,
    ...(estimate.basisWarnings !== undefined ? { basisWarnings: estimate.basisWarnings } : {}),
    ...(estimate.fallbackEstimates !== undefined ? { fallbackEstimates: estimate.fallbackEstimates } : {}),
    ...(estimate.uncertain === true ? { uncertain: true } : {}),
  };
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

  const warnings = dailyThresholdWarnings(eaten, target);

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

  return generateWeeklyReport({
    days,
    sodiumLimitMg: input.sodiumLimitMg,
    dailyFatTarget: bmrProfile?.fatTargetGrams,
    dailyCarbsTarget: bmrProfile?.carbsTargetGrams,
  });
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
  dependencies: GenerateMealPlanDependencies | undefined = undefined,
): Promise<GenerateMealPlanResult> {
  const entries: MealPlanEntry[] = [];
  const store = {
    insertMealPlanEntry: (entry: MealPlanEntry) => { entries.push(entry); },
  };
  const result = generateMealPlanCore({ ...input, catalog: ctx.catalog, store }, dependencies);

  let occupiedSlots = new Set<string>();
  if (entries.length > 0) {
    // Regeneration supersedes: clear not-yet-actioned entries in the plan
    // window so duplicate rows cannot accumulate. Check-in history is kept —
    // and slots it occupies must not receive a second (planned) row.
    const endDate = addDaysIso(input.startDate, 6);
    await ctx.repo.deletePlannedMealPlanEntriesRange?.(ctx.userId, input.startDate, endDate);
    const remaining = await ctx.repo.listMealPlanEntriesRange?.(ctx.userId, input.startDate, endDate) ?? [];
    occupiedSlots = new Set(remaining.map((row) => `${row.planDate}|${row.mealType}`));
  }

  for (const entry of entries.filter((entry) => !occupiedSlots.has(`${entry.date}|${entry.mealType}`))) {
    await ctx.repo.insertMealPlanEntry({
      userId: ctx.userId,
      planDate: entry.date,
      mealType: entry.mealType,
      dishName: entry.dish.name,
      recipeSlug: entry.dish.slug,
      status: "planned",
      ingredientsJson: [
        ...(entry.dish.ingredients ?? []),
        ...(entry.side?.ingredients ?? []),
        ...(entry.proteinTopUps ?? []).flatMap((topUp) => topUp.ingredients),
        ...(entry.staple === undefined ? [] : [entry.staple]),
      ].map((i) => ({ slug: i.slug, grams: i.grams })),
      seasoningsJson: [
        ...(entry.dish.seasonings ?? []),
        ...(entry.side?.seasonings ?? []),
      ].map((s) => ({ slug: s })),
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
  basisWarnings?: WeightBasisDiagnostic[];
  fallbackEstimates?: FallbackEstimateDiagnostic[];
  uncertain?: boolean;
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
  let ingredientsJson = entry.ingredientsJson;
  let seasoningsJson = entry.seasoningsJson;
  let basisWarnings: WeightBasisDiagnostic[] | undefined;
  let fallbackEstimates: FallbackEstimateDiagnostic[] | undefined;
  let uncertain: boolean | undefined;

  if (status === "substituted" && input.actualDescription) {
    description = input.actualDescription;
    const estimate = await estimateNutrition(ctx, { description });
    assertNutritionEstimateResolved(estimate);
    ingredientsJson = ingredientsJsonFromEstimate(estimate);
    seasoningsJson = [];
    basisWarnings = estimate.basisWarnings;
    fallbackEstimates = estimate.fallbackEstimates;
    uncertain = estimate.uncertain;
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
    ingredientsJson,
    seasoningsJson,
    caloriesKcal: kcal,
    proteinGrams: protein,
    carbsGrams: carbs,
    fatGrams: fat,
    sodiumMg: sodium,
  });

  return {
    entryId: entry.id,
    status,
    dietLogId: dietLog.id,
    ...(basisWarnings !== undefined ? { basisWarnings } : {}),
    ...(fallbackEstimates !== undefined ? { fallbackEstimates } : {}),
    ...(uncertain === true ? { uncertain: true } : {}),
  };
}

function ingredientsJsonFromEstimate(estimate: NutritionEstimateResult): Record<string, unknown>[] {
  return [
    ...estimate.items.map((item) => ({ slug: item.slug, grams: item.grams })),
    ...(estimate.fallbackEstimates ?? []).map((fallback) => ({
      slug: FALLBACK_FOOD_SLUG,
      segment: fallback.segment,
      grams: fallback.grams,
      estimateSource: "fallback",
      confidence: fallback.confidence,
    })),
  ];
}

function semanticNutritionOptions(ctx: ToolContext): SemanticNutritionResolutionOptions | undefined {
  if (ctx.embeddingClient === undefined) return undefined;
  return {
    embeddingClient: ctx.embeddingClient,
    semanticSearch: ctx.repo,
  };
}

async function estimateNutrition(
  ctx: ToolContext,
  input: NutritionEstimateInput,
): Promise<NutritionEstimateResult> {
  const semanticOptions = semanticNutritionOptions(ctx);
  if (semanticOptions === undefined) {
    return nutritionEstimate(input, ctx.catalog);
  }
  return nutritionEstimateWithSemanticFallback(input, ctx.catalog, semanticOptions);
}

// ── 10b. Proactive Check (scheduled check-ins and summaries) ──

type ProactiveMealType = "breakfast" | "lunch" | "dinner";
type ProactiveCheckKind = "daily_summary" | "meal_checkin" | "missing_plan";

export interface ProactiveCheckInput {
  now?: Date | string;
  locale?: Language;
}

export interface ProactiveThawIngredient {
  slug: string;
  grams?: number;
  category: string;
  name?: string;
}

export interface ProactiveThawItem {
  entryId: string;
  planDate: string;
  mealType: string;
  dishName: string;
  ingredients: ProactiveThawIngredient[];
}

export interface ProactiveCheckResult {
  kind: ProactiveCheckKind;
  locale: Language;
  date: string;
  message: string;
  mealType?: ProactiveMealType;
  plannedMeal?: {
    entryId: string;
    dishName: string;
    kcal: number;
    proteinGrams: number;
  };
  thawItems: ProactiveThawItem[];
}

const THAW_CATEGORIES = new Set(["meat", "poultry", "seafood"]);
const PROACTIVE_MEAL_ORDER: Record<ProactiveMealType, number> = {
  breakfast: 0,
  lunch: 1,
  dinner: 2,
};

export async function handleProactiveCheck(
  ctx: ToolContext,
  input: ProactiveCheckInput = {},
): Promise<ProactiveCheckResult> {
  const now = requireDate(input.now);
  const locale = input.locale ?? ctx.locale;
  const hour = now.getHours();

  if (hour >= 23 || hour < 1) {
    const date = localDateIso(addDays(now, -1));
    const summary = await handleDailySummary(ctx, { date });
    return {
      kind: "daily_summary",
      locale,
      date,
      message: renderTemplate(locale, "proactiveDailySummary", {
        date,
        kcal: summary.eaten.kcal,
        targetKcal: summary.target.kcal,
        remainingKcal: summary.remaining.kcal,
        waterMl: summary.water.totalMl,
        targetWaterMl: summary.water.targetMl,
        exerciseMinutes: summary.exercise.durationMinutes,
        targetExerciseMinutes: summary.exercise.targetMinutes,
        kcalBurned: summary.exercise.kcalBurned,
      }),
      thawItems: [],
    };
  }

  const date = localDateIso(now);
  const mealType = mealTypeForHour(hour);
  const todayEntries = await ctx.repo.listMealPlanEntries(ctx.userId, date);
  const planned = todayEntries.find((entry) => entry.mealType === mealType && entry.status === "planned");

  if (!planned) {
    return {
      kind: "missing_plan",
      locale,
      date,
      mealType,
      message: renderTemplate(locale, "proactiveMissingPlan", {
        date,
        mealType: localizedMealType(mealType, locale),
      }),
      thawItems: [],
    };
  }

  const upcomingPlanned = todayEntries.filter((entry) =>
    entry.status === "planned" &&
    isLaterSameDayMeal(entry.mealType, mealType)
  );

  if (mealType === "dinner") {
    const tomorrow = localDateIso(addDays(now, 1));
    const tomorrowEntries = await ctx.repo.listMealPlanEntries(ctx.userId, tomorrow);
    upcomingPlanned.push(...tomorrowEntries.filter((entry) => entry.status === "planned"));
  }

  const thawItems = buildThawItems(ctx, upcomingPlanned);
  const checkinMessage = renderTemplate(locale, "proactiveMealCheckin", {
    mealType: localizedMealType(mealType, locale),
    dishName: planned.dishName,
    kcal: planned.caloriesKcal,
    proteinGrams: planned.proteinGrams,
  });
  return {
    kind: "meal_checkin",
    locale,
    date,
    mealType,
    plannedMeal: {
      entryId: planned.id,
      dishName: planned.dishName,
      kcal: planned.caloriesKcal,
      proteinGrams: planned.proteinGrams,
    },
    thawItems,
    message: checkinMessage,
  };
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

export async function handleProposeDish(ctx: ToolContext, input: ProposeDishInput): Promise<ResolvedDish> {
  return proposeDish(input, {
    catalog: ctx.catalog,
    seasoningRecords: ctx.seasoningRecords,
  });
}

export async function handleSaveDish(ctx: ToolContext, input: ResolvedDish) {
  const row = userDishRowFromResolvedDish(ctx.userId, input, ctx.catalog);
  return { dish: await ctx.repo.upsertUserDish(row) };
}

export interface SmartGenerateMealPlanInput {
  startDate?: string;
}

export interface MealPlanProfileBasis {
  profileId: string | null;
  effectiveDate: string | null;
  targetKcal: number;
  proteinTargetGrams: number | null;
  fatTargetGrams: number | null;
  carbsTargetGrams: number | null;
  usedDefault: boolean;
}

export type SmartGenerateMealPlanResult = GenerateMealPlanResult & {
  profileBasis: MealPlanProfileBasis;
};

export async function handleSmartGenerateMealPlan(
  ctx: ToolContext,
  input: SmartGenerateMealPlanInput,
  dependencies: GenerateMealPlanDependencies | undefined = undefined,
): Promise<SmartGenerateMealPlanResult> {
  const startDate = input.startDate
    ? requireIsoDate(input.startDate)
    : tomorrow();

  const [bmrProfile, candidates, preferences] = await Promise.all([
    ctx.repo.getEffectiveBmrProfile(ctx.userId, startDate),
    loadCandidateDishes(ctx),
    loadUserPreferences(ctx, { asOfDate: startDate }),
  ]);

  const dailyKcalTarget = bmrProfile?.targetKcal ?? 2000;

  const generated = await handleGenerateMealPlan(ctx, {
    startDate,
    dailyKcalTarget,
    dailyProteinTarget: bmrProfile?.proteinTargetGrams,
    dailyFatTarget: bmrProfile?.fatTargetGrams,
    dailyCarbsTarget: bmrProfile?.carbsTargetGrams,
    presetDishes: candidates,
    preferences,
  }, dependencies);
  return {
    ...generated,
    profileBasis: {
      profileId: bmrProfile?.id ?? null,
      effectiveDate: bmrProfile?.effectiveDate ?? null,
      targetKcal: dailyKcalTarget,
      proteinTargetGrams: bmrProfile?.proteinTargetGrams ?? null,
      fatTargetGrams: bmrProfile?.fatTargetGrams ?? null,
      carbsTargetGrams: bmrProfile?.carbsTargetGrams ?? null,
      usedDefault: bmrProfile === undefined,
    },
  };
}

// ── 12b. Swap Meal (V2-P5: "换一个") ──

export interface SwapMealInput {
  date: string;
  mealType: string;
  alternateSlug: string;
}

export interface SwapMealResult {
  entryId: string;
  date: string;
  mealType: string;
  previousDishSlug: string | null;
  newDish: { slug: string; name: string };
  sideSlug?: string;
  stapleGrams?: number;
  proteinTopUps: readonly string[];
  dayTotals: RecipeNutrition;
  withinEnergyBand: boolean;
  meetsProteinFloor: boolean;
}

/**
 * Swap a planned lunch/dinner main to one of its PRE-VETTED ALTERNATES and
 * re-run the levers for that one meal. Bounded semantics (G2 decision
 * CHA-MPV2-8): free-form substitution is out of scope — the target must
 * satisfy the same rules the planner used to offer alternates, recomputed
 * from stored state because alternates are not persisted (re-vetting at swap
 * time is the no-migration path): pool-drawn and safe, collision-free with
 * this day's and the adjacent days' mains, lever-valid for the whole day
 * (hard kcal band + protein floor), and at the minimal weekly use count
 * available. Non-alternate targets are rejected with a clear error naming
 * the swaps that are pre-vetted right now. The entry keeps its `planned`
 * status so check-ins still attach.
 */
export async function handleSwapMeal(ctx: ToolContext, input: SwapMealInput): Promise<SwapMealResult> {
  const date = requireIsoDate(input.date);
  const mealType = requireText(input.mealType, "mealType").toLowerCase();
  if (mealType !== "lunch" && mealType !== "dinner") {
    throw new RangeError("mealType must be lunch or dinner");
  }
  const alternateSlug = requireText(input.alternateSlug, "alternateSlug");
  if (ctx.catalog.foods.length === 0) {
    throw new RangeError("swap_meal requires the food catalog to re-balance the day");
  }

  const [bmrProfile, candidates, preferences, allRows, surroundingRows] = await Promise.all([
    ctx.repo.getLatestBmrProfile(ctx.userId),
    loadCandidateDishes(ctx),
    loadUserPreferences(ctx, { asOfDate: date }),
    ctx.repo.listMealPlanEntries(ctx.userId, date),
    ctx.repo.listMealPlanEntriesRange(ctx.userId, addDaysIso(date, -3), addDaysIso(date, 3)),
  ]);

  const plannedOfType = allRows.filter((row) => row.mealType === mealType && row.status === "planned");
  if (plannedOfType.length === 0) {
    throw new RangeError(`no planned ${mealType} meal-plan entry found on ${date}`);
  }
  if (plannedOfType.length > 1) {
    throw new RangeError(
      `multiple planned ${mealType} entries found on ${date}; regenerate the plan to supersede stale entries before swapping`,
    );
  }
  const target = plannedOfType[0] as MealPlanEntryRow;

  const alternate = candidates.find((dish) =>
    dish.slug === alternateSlug &&
    dish.role !== "side" &&
    (dish.mealTypes === undefined || dish.mealTypes.includes("lunch") || dish.mealTypes.includes("dinner"))
  );
  if (alternate === undefined) {
    throw new RangeError(`unknown alternate main dish: ${alternateSlug}`);
  }
  if (isRejectedBySafety(alternate, preferences)) {
    throw new RangeError(
      `${alternateSlug} conflicts with saved allergies or exclusions and cannot be swapped in`,
    );
  }

  // Collision rule of the bounded semantics: a pre-vetted alternate never
  // repeats a main within the day or on adjacent days (rotation rules).
  const isCountedMain = (row: MealPlanEntryRow): boolean =>
    (row.mealType === "lunch" || row.mealType === "dinner") && row.status !== "skipped";
  const mainSlugOf = (row: MealPlanEntryRow): string | null => row.recipeSlug;
  const sameDaySlugs = new Set(
    allRows.filter(isCountedMain).map(mainSlugOf).filter((slug): slug is string => slug !== null),
  );
  const adjacentDates = new Set([addDaysIso(date, -1), addDaysIso(date, 1)]);
  const adjacentSlugs = new Set(
    surroundingRows
      .filter((row) => isCountedMain(row) && adjacentDates.has(row.planDate))
      .map(mainSlugOf)
      .filter((slug): slug is string => slug !== null),
  );
  if (sameDaySlugs.has(alternate.slug) || adjacentSlugs.has(alternate.slug)) {
    throw new RangeError(
      `${alternate.slug} is not one of this entry's pre-vetted alternates: it is already planned ` +
      `${sameDaySlugs.has(alternate.slug) ? `on ${date}` : "on an adjacent day"}, ` +
      "and rotation never repeats a main on consecutive days",
    );
  }

  const dailyKcalTarget = bmrProfile?.targetKcal ?? 2000;
  const proteinFloor = bmrProfile?.proteinTargetGrams === undefined
    ? undefined
    : Math.round(bmrProfile.proteinTargetGrams * PROTEIN_FLOOR_RATIO);

  const rowIngredientSlugs = new Set(
    (target.ingredientsJson ?? []).map((item) => String(item["slug"] ?? "")),
  );
  // Keep the plan's staple food: recover its type from the stored row rather
  // than silently switching the user to the default staple.
  const staple = STAPLES.find((candidate) => rowIngredientSlugs.has(candidate.slug)) ?? DEFAULT_STAPLE;

  // A2 repair (R6 C1): the alternates-only bound requires POOL MEMBERSHIP.
  // Derive the week's selected pool exactly the way generation does — the
  // shared buildPoolRequest wiring into selectWeeklyPool — so pool semantics
  // (lean tilt, kcal screen, node-6's skipped>=2 exclusion) keep a single
  // source of truth. The full dish catalog is NOT the pool: most catalog
  // mains sit outside any given week's rotation pool and must be rejected.
  const poolResult = selectWeeklyPool(buildPoolRequest({
    startDate: date,
    dailyKcalTarget,
    ...(bmrProfile?.proteinTargetGrams === undefined ? {} : { dailyProteinTarget: bmrProfile.proteinTargetGrams }),
    ...(bmrProfile?.fatTargetGrams === undefined ? {} : { dailyFatTarget: bmrProfile.fatTargetGrams }),
    ...(bmrProfile?.carbsTargetGrams === undefined ? {} : { dailyCarbsTarget: bmrProfile.carbsTargetGrams }),
    catalog: ctx.catalog,
    staple,
    preferences,
    presetDishes: candidates,
  }, candidates, true));
  if (!poolResult.ok) {
    throw new RangeError(
      `cannot establish this week's pre-vetted pool for swapping: ${poolResult.cannotSatisfy.reason}` +
      "; regenerate the plan instead",
    );
  }
  const poolMains = poolResult.pool.mains;

  // Parity with planning-time vetting: the day's OTHER main frees its staple
  // grams back into the solve, so a lighter alternate can be compensated
  // across both meals exactly as it was when the alternate was vetted.
  const counterpartRows = allRows.filter((row) =>
    row.mealType === (mealType === "lunch" ? "dinner" : "lunch") && row.status === "planned");
  const counterpart = counterpartRows.length === 1 ? counterpartRows[0] : undefined;
  const counterpartStaple = counterpart === undefined ? undefined : stapleFromRow(counterpart);
  const resolveCounterpart = counterpart !== undefined && counterpartStaple !== undefined;
  const counterpartWithoutStaple = !resolveCounterpart || counterpart === undefined || counterpartStaple === undefined
    ? undefined
    : subtractNutrition(rowNutrition(counterpart), stapleNutrition(counterpartStaple, ctx.catalog));

  // Day context beyond the two re-levered meals (skipped meals excluded).
  const baseNutrition = allRows
    .filter((row) =>
      row.id !== target.id &&
      (!resolveCounterpart || row.id !== counterpart?.id) &&
      row.status !== "skipped")
    .reduce<RecipeNutrition>((total, row) => addNutrition(total, rowNutrition(row)), ZERO_NUTRITION);
  const fixedBeyondMeals = counterpartWithoutStaple === undefined
    ? baseNutrition
    : addNutrition(baseNutrition, counterpartWithoutStaple);
  const mainMealCount = counterpartWithoutStaple === undefined ? 1 : 2;

  const safeSides = candidates.filter((dish) =>
    dish.role === "side" && !isRejectedBySafety(dish, preferences));
  const resolveDish = (dish: RecipeDish): SwapDayResolution => resolveSwapDay({
    dish,
    catalog: ctx.catalog,
    preferences,
    rowIngredientSlugs,
    safeSides,
    fixedBeyondMeals,
    mainMealCount,
    staple,
    dailyKcalTarget,
    proteinFloor,
  });

  // Pre-vetted candidates for this slot under the bounded semantics: mains
  // of the SELECTED WEEKLY POOL (safety and skipped>=2 exclusion already
  // applied by selectWeeklyPool) that are collision-free for this day. Used
  // for the minimal-use rule and for naming valid swaps in refusals.
  const useCountOf = (slug: string): number =>
    surroundingRows.filter((row) =>
      isCountedMain(row) && row.id !== target.id && row.recipeSlug === slug).length;
  const boundedCandidates = (excludeSlug: string): readonly RecipeDish[] => poolMains
    .filter((dish) =>
      dish.slug !== excludeSlug &&
      dish.slug !== target.recipeSlug &&
      !sameDaySlugs.has(dish.slug) &&
      !adjacentSlugs.has(dish.slug));
  const vettedNow = (excludeSlug: string): readonly RecipeDish[] => {
    const leverValid = boundedCandidates(excludeSlug).filter((dish) => {
      try {
        return resolveDish(dish).valid;
      } catch {
        // dishes with uncataloged ingredients cannot be suggested
        return false;
      }
    });
    const minUse = Math.min(...leverValid.map((dish) => useCountOf(dish.slug)));
    return leverValid.filter((dish) => useCountOf(dish.slug) === minUse).slice(0, 2);
  };

  const resolution = resolveDish(alternate);
  if (!resolution.valid) {
    // The refusal names swaps that ARE pre-vetted right now, so the user is
    // never stranded pointing at an alternates list that only existed at
    // generation time.
    const validNow = vettedNow(alternate.slug);
    throw new RangeError(
      `swapping in ${alternate.name} would break the day ` +
      `(kcal ${Math.round(resolution.dayTotals.kcal)} vs target ${dailyKcalTarget}` +
      `${proteinFloor === undefined ? "" : `, protein ${resolution.dayTotals.proteinGrams}g vs ${proteinFloor}g floor`})` +
      (validNow.length > 0
        ? `; currently valid swaps: ${validNow.map((dish) => `${dish.name} (${dish.slug})`).join(", ")}`
        : "; no valid swap is available right now — regenerate the day instead"),
    );
  }

  // Pool-membership rule (A2 repair): a lever-valid target must still belong
  // to the week's selected pool. Ordered after the lever refusal so a swap
  // that would break the day keeps its established refusal copy; either way,
  // nothing outside the pool is ever persisted.
  if (!poolMains.some((dish) => dish.slug === alternate.slug)) {
    const avoided = new Set((preferences.avoidedDishSlugs ?? []).map((slug) => slug.trim().toLowerCase()));
    throw new RangeError(
      avoided.has(alternate.slug.trim().toLowerCase())
        ? `${alternate.slug} is not one of this entry's pre-vetted alternates: it was skipped twice ` +
          "or more recently and is excluded from this week's pool"
        : `${alternate.slug} is not one of this entry's pre-vetted alternates: it is outside this ` +
          `week's selected pool (${poolMains.map((dish) => dish.slug).join(", ")})`,
    );
  }

  // Minimal-use rule: the planner offers alternates at the lowest weekly use
  // count available. A target already used nearby is only a pre-vetted
  // alternate when no less-used dish could serve this slot.
  const targetUseCount = useCountOf(alternate.slug);
  if (targetUseCount > 0) {
    const lessUsed = boundedCandidates(alternate.slug)
      .filter((dish) => useCountOf(dish.slug) < targetUseCount)
      .filter((dish) => {
        try {
          return resolveDish(dish).valid;
        } catch {
          return false;
        }
      })
      .slice(0, 2);
    if (lessUsed.length > 0) {
      throw new RangeError(
        `${alternate.slug} is not one of this entry's pre-vetted alternates: it already appears ` +
        `${targetUseCount}x in the surrounding week while less-used alternates exist — ` +
        `currently pre-vetted: ${lessUsed.map((dish) => `${dish.name} (${dish.slug})`).join(", ")}`,
      );
    }
  }

  await ctx.repo.updateMealPlanEntryDish(target.id, {
    dishName: resolution.side === undefined
      ? alternate.name
      : `${alternate.name} + ${resolution.side.name}`,
    recipeSlug: alternate.slug,
    ingredientsJson: [
      ...alternate.ingredients,
      ...(resolution.side?.ingredients ?? []),
      ...resolution.topUps.flatMap((topUp) => topUp.ingredients),
      ...(resolution.swappedStaple === undefined ? [] : [resolution.swappedStaple]),
    ].map((ingredient) => ({ slug: ingredient.slug, grams: ingredient.grams })),
    seasoningsJson: [
      ...alternate.seasonings,
      ...(resolution.side?.seasonings ?? []),
    ].map((seasoning) => ({ slug: seasoning })),
    caloriesKcal: resolution.swappedMealNutrition.kcal,
    proteinGrams: resolution.swappedMealNutrition.proteinGrams,
    carbsGrams: resolution.swappedMealNutrition.carbsGrams,
    fatGrams: resolution.swappedMealNutrition.fatGrams,
    sodiumMg: resolution.swappedMealNutrition.sodiumMg,
  });

  if (
    resolveCounterpart &&
    counterpart !== undefined &&
    counterpartStaple !== undefined &&
    counterpartWithoutStaple !== undefined &&
    resolution.counterpartStaple !== undefined &&
    resolution.counterpartStaple.grams !== counterpartStaple.grams
  ) {
    const counterpartNutrition = addNutrition(
      counterpartWithoutStaple,
      stapleNutrition(resolution.counterpartStaple, ctx.catalog),
    );
    await ctx.repo.updateMealPlanEntryDish(counterpart.id, {
      dishName: counterpart.dishName,
      recipeSlug: counterpart.recipeSlug,
      ingredientsJson: [
        ...(counterpart.ingredientsJson ?? []).filter((item) => String(item["slug"] ?? "") !== counterpartStaple.slug),
        { slug: resolution.counterpartStaple.slug, grams: resolution.counterpartStaple.grams },
      ],
      seasoningsJson: counterpart.seasoningsJson,
      caloriesKcal: counterpartNutrition.kcal,
      proteinGrams: counterpartNutrition.proteinGrams,
      carbsGrams: counterpartNutrition.carbsGrams,
      fatGrams: counterpartNutrition.fatGrams,
      sodiumMg: counterpartNutrition.sodiumMg,
    });
  }

  return {
    entryId: target.id,
    date,
    mealType,
    previousDishSlug: target.recipeSlug,
    newDish: { slug: alternate.slug, name: alternate.name },
    ...(resolution.side === undefined ? {} : { sideSlug: resolution.side.slug }),
    ...(resolution.swappedStaple === undefined ? {} : { stapleGrams: resolution.swappedStaple.grams }),
    proteinTopUps: resolution.topUps.map((topUp) => topUp.slug),
    dayTotals: resolution.dayTotals,
    withinEnergyBand:
      Math.abs(resolution.dayTotals.kcal - dailyKcalTarget) <= dailyKcalTarget * ENERGY_TOLERANCE_RATIO,
    meetsProteinFloor: proteinFloor === undefined || resolution.dayTotals.proteinGrams >= proteinFloor,
  };
}

interface SwapDayResolution {
  valid: boolean;
  dayTotals: RecipeNutrition;
  side?: RecipeDish;
  topUps: readonly ProteinTopUpPortion[];
  swappedStaple?: StaplePortion;
  counterpartStaple?: StaplePortion;
  swappedMealNutrition: RecipeNutrition;
}

function resolveSwapDay(input: {
  dish: RecipeDish;
  catalog: ToolContext["catalog"];
  preferences: Awaited<ReturnType<typeof loadUserPreferences>>;
  rowIngredientSlugs: ReadonlySet<string>;
  safeSides: readonly RecipeDish[];
  fixedBeyondMeals: RecipeNutrition;
  mainMealCount: number;
  staple: (typeof STAPLES)[number];
  dailyKcalTarget: number;
  proteinFloor: number | undefined;
}): SwapDayResolution {
  // Preserve the vegetable side for non-self-contained mains: recover the
  // original from the stored row, else attach any safe side candidate.
  let side: RecipeDish | undefined;
  if (input.dish.selfContained === false) {
    side = input.safeSides.find((candidate) =>
      candidate.ingredients.length > 0 &&
      candidate.ingredients.every((ingredient) => input.rowIngredientSlugs.has(ingredient.slug))) ??
      input.safeSides[0];
  }

  let mealBase = dishNutrition(input.dish, input.catalog);
  if (side !== undefined) mealBase = addNutrition(mealBase, dishNutrition(side, input.catalog));
  const dayFixed = addNutrition(input.fixedBeyondMeals, mealBase);

  let topUps: readonly ProteinTopUpPortion[] = [];
  if (input.proteinFloor !== undefined && input.proteinFloor > 0) {
    const minStaple = stapleNutrition(
      { slug: input.staple.slug, grams: input.staple.minGrams * input.mainMealCount },
      input.catalog,
    );
    if (dayFixed.proteinGrams + minStaple.proteinGrams < input.proteinFloor) {
      topUps = solveProteinTopUps({
        proteinFloorGrams: input.proteinFloor - minStaple.proteinGrams,
        fixedNutrition: dayFixed,
        remainingKcalBudget:
          input.dailyKcalTarget * (1 + ENERGY_TOLERANCE_RATIO) - dayFixed.kcal - minStaple.kcal,
        catalog: input.catalog,
        preferences: input.preferences,
      }).addOns;
    }
  }
  const topUpNutrition = topUps.reduce<RecipeNutrition | undefined>(
    (total, topUp) => total === undefined ? topUp.nutrition : addNutrition(total, topUp.nutrition),
    undefined,
  );
  const fixedWithTopUps = topUpNutrition === undefined ? dayFixed : addNutrition(dayFixed, topUpNutrition);

  const stapleSolve = solveStaplePortionsForDay({
    dailyKcalTarget: input.dailyKcalTarget,
    fixedNutrition: fixedWithTopUps,
    mainMealCount: input.mainMealCount,
    staple: input.staple,
    catalog: input.catalog,
    energyToleranceRatio: ENERGY_TOLERANCE_RATIO,
  });
  const portions = stapleSolve.portions as readonly (StaplePortion | undefined)[];
  const counterpartStaple = input.mainMealCount === 2 ? portions[0] : undefined;
  const swappedStaple = input.mainMealCount === 2 ? portions[1] : portions[0];

  let swappedMealNutrition = mealBase;
  if (topUpNutrition !== undefined) swappedMealNutrition = addNutrition(swappedMealNutrition, topUpNutrition);
  if (swappedStaple !== undefined) {
    swappedMealNutrition = addNutrition(swappedMealNutrition, stapleNutrition(swappedStaple, input.catalog));
  }
  let dayTotals = addNutrition(input.fixedBeyondMeals, swappedMealNutrition);
  if (counterpartStaple !== undefined) {
    dayTotals = addNutrition(dayTotals, stapleNutrition(counterpartStaple, input.catalog));
  }

  const withinHardBand =
    Math.abs(dayTotals.kcal - input.dailyKcalTarget) <= input.dailyKcalTarget * MAX_ENERGY_TOLERANCE_RATIO;
  const meetsFloor = input.proteinFloor === undefined || dayTotals.proteinGrams >= input.proteinFloor;
  return {
    valid: withinHardBand && meetsFloor,
    dayTotals,
    ...(side === undefined ? {} : { side }),
    topUps,
    ...(swappedStaple === undefined ? {} : { swappedStaple }),
    ...(counterpartStaple === undefined ? {} : { counterpartStaple }),
    swappedMealNutrition,
  };
}

const ZERO_NUTRITION: RecipeNutrition = { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 };

function rowNutrition(row: MealPlanEntryRow): RecipeNutrition {
  return {
    kcal: row.caloriesKcal,
    proteinGrams: row.proteinGrams,
    carbsGrams: row.carbsGrams,
    fatGrams: row.fatGrams,
    sodiumMg: row.sodiumMg,
  };
}

function subtractNutrition(left: RecipeNutrition, right: RecipeNutrition): RecipeNutrition {
  return {
    kcal: left.kcal - right.kcal,
    proteinGrams: left.proteinGrams - right.proteinGrams,
    carbsGrams: left.carbsGrams - right.carbsGrams,
    fatGrams: left.fatGrams - right.fatGrams,
    sodiumMg: Math.max(0, left.sodiumMg - right.sodiumMg),
  };
}

function stapleFromRow(row: MealPlanEntryRow): StaplePortion | undefined {
  const stapleSlugs = new Set(STAPLES.map((staple) => staple.slug));
  for (const item of row.ingredientsJson ?? []) {
    const slug = String(item["slug"] ?? "");
    const grams = Number(item["grams"] ?? 0);
    if (stapleSlugs.has(slug) && Number.isFinite(grams) && grams > 0) {
      return { slug, grams };
    }
  }
  return undefined;
}

function isRejectedBySafety(dish: RecipeDish, preferences: {
  rejectedIngredients?: readonly string[];
  rejectedSeasonings?: readonly string[];
  allergens?: readonly string[];
}): boolean {
  return hasRejectedIngredient(dish, preferences.rejectedIngredients ?? [], preferences.allergens ?? []) ||
    hasRejectedSeasoning(dish, preferences.rejectedSeasonings ?? []);
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

  const asOfDate = localDateIso(new Date());
  const [bmrProfile, candidates, preferences] = await Promise.all([
    ctx.repo.getLatestBmrProfile(ctx.userId),
    loadCandidateDishes(ctx),
    loadUserPreferences(ctx, { asOfDate }),
  ]);

  const dailyTarget = bmrProfile?.targetKcal ?? 2000;
  const MEAL_SPLIT: Record<string, number> = { breakfast: 0.25, lunch: 0.40, dinner: 0.35 };
  const maxKcal = input.maxKcal ?? Math.round(dailyTarget * (MEAL_SPLIT[mealType] ?? 0.35));

  return handleRecipeRecommend(ctx, {
    mealType,
    maxKcal,
    candidates: [...candidates],
    preferences,
    recentDishSlugs: preferences.recentDishSlugs,
  });
}

// ── Helpers ──

function requireDate(value: Date | string | undefined): Date {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("now must be a valid date");
  }
  return date;
}

function localDateIso(date: Date): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-");
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function mealTypeForHour(hour: number): ProactiveMealType {
  if (hour < 10) return "breakfast";
  if (hour < 14) return "lunch";
  return "dinner";
}

function localizedMealType(mealType: ProactiveMealType, locale: Language): string {
  if (locale === "en") return mealType;
  const labels: Record<ProactiveMealType, string> = {
    breakfast: "早餐",
    lunch: "午餐",
    dinner: "晚餐",
  };
  return labels[mealType];
}

function isLaterSameDayMeal(candidateMealType: string, currentMealType: ProactiveMealType): boolean {
  if (!isProactiveMealType(candidateMealType)) return false;
  return PROACTIVE_MEAL_ORDER[candidateMealType] > PROACTIVE_MEAL_ORDER[currentMealType];
}

function isProactiveMealType(value: string): value is ProactiveMealType {
  return value === "breakfast" || value === "lunch" || value === "dinner";
}

function buildThawItems(ctx: ToolContext, entries: MealPlanEntryRow[]): ProactiveThawItem[] {
  const catalogBySlug = new Map(ctx.catalog.foods.map((food) => [food.slug, food]));
  const thawItems: ProactiveThawItem[] = [];

  for (const entry of entries) {
    const ingredients = entry.ingredientsJson
      .map((ingredient) => thawIngredientFor(ingredient, catalogBySlug))
      .filter((ingredient): ingredient is ProactiveThawIngredient => ingredient !== undefined);

    if (ingredients.length > 0) {
      thawItems.push({
        entryId: entry.id,
        planDate: entry.planDate,
        mealType: entry.mealType,
        dishName: entry.dishName,
        ingredients,
      });
    }
  }

  return thawItems;
}

function thawIngredientFor(
  ingredient: Record<string, unknown>,
  catalogBySlug: ReadonlyMap<string, { category?: string | null; name?: string }>,
): ProactiveThawIngredient | undefined {
  const slug = ingredient["slug"];
  if (typeof slug !== "string") return undefined;

  const food = catalogBySlug.get(slug);
  const category = food?.category?.toLowerCase();
  if (category === undefined || !THAW_CATEGORIES.has(category)) return undefined;

  const grams = ingredient["grams"];
  return {
    slug,
    category,
    ...(typeof grams === "number" && Number.isFinite(grams) ? { grams } : {}),
    ...(food?.name ? { name: food.name } : {}),
  };
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sum(values: number[]): number {
  return values.reduce((t, v) => t + v, 0);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
