# Phase 5: Smart Meal Plan & Recipe Tools

This document records the work done in Phase 5 on 2026-06-17, completing the last 2 missing tools — `generate_meal_plan` and `recipe_recommend` — by adding smart wrappers that auto-load dish candidates and calorie targets from the database.

---

## 1. Problem

Phase 4 registered 10 tools in the pi-harness profile but omitted `generate_meal_plan` and `recipe_recommend`. Both required the LLM to construct complex nested `RecipeDish[]` arrays with nutrition objects, ingredient lists, and seasoning arrays — an unreasonable ask for a conversational agent. The user should be able to say "generate a meal plan" or "recommend a dinner recipe" without providing candidate dishes.

---

## 2. Design: Smart Handlers

Instead of modifying the existing handlers (which have their own tests and serve the tool-layer directly), Phase 5 adds two new "smart" handler functions that:

1. Load dish candidates from preset data + user cooking records
2. Load calorie targets from the user's BMR profile in the database
3. Delegate to the existing handlers with all required parameters filled in

The LLM passes only simple parameters:
- `generate_meal_plan`: optionally `startDate` (defaults to tomorrow)
- `recipe_recommend`: `mealType` and optionally `maxKcal` (defaults to the meal-type kcal split from BMR target)

---

## 3. Preset Dish Catalog

**File created:** `src/data/preset-dishes.ts`

14 complete-meal dishes based on the user's ingredient whitelist, accepted seasonings, and cooking methods:

| Category | Count | Kcal Range | Dishes |
|---|---|---|---|
| Breakfast | 4 | 430–460 | egg oat porridge, sweet potato yogurt bowl, corn mantou egg, quinoa ciabatta egg |
| Lunch | 5 | 660–720 | scallion beef rice, braised chicken thigh rice, chicken shrimp salad soup, braised hairtail rice, onion beef rice |
| Dinner | 5 | 580–640 | steamed bream rice, broccoli shrimp rice, garlic noodle napa shrimp rice, chicken carrot rice, pan seared bream rice |

Each dish is a `RecipeDish` with:
- `mealTypes` restricting it to the appropriate slot
- Full nutrition (kcal, protein, carbs, fat, sodium) calibrated so any breakfast + lunch + dinner combo falls within ±10% of the 1771 kcal target
- Ingredient slugs matching the food_items database
- Seasonings from the accepted whitelist only (no chili, no sugar, no MSG)
- Cooking method from the user's preferred set

---

## 4. Candidate Loader

**File created:** `src/tools/candidate-loader.ts`

`loadCandidateDishes(ctx)` assembles the full candidate pool:

1. Loads the user's cooking records from DB (`listCookingRecords`)
2. Filters to records with nutrition data (`caloriesKcal > 0`)
3. Converts to `RecipeDish` format
4. Merges with preset dishes, deduplicating by slug

This means cooking records the user has saved (with nutrition data) automatically become meal plan candidates alongside the preset catalog.

---

## 5. Repository: listCookingRecords

**File modified:** `src/db/repository.ts`

Added `CookingRecordRow` interface and `listCookingRecords(userId)` method that queries the `cooking_records` table ordered by `last_cooked_at DESC`.

---

## 6. Smart Handlers

**File modified:** `src/tools/handlers.ts`

### handleSmartGenerateMealPlan

```typescript
Input:  { startDate?: string }
Output: GenerateMealPlanResult (plan, overview, storedCount)
```

1. Defaults `startDate` to tomorrow if omitted
2. Loads BMR profile → `dailyKcalTarget` (falls back to 2000)
3. Loads candidates via `loadCandidateDishes(ctx)`
4. Delegates to `handleGenerateMealPlan` with all parameters

### handleSmartRecipeRecommend

```typescript
Input:  { mealType: string, maxKcal?: number }
Output: RecipeRecommendResult (options, summary)
```

1. Validates `mealType` is breakfast/lunch/dinner
2. Loads BMR profile → computes slot kcal from meal split (25/40/35)
3. Uses explicit `maxKcal` if provided, otherwise uses the computed slot value
4. Loads candidates via `loadCandidateDishes(ctx)`
5. Delegates to `handleRecipeRecommend`

---

## 7. Tool Registry & Pi-Harness Profile

### compass-health-agent index.ts

Updated tool registry: `generate_meal_plan` and `recipe_recommend` now route to the smart handlers instead of the raw ones.

### pi-harness tools.ts

Added 2 new tool registrations:

| Tool | Access Level | Parameters |
|---|---|---|
| `generate_meal_plan` | write | startDate? (optional YYYY-MM-DD) |
| `recipe_recommend` | read-only | mealType, maxKcal? (optional number) |

Total pi-harness tool count: **12** (5 read-only, 7 write).

### pi-harness prompt.ts

Added workflow steps 6–7 for the new tools.

---

## 8. Integration Tests

**File modified:** `tests/handlers/integration.test.ts`

5 new tests added:

| # | Test | Verifies |
|---|---|---|
| 1 | Recommends recipes using auto-loaded preset dishes | Returns 1–3 options with positive kcal for lunch |
| 2 | Recommends recipes with explicit maxKcal | All returned options ≤ 650 kcal for dinner |
| 3 | Generates 7-day meal plan using preset dishes and BMR target | 21 entries, 7 days, each day 1500–2100 kcal |
| 4 | Generates meal plan with explicit startDate | Plan starts on 2026-07-01 |
| 5 | Dispatches recipe_recommend through invokeTool registry | Registry routes to smart handler correctly |

---

## 9. Test Summary

```
Before Phase 5:  122 tests, 16 files (100 unit + 22 integration)
After Phase 5:   127 tests, 16 files (100 unit + 27 integration)
All passing, 0 failures.
```

Both projects typecheck cleanly:
```
compass-health-agent: 127 tests, 16 files, all passing
pi-harness:           147 tests, 18 files, all passing (1 skipped, pre-existing)
```

---

## 10. Complete File Inventory

### compass-health-agent

| File | Action | Purpose |
|---|---|---|
| `src/data/preset-dishes.ts` | Created | 14 preset complete-meal dishes calibrated to 1771 kcal target |
| `src/tools/candidate-loader.ts` | Created | Merges preset dishes + user cooking records into candidate pool |
| `src/tools/handlers.ts` | Modified | Added `handleSmartGenerateMealPlan` and `handleSmartRecipeRecommend` |
| `src/db/repository.ts` | Modified | Added `CookingRecordRow` type and `listCookingRecords` method |
| `src/index.ts` | Modified | Registry routes `generate_meal_plan` and `recipe_recommend` to smart handlers |
| `tests/handlers/integration.test.ts` | Modified | Added 5 integration tests for smart handlers |

### pi-harness

| File | Action | Purpose |
|---|---|---|
| `src/agents/profiles/compass-health/tools.ts` | Modified | Added `generate_meal_plan` and `recipe_recommend` tool registrations |
| `src/agents/profiles/compass-health/prompt.ts` | Modified | Added workflow steps 6–7 for meal plan and recipe tools |

---

## 11. Full Tool Coverage

All 12 agent tools are now registered in both compass-health-agent and the pi-harness profile:

| Tool | Type | Pi-Harness |
|---|---|---|
| set_profile | write | ✓ |
| log_meal | write | ✓ |
| log_water | write | ✓ |
| log_exercise | write | ✓ |
| log_weight | write | ✓ |
| meal_checkin | write | ✓ |
| update_cooking_record | write | ✓ |
| generate_meal_plan | write | ✓ (Phase 5) |
| nutrition_estimate | read-only | ✓ |
| daily_summary | read-only | ✓ |
| recipe_recommend | read-only | ✓ (Phase 5) |
| weekly_report | read-only | ✓ |
