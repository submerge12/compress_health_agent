# Phase 2: Engine Corrections & Database Repository

This document records the work done in Phase 2 on 2026-06-17, covering the calorie engine rewrite, meal planner fix, PostgreSQL repository layer, and meal catalog loader.

---

## 1. Pre-existing State (from Codex)

A previous Codex session had scaffolded:

- **5 engine modules**: calorie, nutrition, natural-units, recipe-engine, meal-planner, pattern-detector
- **11 tool modules**: log-meal, log-water, log-exercise, log-weight, nutrition-estimate, daily-summary, weekly-report, recipe-recommend, generate-meal-plan, meal-checkin, update-cooking-record
- **In-memory store**: `store.ts` with `HealthRepository` interface and `createInMemoryHealthRepository()`
- **Agent profile**: `agent.ts` with tool registrations and bilingual system prompt
- **i18n**: `i18n.ts` with zh/en template rendering
- **85 passing tests** (all unit tests against in-memory data)

### Critical Gaps Identified

| Issue | Impact |
|---|---|
| All tools used in-memory store only | No data persistence — useless in production |
| Calorie engine oversimplified | Only 3 goals, wrong activity multipliers, percentage-based macros instead of per-kg |
| Meal split wrong | 25/37.5/37.5 instead of agreed 25/40/35 |
| No food catalog from DB | `MealCatalog` interface existed but nothing populated it from PostgreSQL |
| Macro targets in memory wrong | Fat 56g / Carbs 177g (from percentage split) instead of correct 42g / 208g |

---

## 2. Calorie Engine Rewrite

**Files changed:** `src/engine/types.ts`, `src/engine/calorie.ts`, `tests/engine/calorie.test.ts`

### 2.1 Type Changes

```
Before:
  ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active"
  Goal = "fat_loss" | "maintain" | "muscle_gain"

After:
  ActivityLevel = "sedentary" | "lightly_active" | "moderately_active" | "strength_training"
  Goal = "improve_health" | "body_recomp" | "fat_loss_slow" | "fat_loss_moderate" | "fat_loss_fast"
        | "muscle_gain_slow" | "muscle_gain_moderate" | "muscle_gain_fast"
```

New types added: `GoalFamily`, `CalorieStatus`, `MacroStatus`, `MacroRanges`, `MacroStatuses`.

`CaloriePlan` expanded from 4 fields to 9: now includes `calorieStatus`, `isExerciser`, `ranges`, `statuses`, and `warnings`.

### 2.2 Algorithm — Python 9-Step Port

The calorie engine was rewritten to exactly match the Python backend (`backend/services/calorie.py`):

| Step | What It Does |
|---|---|
| 1 | BMR via Mifflin-St Jeor; TDEE = BMR × activity multiplier |
| 2 | Raw target = TDEE × goal factor; clamp into [lower, upper] bounds. Lower wins on conflict. |
| 3 | Protein per-kg from band table by (goal_family, is_exerciser), with age adjustment (+0.1 at 35+, +0.2 at 50+) |
| 4 | Fat = max(sex-based floor, 20% of kcal / 9). Soft max = 40% / 9. |
| 5 | Carbs = remainder of calories after protein and fat |
| 6 | Carb range from per-kg band by goal; female floor = 120g |
| 7 | Backtrack: if carbs > max → excess to fat; if carbs < min → pull from fat then protein |
| 8 | Emit status labels: protein (insufficient/appropriate/slightly_high/excessive), fat (below_min/appropriate/high), carbs (below_range/appropriate/above_range) |
| 9 | Assemble plan with warnings |

### 2.3 Activity Multipliers

| Level | Python | Old TS | New TS |
|---|---|---|---|
| sedentary | 1.10 | 1.20 | **1.10** |
| lightly_active | 1.20 | 1.375 ("light") | **1.20** |
| moderately_active | 1.35 | 1.55 ("moderate") | **1.35** |
| strength_training | 1.50 | 1.725 ("active") | **1.50** |

### 2.4 Goal Calorie Factors

| Goal | Factor | Bounds |
|---|---|---|
| improve_health | 1.00 | none |
| body_recomp | 0.90 | [BMR+100, TDEE-300] |
| fat_loss_slow | 0.90 | [BMR+100, none] |
| fat_loss_moderate | 0.85 | [BMR+100, TDEE-500] |
| fat_loss_fast | 0.80 | [BMR+100, TDEE-700] |
| muscle_gain_slow | 1.10 | [TDEE+200, TDEE+300] |
| muscle_gain_moderate | 1.15 | [TDEE+300, TDEE+500] |
| muscle_gain_fast | 1.20 | [TDEE+400, TDEE+700] |

### 2.5 Protein Bands (per kg body weight)

| Goal Family | Exerciser | Lower | Target | Upper |
|---|---|---|---|---|
| improve_health | No | 0.8 | 1.2 | 1.5 |
| improve_health | Yes | 1.2 | 1.6 | 1.9 |
| fat_loss | No | 1.4 | 2.0 | 2.4 |
| fat_loss | Yes | 1.8 | 2.4 | 2.8 |
| body_recomp | No | 1.2 | 1.8 | 2.1 |
| body_recomp | Yes | 1.6 | 2.2 | 2.5 |
| muscle_gain | No | 1.4 | 2.0 | 2.3 |
| muscle_gain | Yes | 1.4 | 2.0 | 2.3 |

### 2.6 Verified Against User's Profile

| Metric | Expected | Actual |
|---|---|---|
| BMR | 1671 | 1671 ✓ |
| TDEE | 2006 | 2006 ✓ |
| Target kcal | 1771 | 1771 ✓ |
| Calorie status | lower_overrides_upper | lower_overrides_upper ✓ |
| Protein | 140g (2.0 g/kg) | 140g ✓ |
| Fat | 42g (0.6 g/kg floor) | 42g ✓ |
| Carbs | 208g (remainder) | 208.3g ✓ |

---

## 3. Meal Planner Split Fix

**File changed:** `src/engine/meal-planner.ts`

```
Before: { breakfast: 0.25, lunch: 0.375, dinner: 0.375 }
After:  { breakfast: 0.25, lunch: 0.40,  dinner: 0.35  }
```

Dinner uses greedy remainder logic (`dailyTarget - usedKcal`), so the split only directly affects breakfast and lunch targets. All existing meal planner tests (4 tests) continued to pass without modification.

---

## 4. PostgreSQL Repository

**File created:** `src/db/repository.ts`

Implements a full CRUD layer using Drizzle ORM, replacing the in-memory `HealthRepository` from `store.ts`.

### 4.1 API Surface

```typescript
const repo = createRepository(db);

// Users
repo.findOrCreateUser(externalId, defaults?)  → UserRow
repo.getUser(userId)                           → UserRow | undefined

// BMR Profiles
repo.upsertBmrProfile(userId, data)            → BmrProfileRow
repo.getLatestBmrProfile(userId)               → BmrProfileRow | undefined

// Diet Logs
repo.insertDietLog(data)                       → DietLogRow
repo.listDietLogs(userId, date?)               → DietLogRow[]
repo.listDietLogsRange(userId, start, end)     → DietLogRow[]

// Water Logs
repo.insertWaterLog(userId, date, amountMl)    → WaterLogRow
repo.listWaterLogs(userId, date?)              → WaterLogRow[]

// Exercise Logs
repo.insertExerciseLog(data)                   → ExerciseLogRow
repo.listExerciseLogs(userId, date?)           → ExerciseLogRow[]

// Weight / Physical Conditions
repo.insertWeightLog(userId, data)             → WeightLogRow
repo.listWeightLogs(userId, limit?)            → WeightLogRow[]

// Meal Plan Entries
repo.insertMealPlanEntry(data)                 → MealPlanEntryRow
repo.listMealPlanEntries(userId, date?)        → MealPlanEntryRow[]
repo.updateMealPlanStatus(entryId, status)     → void

// Cooking Records
repo.upsertCookingRecord(userId, dishName, data) → void
```

### 4.2 Design Decisions

- **No separate interface**: The repository is returned from `createRepository(db)` as a plain object. The in-memory `HealthRepository` interface from `store.ts` is preserved for unit tests; the DB repository is used for production.
- **Upsert for BMR profiles**: Always updates the latest profile rather than creating a new row per change. Historical tracking can be added later if needed.
- **Cooking records auto-increment `timesCooked`**: Each upsert bumps the counter and updates `lastCookedAt`.
- **JSON columns typed as `Record<string, unknown>[]`**: Matches Drizzle's JSONB type expectations.

---

## 5. Meal Catalog Loader

**File created:** `src/db/catalog.ts`

Loads the `MealCatalog` interface (used by `nutrition-estimate.ts`) from the PostgreSQL database.

```typescript
const catalog = await loadMealCatalog(db);
// catalog.foods: FoodCatalogRecord[]  — 1,521 items with kcal, protein, carbs, fat, sodium per 100g
// catalog.naturalUnits: NaturalUnitRecord[] — 35 unit mappings with zh aliases

const seasonings = await loadSeasoningRecords(db);
// 20 seasoning records with sodium_mg_per_100g and serving sizes
```

Food records include Chinese name aliases so the nutrition estimator can match both `"鸡胸脯肉"` and `"Chicken breast"`.

---

## 6. Integration Tests

**File created:** `tests/db/integration.test.ts`

10 tests that run against the live PostgreSQL database (skipped automatically if DB is unavailable):

| Test | Verifies |
|---|---|
| Creates and retrieves user | `findOrCreateUser` + `getUser` |
| Idempotent user creation | Same `externalId` returns same row |
| BMR profile with calorie plan | `upsertBmrProfile` stores 1771 kcal / 140g protein |
| Diet log insert + query | `insertDietLog` + `listDietLogs` with Chinese dish name |
| Water log | `insertWaterLog` + `listWaterLogs` |
| Exercise log | `insertExerciseLog` with activity type and duration |
| Weight log | `insertWeightLog` with morning weigh-in |
| Meal catalog loading | 1,521+ foods, 35 natural units, chicken breast = 118 kcal |
| Seasoning records | 20 seasonings, light soy sauce = 5,757 mg Na/100g |
| Meal plan CRUD | Insert → update status to "followed" → verify |

Tests clean up after themselves by deleting all rows for the test user.

---

## 7. Memory Correction

Updated `user_profile.md` to reflect the correct macro targets from the Python-matched algorithm:

```
Before: Protein 140g | Fat 56g  | Carbs 177g  (percentage split)
After:  Protein 140g | Fat 42g  | Carbs 208g  (per-kg protein, remainder carbs)
```

Added calorie status note: `lower_overrides_upper` — the BMR+100 safety floor (1771) exceeds the goal cap TDEE-500 (1506), meaning the deficit is limited by the safety bound.

---

## 8. Test Summary

```
Before Phase 2:  85 tests, 14 files
After Phase 2:  107 tests, 15 files  (+22 tests, +1 file)
All passing, 0 failures.
```

| Category | Tests |
|---|---|
| Engine: calorie (rewritten) | 12 |
| Engine: nutrition, natural-units, recipe, meal-planner, pattern-detector | 41 |
| Tools: unit tests (in-memory) | 34 |
| Agent + i18n + index | 10 |
| DB: integration (live PostgreSQL) | 10 |

---

## 9. Files Changed / Created

| File | Action | Lines |
|---|---|---|
| `src/engine/types.ts` | Modified | ActivityLevel, Goal, CaloriePlan expanded |
| `src/engine/calorie.ts` | Rewritten | 9-step Python algorithm port |
| `src/engine/meal-planner.ts` | Modified | Split 25/40/35 |
| `src/db/repository.ts` | Created | Full CRUD repository via Drizzle ORM |
| `src/db/catalog.ts` | Created | MealCatalog + seasoning loader from DB |
| `tests/engine/calorie.test.ts` | Rewritten | 12 tests for new API |
| `tests/db/integration.test.ts` | Created | 10 live DB tests |
