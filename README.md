# Compass Health Agent

[中文版](README.zh-CN.md)

Bilingual (Chinese/English) health and nutrition agent — calorie tracking, meal planning, recipe recommendation, and weekly nutrition reports.

Built as a standalone TypeScript library with 12 tool handlers, a PostgreSQL persistence layer, and a calorie engine based on the Mifflin-St Jeor equation. Designed to plug into any LLM agent framework via its exported tool registry.

## Features

- **Calorie Engine** — BMR (Mifflin-St Jeor), TDEE, goal-adjusted calorie targets, and full macro distribution (protein / carbs / fat) with safety bounds and backtracking
- **Nutrition Estimation** — Parse bilingual free-text meal descriptions into structured nutrition data. CJK-aware text segmentation splits Chinese food entries without breaking English multi-word names
- **Meal / Water / Exercise / Weight Logging** — Natural-language input parsing (e.g. `"2 cups water"`, `"running 30 minutes"`, `"72.5kg"`)
- **7-Day Meal Planner** — Greedy dish selection with per-slot kcal targets, ingredient-run constraints (no ingredient 3 meals in a row), and seasoning preference filtering
- **Recipe Recommendation** — Score-based ranking by calorie fit, protein target, recency penalty, ingredient variety, and user preference bonuses
- **Weekly Nutrition Report** — Macro split, adherence rate, sodium trend analysis, micronutrient gap detection, and actionable suggestions
- **14 Preset Dishes + Custom Dishes** — Ships with 14 built-in dishes calibrated to real nutritional data; users can add their own dishes via cooking records
- **Bilingual i18n** — All user-facing templates available in both Chinese and English

## Architecture

```
src/
├── engine/          # Pure computation (calorie, meal-planner, recipe-engine, nutrition, natural-units, pattern-detector)
├── tools/           # Tool handlers (12 tools + 2 smart wrappers), nutrition estimation, candidate loading
├── db/              # PostgreSQL schema (Drizzle ORM), repository, seed data, catalog loader
├── data/            # Preset dish definitions
├── i18n.ts          # Bilingual template renderer
├── agent.ts         # Agent profile and tool registration
└── index.ts         # Tool registry and CLI entry point
tests/
├── engine/          # Calorie, meal-planner, recipe-engine, natural-units, nutrition, pattern-detector
├── tools/           # Logging, daily-summary, weekly-report, meal-plan
├── handlers/        # Integration tests
└── db/              # Schema and DB integration tests
```

## Tools

| Tool | Access | Description |
|------|--------|-------------|
| `set_profile` | write | Set physical profile, compute BMR/TDEE/macro targets |
| `nutrition_estimate` | read | Estimate nutrition from free-text food description |
| `log_meal` | write | Log a meal with auto-parsed nutrition |
| `log_water` | write | Log water intake from natural language |
| `log_exercise` | write | Log exercise with auto-estimated calorie burn |
| `log_weight` | write | Log body weight |
| `daily_summary` | read | Summarize a day's nutrition, water, and exercise |
| `weekly_report` | read | 7-day nutrition report with trends and suggestions |
| `recipe_recommend` | read | Recommend dishes ranked by fit and variety |
| `generate_meal_plan` | write | Generate and persist a 7-day meal plan |
| `meal_checkin` | write | Confirm, substitute, or skip a planned meal |
| `update_cooking_record` | write | Save or update a personal cooking record |

Smart wrappers (`generate_meal_plan`, `recipe_recommend`) auto-load the user's BMR profile, candidate dishes, and seasoning preferences before calling the underlying engine.

## Tech Stack

- **Runtime**: Node.js + TypeScript (ES2022, NodeNext modules)
- **Database**: PostgreSQL via Drizzle ORM
- **Testing**: Vitest (73 test cases across 16 test files)
- **Build**: `tsc` with separate build config

## Setup

```bash
# Install dependencies
npm install

# Set up PostgreSQL (default: postgres://compass:compass@localhost:5433/compass_health)
export DATABASE_URL="postgres://compass:compass@localhost:5433/compass_health"

# Push schema and seed data
npm run db:push
npm run db:seed

# Run tests
npm test

# Build
npm run build
```

## Integration

The agent exports a typed tool registry for use with any LLM agent framework:

```typescript
import { initToolContext, invokeTool, profile } from "compass-health-agent";

const ctx = await initToolContext({
  externalUserId: "user-123",
  locale: "zh",
});

// Invoke any tool by name
const summary = await invokeTool(ctx, "daily_summary", { date: "2026-06-18" });

// Or use individual handlers directly
import { handlers } from "compass-health-agent";
const plan = await handlers.handleSmartGenerateMealPlan(ctx, {});
```

## License

MIT
