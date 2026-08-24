import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  uniqueIndex,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  vector
} from "drizzle-orm/pg-core";

import { getEmbeddingDimensions } from "../embeddings/client.js";

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
const embeddingDimensions = getEmbeddingDimensions();

export const compass = pgSchema("compass_health");

export const users = compass.table("users", {
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

export const bmrProfiles = compass.table("bmr_profiles", {
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

export const dailyActivityPlans = compass.table("daily_activity_plans", {
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

export const dietLogs = compass.table("diet_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  logDate: date("log_date").notNull(),
  loggedAt: timestamp("logged_at", { withTimezone: true }).notNull().defaultNow(),
  mealType: text("meal_type").notNull(),
  description: text("description").notNull(),
  source: text("source").notNull().default("manual"),
  ingredientsJson: jsonb("ingredients_json").$type<Array<Record<string, unknown>>>().notNull().default(emptyArrayJson),
  seasoningsJson: jsonb("seasonings_json").$type<Array<Record<string, unknown>>>().notNull().default(emptyArrayJson),
  // ── M05 DietLogV2 metadata (nullable for legacy rows) ──
  idempotencyKey: text("idempotency_key"),
  estimateConfidence: doublePrecision("estimate_confidence"),
  uncertain: boolean("uncertain"),
  correctionOfId: uuid("correction_of_id"),
  supersededById: uuid("superseded_by_id"),
  journeyId: text("journey_id"),
  ...nutritionColumns(),
  ...timestamps()
}, (t) => [
  // Partial unique index (matches live DB): only non-null idempotency keys
  // participate, so legacy rows with NULL stay valid.
  uniqueIndex("diet_logs_user_idempotency_key_uidx")
    .on(t.userId, t.idempotencyKey)
    .where(sql`idempotency_key is not null`),
]);

export const waterLogs = compass.table("water_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  logDate: date("log_date").notNull(),
  loggedAt: timestamp("logged_at", { withTimezone: true }).notNull().defaultNow(),
  amountMl: integer("amount_ml").notNull(),
  source: text("source").notNull().default("manual"),
  ...timestamps()
});

export const exerciseLogs = compass.table("exercise_logs", {
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

export const physicalConditions = compass.table("physical_conditions", {
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

export const mealPlanEntries = compass.table("meal_plan_entries", {
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

export const foodItems = compass.table("food_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  nameZh: text("name_zh"),
  category: text("category"),
  executionBuckets: jsonb("execution_buckets").$type<string[]>().notNull().default(emptyArrayJson),
  roles: jsonb("roles").$type<string[]>().notNull().default(emptyArrayJson),
  weeklyFloor: integer("weekly_floor").notNull().default(0),
  allergenTags: jsonb("allergen_tags").$type<string[]>().notNull().default(emptyArrayJson),
  weightType: text("weight_type").notNull().default("raw"),
  frequencyHint: text("frequency_hint"),
  cookingDifficulty: text("cooking_difficulty"),
  availability: text("availability"),
  specialHandlingTags: jsonb("special_handling_tags").$type<string[]>().notNull().default(emptyArrayJson),
  source: text("source").notNull().default("csv"),
  embedding: vector("embedding", { dimensions: embeddingDimensions }),
  embeddingText: text("embedding_text"),
  embeddingModel: text("embedding_model"),
  ...nutritionColumns(),
  ...timestamps()
});

export const foodAliases = compass.table("food_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  alias: text("alias").notNull(),
  locale: text("locale"),
  ...timestamps()
}, (t) => [
  unique().on(t.slug, t.alias),
]);

export const seasonings = compass.table("seasonings", {
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

export const naturalUnits = compass.table("natural_units", {
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

export const cookingRecords = compass.table("cooking_records", {
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

export const userDishes = compass.table("user_dishes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  mealCategory: text("meal_category").notNull(),
  role: text("role").notNull().default("main"),
  sideKind: text("side_kind"),
  selfContained: boolean("self_contained").notNull().default(true),
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

export const mealCompositions = compass.table("meal_compositions", {
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

export const userSeasoningPreferences = compass.table("user_seasoning_preferences", {
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

export const memoryRecords = compass.table("memory_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(),
  content: text("content").notNull(),
  contentNorm: text("content_norm").notNull().default(""),
  sourceText: text("source_text"),
  confidence: doublePrecision("confidence").notNull().default(1),
  status: text("status").notNull().default("active"),
  supersededBy: uuid("superseded_by"),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true }),
  lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).defaultNow(),
  timesReferenced: integer("times_referenced").notNull().default(0),
  embedding: vector("embedding", { dimensions: embeddingDimensions }),
  embeddingModel: text("embedding_model"),
  ...timestamps()
}, (t) => [
  index("memory_records_user_status_idx").on(t.userId, t.status),
  index("memory_records_user_kind_subject_idx").on(t.userId, t.kind, t.subject),
  index("memory_records_content_norm_trgm_idx").using("gin", t.contentNorm.op("gin_trgm_ops")),
  index("memory_records_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

// ── M03 / P2: plan versions, facts, constraints, outbox, projection ─────────
// Design: docs/display-interface-plan.md §6 (DailyHealthStateV1). Facts are
// append-only; the daily projection is rebuildable and never a write target.

export const planVersions = compass.table("plan_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  scope: text("scope").notNull(), // diet | training_template | training_cycle | training_day | training_session
  status: text("status").notNull().default("draft"), // draft | active | superseded | archived
  parentVersionId: uuid("parent_version_id"),
  versionNumber: integer("version_number").notNull().default(1),
  contentJson: jsonb("content_json").$type<Record<string, unknown>>().notNull(),
  adjustmentReason: text("adjustment_reason"),
  previousVersionProblems: jsonb("previous_version_problems").$type<string[]>().default(sql`'[]'::jsonb`),
  validationQuestions: jsonb("validation_questions").$type<string[]>().default(sql`'[]'::jsonb`),
  createdByActor: text("created_by_actor").notNull().default("user"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  ...timestamps()
}, (t) => [
  index("plan_versions_user_scope_idx").on(t.userId, t.scope, t.status),
]);

/** Single active pointer per user+scope; plan changes swap this row atomically. */
export const activePlanAssignments = compass.table("active_plan_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  scope: text("scope").notNull(),
  planVersionId: uuid("plan_version_id").notNull()
    .references(() => planVersions.id, { onDelete: "cascade" }),
  ...timestamps()
}, (t) => [
  unique("active_plan_assignments_user_scope_key").on(t.userId, t.scope),
]);

export const healthObservationEvents = compass.table("health_observation_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  observedOn: date("observed_on").notNull(),
  kind: text("kind").notNull(), // sleep | fatigue | recovery | pain | weight | note
  valueJson: jsonb("value_json").$type<Record<string, unknown>>().notNull(),
  source: text("source").notNull().default("user"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  journeyId: text("journey_id"),
  ...timestamps()
}, (t) => [
  index("health_observation_events_user_day_idx").on(t.userId, t.observedOn, t.kind),
]);

export const healthConstraints = compass.table("health_constraints", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  constraintType: text("constraint_type").notNull(), // pain | equipment_unavailable | time_limited | medical
  severity: text("severity").notNull().default("warn"), // warn | block
  targetJson: jsonb("target_json").$type<Record<string, unknown>>().notNull(), // e.g. { movementPattern: "..." } or { exerciseSlug }
  reason: text("reason").notNull(),
  activeFrom: date("active_from").notNull(),
  activeTo: date("active_to"),
  liftedAt: timestamp("lifted_at", { withTimezone: true }),
  liftedByActor: text("lifted_by_actor"),
  sourceObservationId: uuid("source_observation_id"),
  ...timestamps()
}, (t) => [
  index("health_constraints_user_active_idx").on(t.userId, t.activeFrom),
]);

export const userDecisionEvents = compass.table("user_decision_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  decisionType: text("decision_type").notNull(), // accepted | modified | rejected | undone
  subjectJson: jsonb("subject_json").$type<Record<string, unknown>>().notNull(), // proposal/plan/log reference
  journeyId: text("journey_id"),
  ...timestamps()
});

export const outboxEvents = compass.table("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  aggregateType: text("aggregate_type").notNull(), // diet_log | observation | plan_version | ...
  aggregateId: text("aggregate_id").notNull(),
  eventType: text("type").notNull(),
  payloadJson: jsonb("payload_json").$type<Record<string, unknown>>(),
  status: text("status").notNull().default("pending"), // pending | done | dead_letter
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index("outbox_events_status_available_idx").on(t.status, t.availableAt),
]);

export const interactionEvents = compass.table("interaction_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  requestId: text("request_id"),
  journeyId: text("journey_id"),
  actor: text("actor").notNull().default("web"), // web | agent | pi_primary | pi_legacy | teacher | manager
  stage: text("stage").notNull(), // asr | intent | tool | api | validation | db | projection | ui
  stageCode: text("stage_code").notNull(), // ok | failed | rejected | timeout | unavailable | stale
  detailJson: jsonb("detail_json").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index("interaction_events_journey_idx").on(t.journeyId),
  index("interaction_events_stage_idx").on(t.stage, t.stageCode),
]);

export const projectionCheckpoints = compass.table("projection_checkpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectionName: text("projection_name").notNull(),
  checkpointKey: text("checkpoint_key").notNull(), // e.g. "daily-health-state:2026-08-24"
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  status: text("status").notNull().default("fresh"), // fresh | lagging | failed | rebuilding
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  unique("projection_checkpoints_name_key_key").on(t.projectionName, t.checkpointKey),
]);

export const dailyHealthStateProjection = compass.table("daily_health_state_projection", {
  userId: uuid("user_id").notNull(),
  stateDate: date("state_date").notNull(),
  revision: integer("revision").notNull().default(0),
  timezone: text("timezone").notNull().default("UTC"),
  stateJson: jsonb("state_json").$type<Record<string, unknown>>().notNull(),
  sourceEventCount: integer("source_event_count").notNull().default(0),
  projectionStatus: text("projection_status").notNull().default("fresh"),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  unique("daily_health_state_projection_user_date_key").on(t.userId, t.stateDate),
]);

// ── M06 / P4: structured training domain ────────────────────────────────────
// Plans are immutable versions (plan_versions); sessions/set logs are facts;
// coarse exercise_logs rows are later projected FROM sessions, never hand-fed.

export const exerciseDefinitions = compass.table("exercise_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  nameZh: text("name_zh").notNull(),
  nameEn: text("name_en"),
  aliases: jsonb("aliases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  movementPattern: text("movement_pattern").notNull(), // horizontal_push | vertical_pull | horizontal_pull | squat | hinge | single_leg | elbow_flexion | elbow_extension | lateral_raise | rear_delt | calf | core
  trainingPurpose: text("training_purpose").notNull().default("hypertrophy"),
  primaryMuscles: jsonb("primary_muscles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  secondaryMuscles: jsonb("secondary_muscles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  equipment: text("equipment"),
  stabilityDemand: text("stability_demand").notNull().default("medium"), // low | medium | high
  contraindicationTags: jsonb("contraindication_tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  regressions: jsonb("regressions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  progressions: jsonb("progressions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  ...timestamps()
});

/** Per-user exercise substitution graph (user may edit; seeded from defaults). */
export const exerciseSubstitutions = compass.table("exercise_substitutions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  fromExerciseSlug: text("from_exercise_slug").notNull(),
  toExerciseSlug: text("to_exercise_slug").notNull(),
  retainedNote: text("retained_note"),
  lostNote: text("lost_note"),
  ...timestamps()
}, (t) => [
  unique("exercise_substitutions_pair_key").on(t.userId, t.fromExerciseSlug, t.toExerciseSlug),
]);

export const trainingTemplates = compass.table("training_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  name: text("name").notNull(), // e.g. "三分化 A 日"
  dayRole: text("day_role").notNull(), // A | B | C | REST
  itemsJson: jsonb("items_json").$type<Array<Record<string, unknown>>>().notNull(),
  cyclePattern: jsonb("cycle_pattern").$type<string[]>(),
  sourceVersionId: uuid("source_version_id"),
  ...timestamps()
});

export const trainingSessions = compass.table("training_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  sessionDate: date("session_date").notNull(),
  planVersionId: uuid("plan_version_id"),
  status: text("status").notNull().default("planned"), // planned | in_progress | completed | interrupted | cancelled
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  notes: text("notes"),
  journeyId: text("journey_id"),
  ...timestamps()
}, (t) => [
  index("training_sessions_user_date_idx").on(t.userId, t.sessionDate),
]);

export const trainingSessionExercises = compass.table("training_session_exercises", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull()
    .references(() => trainingSessions.id, { onDelete: "cascade" }),
  exerciseSlug: text("exercise_slug").notNull(),
  orderIndex: integer("order_index").notNull().default(0),
  targetSets: integer("target_sets").notNull().default(3),
  targetRepRangeLow: integer("target_rep_range_low"),
  targetRepRangeHigh: integer("target_rep_range_high"),
  targetRirLow: doublePrecision("target_rir_low"),
  targetRirHigh: doublePrecision("target_rir_high"),
  /** When substituted: the original session-exercise this row replaces. */
  replacementForId: uuid("replacement_for_id"),
  replacedById: uuid("replaced_by_id"),
  status: text("status").notNull().default("pending"), // pending | done | skipped | replaced
  ...timestamps()
});

export const trainingSetLogs = compass.table("training_set_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionExerciseId: uuid("session_exercise_id").notNull()
    .references(() => trainingSessionExercises.id, { onDelete: "cascade" }),
  setNumber: integer("set_number").notNull(),
  loadValue: doublePrecision("load_value"),
  loadUnit: text("load_unit"), // kg | lb | bodyweight
  reps: integer("reps"),
  rir: doublePrecision("rir"),
  targetMuscleFeel: integer("target_muscle_feel"), // 1..5 subjective
  painJson: jsonb("pain_json").$type<Array<Record<string, unknown>>>().default(sql`'[]'::jsonb`),
  performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
  source: text("source").notNull().default("ui"),
  idempotencyKey: text("idempotency_key"),
  ...timestamps()
}, (t) => [
  unique("training_set_logs_exercise_set_key").on(t.sessionExerciseId, t.setNumber),
]);

export const trainingReflections = compass.table("training_reflections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: userId(),
  sessionId: uuid("session_id").notNull()
    .references(() => trainingSessions.id, { onDelete: "cascade" }),
  completedVsPlannedJson: jsonb("completed_vs_planned_json").$type<Record<string, unknown>>(),
  bestCueRefs: jsonb("best_cue_refs").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  unresolvedIssuesJson: jsonb("unresolved_issues_json").$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
  painSummaryJson: jsonb("pain_summary_json").$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
  proposedAdjustmentsJson: jsonb("proposed_adjustments_json").$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
  nextValidationQuestions: jsonb("next_validation_questions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  proposalPlanVersionId: uuid("proposal_plan_version_id"),
  userAcceptedAt: timestamp("user_accepted_at", { withTimezone: true }),
  ...timestamps()
});
