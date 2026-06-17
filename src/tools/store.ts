import type { NutritionEntry } from "../engine/types.js";

export type ExerciseType = "running" | "walking" | "cycling" | "swimming" | "strength";

export interface NutrientSnapshot {
  kcal: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  sodiumMg: number;
  micronutrients: Record<string, number>;
}

export interface DietLog extends NutrientSnapshot {
  id: string;
  date: string;
  mealType: string;
  description: string;
  items: NutritionEntry[];
  createdAt: string;
}

export type DietLogInsert = Omit<DietLog, "id" | "createdAt">;

export interface WaterLog {
  id: string;
  date: string;
  description: string;
  amountMl: number;
  createdAt: string;
}

export type WaterLogInsert = Omit<WaterLog, "id" | "createdAt">;

export interface ExerciseLog {
  id: string;
  date: string;
  description: string;
  type: ExerciseType;
  durationMinutes: number;
  kcalBurned: number;
  createdAt: string;
}

export type ExerciseLogInsert = Omit<ExerciseLog, "id" | "createdAt">;

export interface PhysicalCondition {
  id: string;
  date: string;
  description: string;
  weightKg: number;
  bpSystolic?: number;
  bpDiastolic?: number;
  createdAt: string;
}

export type PhysicalConditionInsert = Omit<PhysicalCondition, "id" | "createdAt">;

export interface MealPlanEntry extends NutrientSnapshot {
  id: string;
  date: string;
  mealType: string;
  description: string;
  createdAt: string;
}

export type MealPlanEntryInsert = Omit<MealPlanEntry, "id" | "createdAt">;

export interface HealthStore {
  dietLogs: DietLog[];
  waterLogs: WaterLog[];
  exerciseLogs: ExerciseLog[];
  physicalConditions: PhysicalCondition[];
  mealPlanEntries: MealPlanEntry[];
}

export interface HealthRepository {
  insertDietLog(input: DietLogInsert): DietLog;
  listDietLogs(date?: string): DietLog[];
  insertWaterLog(input: WaterLogInsert): WaterLog;
  listWaterLogs(date?: string): WaterLog[];
  insertExerciseLog(input: ExerciseLogInsert): ExerciseLog;
  listExerciseLogs(date?: string): ExerciseLog[];
  insertPhysicalCondition(input: PhysicalConditionInsert): PhysicalCondition;
  listPhysicalConditions(date?: string): PhysicalCondition[];
  insertMealPlanEntry(input: MealPlanEntryInsert): MealPlanEntry;
  listMealPlanEntries(date?: string): MealPlanEntry[];
}

const CREATED_AT = new Date(0).toISOString();

export function createInMemoryHealthRepository(initial?: Partial<HealthStore>): HealthRepository {
  const store = createStore(initial);
  const counters = createCounters(store);
  return {
    insertDietLog: (input) => pushDietLog(store, counters, input),
    listDietLogs: (date) => store.dietLogs.filter(matchesDate(date)).map(cloneDietLog),
    insertWaterLog: (input) => pushWaterLog(store, counters, input),
    listWaterLogs: (date) => store.waterLogs.filter(matchesDate(date)).map(cloneWaterLog),
    insertExerciseLog: (input) => pushExerciseLog(store, counters, input),
    listExerciseLogs: (date) => store.exerciseLogs.filter(matchesDate(date)).map(cloneExerciseLog),
    insertPhysicalCondition: (input) => pushPhysicalCondition(store, counters, input),
    listPhysicalConditions: (date) =>
      store.physicalConditions.filter(matchesDate(date)).map(clonePhysicalCondition),
    insertMealPlanEntry: (input) => pushMealPlanEntry(store, counters, input),
    listMealPlanEntries: (date) =>
      store.mealPlanEntries.filter(matchesDate(date)).map(cloneMealPlanEntry),
  };
}

function createStore(initial: Partial<HealthStore> = {}): HealthStore {
  return {
    dietLogs: (initial.dietLogs ?? []).map(cloneDietLog),
    waterLogs: (initial.waterLogs ?? []).map(cloneWaterLog),
    exerciseLogs: (initial.exerciseLogs ?? []).map(cloneExerciseLog),
    physicalConditions: (initial.physicalConditions ?? []).map(clonePhysicalCondition),
    mealPlanEntries: (initial.mealPlanEntries ?? []).map(cloneMealPlanEntry),
  };
}

function createCounters(store: HealthStore): Record<string, number> {
  return {
    diet: store.dietLogs.length,
    water: store.waterLogs.length,
    exercise: store.exerciseLogs.length,
    condition: store.physicalConditions.length,
    mealPlan: store.mealPlanEntries.length,
  };
}

function pushDietLog(store: HealthStore, counters: Record<string, number>, input: DietLogInsert): DietLog {
  const row = cloneDietLog({ ...input, id: nextId(counters, "diet"), createdAt: CREATED_AT });
  store.dietLogs.push(row);
  return cloneDietLog(row);
}

function pushWaterLog(store: HealthStore, counters: Record<string, number>, input: WaterLogInsert): WaterLog {
  const row = cloneWaterLog({ ...input, id: nextId(counters, "water"), createdAt: CREATED_AT });
  store.waterLogs.push(row);
  return cloneWaterLog(row);
}

function pushExerciseLog(
  store: HealthStore,
  counters: Record<string, number>,
  input: ExerciseLogInsert,
): ExerciseLog {
  const row = cloneExerciseLog({ ...input, id: nextId(counters, "exercise"), createdAt: CREATED_AT });
  store.exerciseLogs.push(row);
  return cloneExerciseLog(row);
}

function pushPhysicalCondition(
  store: HealthStore,
  counters: Record<string, number>,
  input: PhysicalConditionInsert,
): PhysicalCondition {
  const row = clonePhysicalCondition({ ...input, id: nextId(counters, "condition"), createdAt: CREATED_AT });
  store.physicalConditions.push(row);
  return clonePhysicalCondition(row);
}

function pushMealPlanEntry(
  store: HealthStore,
  counters: Record<string, number>,
  input: MealPlanEntryInsert,
): MealPlanEntry {
  const row = cloneMealPlanEntry({ ...input, id: nextId(counters, "mealPlan"), createdAt: CREATED_AT });
  store.mealPlanEntries.push(row);
  return cloneMealPlanEntry(row);
}

function nextId(counters: Record<string, number>, prefix: string): string {
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  return `${prefix}_${counters[prefix]}`;
}

function matchesDate<T extends { date: string }>(date: string | undefined): (row: T) => boolean {
  return (row) => date === undefined || row.date === date;
}

function cloneDietLog(row: DietLog): DietLog {
  return { ...row, items: row.items.map((item) => ({ ...item })), micronutrients: { ...row.micronutrients } };
}

function cloneWaterLog(row: WaterLog): WaterLog {
  return { ...row };
}

function cloneExerciseLog(row: ExerciseLog): ExerciseLog {
  return { ...row };
}

function clonePhysicalCondition(row: PhysicalCondition): PhysicalCondition {
  return { ...row };
}

function cloneMealPlanEntry(row: MealPlanEntry): MealPlanEntry {
  return { ...row, micronutrients: { ...row.micronutrients } };
}
