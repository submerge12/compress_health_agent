import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid
} from "drizzle-orm/pg-core";

const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

const nutritionColumns = () => ({
  caloriesKcal: doublePrecision("calories_kcal").notNull().default(0),
  proteinGrams: doublePrecision("protein_grams").notNull().default(0),
  carbsGrams: doublePrecision("carbs_grams").notNull().default(0),
  fatGrams: doublePrecision("fat_grams").notNull().default(0),
  fiberGrams: doublePrecision("fiber_grams").notNull().default(0),
  sugarGrams: doublePrecision("sugar_grams").notNull().default(0),
  sodiumMg: doublePrecision("sodium_mg").notNull().default(0),
  potassiumMg: doublePrecision("potassium_mg").notNull().default(0),
  calciumMg: doublePrecision("calcium_mg").notNull().default(0),
  ironMg: doublePrecision("iron_mg").notNull().default(0),
  magnesiumMg: doublePrecision("magnesium_mg").notNull().default(0),
  zincMg: doublePrecision("zinc_mg").notNull().default(0),
  vitaminAMcg: doublePrecision("vitamin_a_mcg").notNull().default(0),
  vitaminCMg: doublePrecision("vitamin_c_mg").notNull().default(0),
  vitaminDMcg: doublePrecision("vitamin_d_mcg").notNull().default(0),
  vitaminB12Mcg: doublePrecision("vitamin_b12_mcg").notNull().default(0),
  folateMcg: doublePrecision("folate_mcg").notNull().default(0),
  cholesterolMg: doublePrecision("cholesterol_mg").notNull().default(0)
});

const emptyArrayJson = sql`'[]'::jsonb`;

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: text("external_id").notNull().unique(),
  email: text("email").unique(),
  displayName: text("display_name"),
  locale: text("locale").notNull().default("en"),
  timezone: text("timezone").notNull().default("UTC"),
  ...timestamps()
});

const userId = () =>
  uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const bmrProfiles = pgTable("bmr_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  sex: text("sex").notNull(),
  ageYears: integer("age_years").notNull(),
  heightCm: doublePrecision("height_cm").notNull(),
  weightKg: doublePrecision("weight_kg").notNull(),
  activityLevel: text("activity_level").notNull(),
  goal: text("goal").notNull().default("maintain"),
  bmrKcal: doublePrecision("bmr_kcal").notNull(),
  tdeeKcal: doublePrecision("tdee_kcal").notNull(),
  targetKcal: doublePrecision("target_kcal").notNull(),
  proteinTargetGrams: doublePrecision("protein_target_grams").notNull().default(0),
  carbsTargetGrams: doublePrecision("carbs_target_grams").notNull().default(0),
  fatTargetGrams: doublePrecision("fat_target_grams").notNull().default(0),
  effectiveDate: date("effective_date").notNull(),
  ...timestamps()
});

export const dailyActivityPlans = pgTable("daily_activity_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  planDate: date("plan_date").notNull(),
  targetKcal: doublePrecision("target_kcal").notNull(),
  breakfastKcal: doublePrecision("breakfast_kcal").notNull().default(0),
  lunchKcal: doublePrecision("lunch_kcal").notNull().default(0),
  dinnerKcal: doublePrecision("dinner_kcal").notNull().default(0),
  snackKcal: doublePrecision("snack_kcal").notNull().default(0),
  waterTargetMl: integer("water_target_ml").notNull().default(2000),
  exerciseTargetMinutes: integer("exercise_target_minutes").notNull().default(0),
  ...timestamps()
});

export const dietLogs = pgTable("diet_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  logDate: date("log_date").notNull(),
  loggedAt: timestamp("logged_at", { withTimezone: true }).notNull().defaultNow(),
  mealType: text("meal_type").notNull(),
  description: text("description").notNull(),
  source: text("source").notNull().default("manual"),
  ingredientsJson: jsonb("ingredients_json").$type<Array<Record<string, unknown>>>().notNull().default(emptyArrayJson),
  seasoningsJson: jsonb("seasonings_json").$type<Array<Record<string, unknown>>>().notNull().default(emptyArrayJson),
  ...nutritionColumns(),
  ...timestamps()
});

export const waterLogs = pgTable("water_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  logDate: date("log_date").notNull(),
  loggedAt: timestamp("logged_at", { withTimezone: true }).notNull().defaultNow(),
  amountMl: integer("amount_ml").notNull(),
  source: text("source").notNull().default("manual"),
  ...timestamps()
});

export const exerciseLogs = pgTable("exercise_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  logDate: date("log_date").notNull(),
  loggedAt: timestamp("logged_at", { withTimezone: true }).notNull().defaultNow(),
  activityType: text("activity_type").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  caloriesBurnedKcal: doublePrecision("calories_burned_kcal").notNull().default(0),
  intensity: text("intensity"),
  notes: text("notes"),
  ...timestamps()
});

export const physicalConditions = pgTable("physical_conditions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  measuredAt: timestamp("measured_at", { withTimezone: true }).notNull().defaultNow(),
  weightKg: doublePrecision("weight_kg"),
  bodyFatPercent: doublePrecision("body_fat_percent"),
  waistCm: doublePrecision("waist_cm"),
  restingHeartRate: integer("resting_heart_rate"),
  sleepHours: doublePrecision("sleep_hours"),
  notes: text("notes"),
  ...timestamps()
});

export const mealPlanEntries = pgTable("meal_plan_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  planDate: date("plan_date").notNull(),
  mealType: text("meal_type").notNull(),
  dishName: text("dish_name").notNull(),
  recipeSlug: text("recipe_slug"),
  status: text("status").notNull().default("planned"),
  ingredientsJson: jsonb("ingredients_json").$type<Array<Record<string, unknown>>>().notNull().default(emptyArrayJson),
  seasoningsJson: jsonb("seasonings_json").$type<Array<Record<string, unknown>>>().notNull().default(emptyArrayJson),
  ...nutritionColumns(),
  ...timestamps()
});

export const foodItems = pgTable("food_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  nameZh: text("name_zh"),
  category: text("category"),
  executionBuckets: jsonb("execution_buckets").$type<string[]>().notNull().default(emptyArrayJson),
  roles: jsonb("roles").$type<string[]>().notNull().default(emptyArrayJson),
  weeklyFloor: integer("weekly_floor").notNull().default(0),
  source: text("source").notNull().default("csv"),
  ...nutritionColumns(),
  ...timestamps()
});

export const foodAliases = pgTable("food_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  alias: text("alias").notNull(),
  locale: text("locale"),
  ...timestamps()
}, (t) => [
  unique().on(t.slug, t.alias),
]);

export const seasonings = pgTable("seasonings", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  nameZh: text("name_zh"),
  servingUnit: text("serving_unit").notNull().default("g"),
  servingGrams: doublePrecision("serving_grams").notNull().default(1),
  sodiumMgPerServing: doublePrecision("sodium_mg_per_serving").notNull().default(0),
  sodiumMgPer100g: doublePrecision("sodium_mg_per_100g").notNull().default(0),
  caloriesKcalPer100g: doublePrecision("calories_kcal_per_100g").notNull().default(0),
  sugarGramsPer100g: doublePrecision("sugar_grams_per_100g").notNull().default(0),
  notes: text("notes"),
  ...timestamps()
});

export const naturalUnits = pgTable("natural_units", {
  id: uuid("id").primaryKey().defaultRandom(),
  foodItemId: uuid("food_item_id").references(() => foodItems.id, { onDelete: "cascade" }),
  foodSlug: text("food_slug").notNull(),
  unitName: text("unit_name").notNull(),
  unitNameZh: text("unit_name_zh"),
  grams: doublePrecision("grams").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  ...timestamps()
}, (t) => [
  unique().on(t.foodSlug, t.unitName),
]);

export const cookingRecords = pgTable("cooking_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  dishName: text("dish_name").notNull(),
  description: text("description"),
  ingredientsJson: jsonb("ingredients_json").$type<Array<Record<string, unknown>>>().notNull().default(emptyArrayJson),
  seasoningsJson: jsonb("seasonings_json").$type<Array<Record<string, unknown>>>().notNull().default(emptyArrayJson),
  timesCooked: integer("times_cooked").notNull().default(0),
  lastCookedAt: timestamp("last_cooked_at", { withTimezone: true }),
  rating: integer("rating"),
  notes: text("notes"),
  ...nutritionColumns(),
  ...timestamps()
});

export const userDishes = pgTable("user_dishes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  mealCategory: text("meal_category").notNull(),
  ingredientsJson: jsonb("ingredients_json").$type<Array<Record<string, unknown>>>().notNull().default(emptyArrayJson),
  seasoningsJson: jsonb("seasonings_json").$type<Array<Record<string, unknown>>>().notNull().default(emptyArrayJson),
  method: text("method"),
  caloriesKcal: doublePrecision("calories_kcal").notNull().default(0),
  proteinGrams: doublePrecision("protein_g").notNull().default(0),
  carbsGrams: doublePrecision("carbs_g").notNull().default(0),
  fatGrams: doublePrecision("fat_g").notNull().default(0),
  sodiumMg: doublePrecision("sodium_mg").notNull().default(0),
  source: text("source").notNull().default("user"),
  ...timestamps()
}, (t) => [
  unique().on(t.userId, t.slug),
]);

export const mealCompositions = pgTable("meal_compositions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  mealPlanEntryId: uuid("meal_plan_entry_id").references(() => mealPlanEntries.id, { onDelete: "cascade" }),
  dietLogId: uuid("diet_log_id").references(() => dietLogs.id, { onDelete: "cascade" }),
  foodItemId: uuid("food_item_id").references(() => foodItems.id, { onDelete: "set null" }),
  cookingRecordId: uuid("cooking_record_id").references(() => cookingRecords.id, { onDelete: "set null" }),
  componentType: text("component_type").notNull().default("food"),
  componentName: text("component_name").notNull(),
  quantityGrams: doublePrecision("quantity_grams").notNull().default(0),
  unitLabel: text("unit_label"),
  ...nutritionColumns(),
  ...timestamps()
});

export const userSeasoningPreferences = pgTable("user_seasoning_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  seasoningId: uuid("seasoning_id")
    .notNull()
    .references(() => seasonings.id, { onDelete: "cascade" }),
  preference: text("preference").notNull().default("neutral"),
  maxGramsPerMeal: doublePrecision("max_grams_per_meal"),
  avoid: boolean("avoid").notNull().default(false),
  notes: text("notes"),
  ...timestamps()
});

export const memoryRecords = pgTable("memory_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(),
  content: text("content").notNull(),
  sourceText: text("source_text"),
  confidence: doublePrecision("confidence").notNull().default(1),
  status: text("status").notNull().default("active"),
  supersededBy: uuid("superseded_by"),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true }),
  lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).defaultNow(),
  timesReferenced: integer("times_referenced").notNull().default(0),
  ...timestamps()
}, (t) => [
  index("memory_records_user_status_idx").on(t.userId, t.status),
  index("memory_records_user_kind_subject_idx").on(t.userId, t.kind, t.subject),
]);
