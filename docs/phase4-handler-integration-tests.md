# Phase 4: Handler Integration Tests, Profile Handler & Pi-Harness Wiring

This document records the work done in Phase 4 on 2026-06-17, covering the `set_profile` handler, end-to-end handler integration tests against live PostgreSQL, full pipeline verification, and pi-harness agent profile integration.

---

## 1. Problem

Phase 3 created 11 async handlers (`src/tools/handlers.ts`) that bridge tool logic to the DB repository, but they had no integration tests. Additionally, `handleDailySummary` relied on a BMR profile existing in the database to return real calorie/macro targets — without one, it fell back to generic defaults (2000/60/250/65). There was no handler for the agent to set the user's physical profile.

---

## 2. Set Profile Handler

**File modified:** `src/tools/handlers.ts`

Added `handleSetProfile` — the 12th handler — which accepts the user's physical stats, computes the full calorie plan using the 9-step engine, and upserts the BMR profile in the database.

### Input

```typescript
interface SetProfileInput {
  sex: "male" | "female";
  ageYears: number;
  heightCm: number;
  weightKg: number;
  activityLevel: "sedentary" | "lightly_active" | "moderately_active" | "strength_training";
  goal: string;  // e.g. "fat_loss_moderate"
}
```

### What It Does

1. Builds a `CalorieProfile` from input
2. Calls `calculateCaloriePlan()` (the 9-step engine from Phase 2)
3. Upserts the BMR profile row with computed targets (BMR, TDEE, target kcal, protein/carbs/fat)
4. Returns both the DB row and the full `CaloriePlan` (with ranges, statuses, warnings)

### Why It Matters

Once the profile is set, `handleDailySummary` and `handleWeeklyReport` automatically use the real targets instead of generic fallbacks. The agent calls `set_profile` once during onboarding; all subsequent queries use the stored values.

### Agent Registration

Added to `agent.ts` as a write tool:
```
{ name: "set_profile", accessLevel: "write", description: "Set or update the user's physical profile and compute calorie/macro targets." }
```

Registered in `src/index.ts` tool registry. Total tools: **12** (4 read-only, 8 write).

---

## 3. Handler Integration Tests

**File created:** `tests/handlers/integration.test.ts`

12 tests that exercise the full pipeline: `initToolContext` → handler → DB repository → verify result. All tests run against the live PostgreSQL database and skip automatically if the DB is unavailable.

### Test Flow

The tests run in order, building on each other's data within a single date (`2026-06-17`):

| # | Test | Handler | Verifies |
|---|---|---|---|
| 1 | Set profile | `handleSetProfile` | BMR=1671, TDEE=2006, target=1771 kcal, protein=140g, fat=42g |
| 2 | Nutrition estimate | `handleNutritionEstimate` | Chicken breast 200g → >200 kcal, >30g protein, read-only |
| 3 | Log meal | `handleLogMeal` | Chicken breast + brown rice → parsed, estimated, stored in DB |
| 4 | Log water (ml) | `handleLogWater` | "300ml水" → 300ml stored |
| 5 | Log water (cups) | `handleLogWater` | "两杯水" → 500ml stored |
| 6 | Log exercise | `handleLogExercise` | "走路30分钟" → walking, 30min, 120 kcal burned |
| 7 | Log weight | `handleLogWeight` | "早上称重 69.5kg" → 69.5kg stored |
| 8 | Cooking record | `handleUpdateCookingRecord` | Parsed chicken_breast, stir_fry, soy sauce + ginger |
| 9 | Daily summary | `handleDailySummary` | Aggregates all above: real targets (1771 kcal), 1 meal, 800ml water, 120 kcal exercise |
| 10 | Meal checkin | `handleMealCheckin` | Insert planned dinner → check in as "followed" → diet log created, status updated |
| 11 | invokeTool dispatch | `invokeTool` | daily_summary via registry → mealCount=2 (lunch + checkin dinner) |
| 12 | Unknown tool error | `invokeTool` | Throws "Unknown tool" for nonexistent tool |

### Cleanup

`afterAll` deletes all rows created by the test user across all tables (diet_logs, water_logs, exercise_logs, physical_conditions, meal_plan_entries, cooking_records, bmr_profiles, users), then closes both the test pool and the ToolContext connection.

### Key Assertions

- **Profile targets flow to daily summary**: After `handleSetProfile` sets 1771/140/42/208, `handleDailySummary` reads those targets from the DB and computes correct remaining values.
- **Bilingual parsing**: Chinese descriptions like "走路30分钟" and "两杯水" are correctly parsed.
- **Meal checkin creates diet log**: When a planned meal is checked in as "followed", a diet log row is created with the planned nutrition and `source: "planned"`.
- **invokeTool registry**: The `invokeTool()` dispatch function correctly routes tool calls to handlers and reflects accumulated state (mealCount=2 after lunch log + dinner checkin).

---

## 4. Test Summary

```
Before Phase 4:  110 tests, 15 files (100 unit + 10 integration)
After Phase 4:   122 tests, 16 files (100 unit + 22 integration)
All passing, 0 failures.
```

| Category | Tests |
|---|---|
| Engine (calorie, nutrition, natural-units, recipe, meal-planner, pattern-detector) | 53 |
| Tools (unit tests, in-memory store) | 34 |
| Agent profile + i18n | 8 |
| Entry point + registry | 5 |
| DB integration (repository + catalog) | 10 |
| Handler integration (end-to-end) | 12 |

---

## 5. Files Changed / Created

| File | Action | Purpose |
|---|---|---|
| `src/tools/handlers.ts` | Modified | Added `handleSetProfile` with calorie engine integration |
| `src/agent.ts` | Modified | Registered `set_profile` as write tool (12 total) |
| `src/index.ts` | Modified | Added `set_profile` to tool registry |
| `tests/agent.test.ts` | Modified | Updated expected write tool list |
| `tests/handlers/integration.test.ts` | Created | 12 end-to-end tests through handler → DB pipeline |

---

## 6. Full Pipeline Verified

The following data flow has been verified end-to-end against live PostgreSQL:

```
User message (Chinese/English)
  → initToolContext (DB pool, user creation, catalog loading)
    → handleSetProfile (calorie engine → BMR profile in DB)
    → handleLogMeal (parse food → estimate nutrition → diet_logs)
    → handleLogWater (parse amount → water_logs)
    → handleLogExercise (parse activity → exercise_logs)
    → handleLogWeight (parse kg → physical_conditions)
    → handleUpdateCookingRecord (parse method/seasoning → cooking_records)
    → handleDailySummary (aggregate from DB, real targets from BMR profile)
    → handleMealCheckin (update plan status, create diet log)
    → invokeTool (registry dispatch)
  → ctx.close() (pool shutdown)
```

All 12 handlers are tested. All 22 integration tests pass.

---

## 7. Pi-Harness Agent Profile Integration

### 7.1 Architecture Decision

The compass-health agent lives in its own project (`G:\compass-health-agent`) and plugs into pi-harness (`G:\pi-harness`) without modifying the harness architecture. The integration follows the same pattern as the built-in coding/research/data-analysis agents:

- **Agent business logic**: stays in `compass-health-agent` (handlers, engine, DB)
- **Profile glue**: lives in `pi-harness/src/agents/profiles/compass-health/` (thin adapter)
- **Dependency**: pi-harness imports compass-health-agent via `file:../compass-health-agent`

### 7.2 Build Setup

compass-health-agent was given a build step to emit JavaScript for consumption by pi-harness:

- **`tsconfig.build.json`** — extends base tsconfig, emits to `dist/` with declarations and source maps
- **`package.json`** — added `"main"`, `"exports"` (4 entry points), and `"build"` script
- **`dist/`** — compiled JS + `.d.ts` + source maps for all `src/` modules

### 7.3 Profile Files Created

| File | Purpose |
|---|---|
| `pi-harness/src/agents/profiles/compass-health/prompt.ts` | Bilingual system prompt — agent identity, hard rules, workflow steps |
| `pi-harness/src/agents/profiles/compass-health/tools.ts` | 10 tool registrations with TypeBox parameter schemas + execute closures |
| `pi-harness/src/agents/profiles/compass-health/profile.ts` | AgentProfile with install hook for DB lifecycle |

### 7.4 Tool Registrations

Each tool is an `AgentTool` with a TypeBox JSON schema for parameters and an `execute()` function that delegates to the corresponding handler:

| Tool | Access Level | Parameters |
|---|---|---|
| `set_profile` | write | sex, ageYears, heightCm, weightKg, activityLevel, goal |
| `log_meal` | write | date, mealType, description |
| `log_water` | write | date, description |
| `log_exercise` | write | date, description |
| `log_weight` | write | date, description |
| `meal_checkin` | write | date, mealType, status, actualDescription? |
| `update_cooking_record` | write | note, recordedAt? |
| `nutrition_estimate` | read-only | description |
| `daily_summary` | read-only | date |
| `weekly_report` | read-only | endDate, sodiumLimitMg? |

### 7.5 Install Hook & Lifecycle

```typescript
install: async () => {
  const ctx = await initToolContext({
    externalUserId: process.env.COMPASS_HEALTH_USER_ID ?? "default-user",
    locale: process.env.COMPASS_HEALTH_LOCALE ?? "zh",
    databaseUrl: process.env.COMPASS_HEALTH_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  setToolContext(ctx);  // shared with tool execute closures
  return () => ctx.close();  // disposer closes DB pool
};
```

The `ToolContext` is initialized once when the agent starts and shared with all tool execute functions via module-level state. The disposer returned from install ensures the DB pool is closed when the harness shuts down.

### 7.6 Permission Policy

```typescript
policy: {
  defaults: {
    "read-only": "allow",   // nutrition_estimate, daily_summary, weekly_report
    write: "allow",          // log_meal, log_water, etc. (auto-approved — no destructive side effects)
    destructive: "deny",     // not used
    network: "deny",         // agent is DB-only, no external API calls
  },
}
```

### 7.7 Registration

Added to `pi-harness/src/agents/profiles/index.ts`:
- Import: `import { compassHealthProfile } from "./compass-health/profile.ts"`
- Array: added to `builtInProfiles`
- Export: `export { compassHealthProfile, createCompassHealthToolRegistrations }`

### 7.8 Usage

```bash
# Start the agent
COMPASS_HEALTH_USER_ID=holly DATABASE_URL=postgres://compass:compass@localhost:5433/compass_health \
  pi-harness --agent compass-health

# Or with env file
pi-harness --agent compass-health "今天午餐吃了鸡胸肉200g加糙米饭80g"
```

---

## 8. Test Results

```
compass-health-agent:  122 tests, 16 files, all passing (100 unit + 22 integration)
pi-harness:            147 tests, 18 files, all passing (1 skipped, pre-existing)
```

Both projects typecheck cleanly with zero errors.

---

## 9. Complete File Inventory

### compass-health-agent changes

| File | Action | Purpose |
|---|---|---|
| `src/tools/handlers.ts` | Modified | Added `handleSetProfile` with calorie engine integration |
| `src/agent.ts` | Modified | Registered `set_profile` as write tool (12 total) |
| `src/index.ts` | Modified | Added `set_profile` to tool registry, fixed type casts for build |
| `tsconfig.build.json` | Created | Build config emitting to `dist/` |
| `package.json` | Modified | Added `main`, `exports`, `build` script |
| `tests/agent.test.ts` | Modified | Updated expected write tool list |
| `tests/handlers/integration.test.ts` | Created | 12 end-to-end tests through handler → DB pipeline |

### pi-harness changes

| File | Action | Purpose |
|---|---|---|
| `package.json` | Modified | Added `compass-health-agent` as `file:` dependency |
| `src/agents/profiles/compass-health/prompt.ts` | Created | Bilingual system prompt |
| `src/agents/profiles/compass-health/tools.ts` | Created | 10 AgentTool registrations with TypeBox schemas |
| `src/agents/profiles/compass-health/profile.ts` | Created | AgentProfile with install hook |
| `src/agents/profiles/index.ts` | Modified | Import + register + export compassHealthProfile |
