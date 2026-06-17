# Phase 3: Tool Handlers & Agent Entry Point

This document records the work done in Phase 3 on 2026-06-17, covering the ToolContext, async DB-backed handlers for all 11 tools, and the agent entry point wiring.

---

## 1. Problem

The 11 tools built in Phases 1–2 used two incompatible persistence models:

| Tool Group | Interface | Persistence |
|---|---|---|
| log-meal, log-water, log-exercise, log-weight, daily-summary | `HealthRepository` (sync) | In-memory only |
| generate-meal-plan | `MealPlanStore` (sync, optional) | In-memory only |
| meal-checkin | `MealCheckinStore` (sync, optional) | In-memory only |
| update-cooking-record | `CookingRecordStore` (sync, optional) | In-memory only |
| nutrition-estimate, recipe-recommend, weekly-report | Pure functions | N/A |

The DB repository (`src/db/repository.ts`) is fully async. The existing 97 unit tests depend on the sync in-memory store. The challenge was bridging async DB persistence into production without breaking existing tests.

---

## 2. Architecture Decision

**Parallel async handlers**, not sync interface adapters.

Rather than making the `HealthRepository` interface async (which would break all existing tools and tests), we created a new `handlers.ts` module with async functions that:
1. Reuse the same validation and parsing logic (replicated for private functions, imported for exported ones)
2. Call the DB repository directly
3. Return the same structured data the LLM agent expects

The original sync tools and their unit tests remain untouched.

---

## 3. ToolContext (`src/tools/context.ts`)

Bundles everything a handler needs into a single object:

```typescript
interface ToolContext {
  userId: string;           // DB user ID (auto-created on first use)
  locale: "zh" | "en";     // User's language preference
  repo: Repository;        // DB CRUD from repository.ts
  catalog: MealCatalog;    // Food catalog loaded from DB
  seasoningRecords: NutritionRecord[];  // 20 seasonings with sodium data
  close: () => Promise<void>;  // Shut down connection pool
}
```

### Initialization

```typescript
const ctx = await initToolContext({
  externalUserId: "wechat-user-123",  // From pi-harness session
  locale: "zh",
  timezone: "Asia/Shanghai",
  databaseUrl: process.env.DATABASE_URL,  // Optional, defaults to local
});
```

`initToolContext` performs:
1. Opens PostgreSQL connection pool (max 5 connections)
2. `findOrCreateUser` — idempotent user lookup/creation
3. Loads food catalog (1,521 foods + 35 natural units) and 20 seasoning records in parallel
4. Returns ready-to-use ToolContext

---

## 4. Async Handlers (`src/tools/handlers.ts`)

11 handlers matching the 11 tool registrations in `agent.ts`:

### Read-only

| Handler | Input | Returns | Notes |
|---|---|---|---|
| `handleNutritionEstimate` | `{ description }` | `NutritionEstimateResult` | Delegates to existing pure function with `ctx.catalog` |
| `handleDailySummary` | `{ date }` | `DailySummaryResult` | Loads diet/water/exercise logs + BMR profile from DB |
| `handleWeeklyReport` | `{ endDate, sodiumLimitMg? }` | `WeeklyReport` | Loads 7 days of diet logs, delegates to pure function |
| `handleRecipeRecommend` | `RecipeRecommendInput` | `RecipeRecommendResult` | Delegates to existing pure function |

### Write

| Handler | Input | Returns | Notes |
|---|---|---|---|
| `handleLogMeal` | `{ date, mealType, description }` | `DietLogRow` | Parses food, estimates nutrition via catalog, writes to DB |
| `handleLogWater` | `{ date, description }` | `WaterLogRow` | Parses ml/cups from description, writes to DB |
| `handleLogExercise` | `{ date, description }` | `ExerciseLogRow` | Parses activity type + duration, writes to DB |
| `handleLogWeight` | `{ date, description }` | `WeightLogRow` | Parses kg from description, writes to DB |
| `handleUpdateCookingRecord` | `{ note, recordedAt? }` | `UpdateCookingRecordResult` | Parses ingredient/method/seasoning, upserts in DB |
| `handleGenerateMealPlan` | `MealPlanRequest` | `GenerateMealPlanResult` | Runs engine, stores all entries in DB one-by-one |
| `handleMealCheckin` | `{ date, mealType, status, actualDescription? }` | `MealCheckinResult` | Updates plan status, creates diet log for followed/substituted |

### Key Design Details

- **Daily summary auto-loads targets**: Reads the user's BMR profile to get kcal/protein/carbs/fat targets. Falls back to 2000/60/250/65 if no profile exists.
- **Meal checkin with substitution**: If `status === "substituted"` and `actualDescription` is provided, re-estimates nutrition from the catalog.
- **Generate meal plan persists entries**: Collects entries from the sync engine via a `MealPlanStore` adapter, then writes each to DB.

---

## 5. Agent Entry Point (`src/index.ts`)

Exports:

```typescript
// The agent profile (tool list, system prompt, scheduled tasks)
export { profile } from "./agent.js";

// Context initialization
export { initToolContext, type ToolContext } from "./tools/context.js";

// All handlers
export * as handlers from "./tools/handlers.js";

// Tool dispatch
export function getToolHandler(name: string): ToolHandler | undefined;
export async function invokeTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<unknown>;
```

### Tool Registry

A `toolRegistry` maps each tool name to its handler:

```typescript
const toolRegistry: Record<string, ToolHandler> = {
  nutrition_estimate: (ctx, input) => handlers.handleNutritionEstimate(ctx, input),
  log_meal:          (ctx, input) => handlers.handleLogMeal(ctx, input),
  // ... all 11 tools
};
```

### Usage by pi-harness

```typescript
import { profile, initToolContext, invokeTool } from "compass-health-agent";

// On session start
const ctx = await initToolContext({ externalUserId: session.userId });

// On tool call from LLM
const result = await invokeTool(ctx, toolCall.name, toolCall.arguments);

// On session end
await ctx.close();
```

---

## 6. Test Summary

```
Before Phase 3:  107 tests, 15 files (97 unit + 10 integration)
After Phase 3:   110 tests, 15 files (100 unit + 10 integration)
All passing, 0 failures.
```

New tests added to `tests/index.test.ts`:
- `getToolHandler` returns a handler for every registered tool
- `getToolHandler` returns undefined for unknown tools
- `invokeTool` throws for unknown tools

---

## 7. Files Changed / Created

| File | Action | Purpose |
|---|---|---|
| `src/tools/context.ts` | Created | ToolContext interface + `initToolContext()` |
| `src/tools/handlers.ts` | Created | 11 async handlers bridging tools to DB |
| `src/index.ts` | Rewritten | Tool registry, `invokeTool()`, exports |
| `tests/index.test.ts` | Rewritten | 5 tests for entry point and registry |

---

## 8. What's NOT Changed

- `src/tools/store.ts` — In-memory `HealthRepository` preserved for unit tests
- `src/tools/log-meal.ts`, `log-water.ts`, `log-exercise.ts`, `log-weight.ts`, `daily-summary.ts` — Original sync tools unchanged
- `src/tools/generate-meal-plan.ts`, `meal-checkin.ts`, `update-cooking-record.ts` — Original sync tools unchanged
- `src/tools/nutrition-estimate.ts`, `recipe-recommend.ts`, `weekly-report.ts` — Pure functions unchanged
- All 97 original unit tests — Unmodified and passing
