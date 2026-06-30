# Compass Health Agent

[中文](README.zh-CN.md)

Bilingual (Chinese/English) health and nutrition agent: calorie tracking, meal planning, recipe recommendation, durable memory, and weekly nutrition reports.

Built as a standalone TypeScript domain-agent package with 16 registered tools, a PostgreSQL persistence layer, and a calorie engine based on the Mifflin-St Jeor equation. Designed to plug into any LLM agent framework via its exported profile, tool registry, context factory, and handlers.

## Features

- **Calorie Engine** — BMR (Mifflin-St Jeor), TDEE, goal-adjusted calorie targets, and full macro distribution (protein / carbs / fat) with safety bounds and backtracking
- **Nutrition Estimation** — Parse bilingual free-text meal descriptions into structured nutrition data. CJK-aware text segmentation splits Chinese food entries without breaking English multi-word names
- **Meal / Water / Exercise / Weight Logging** — Natural-language input parsing (e.g. `"2 cups water"`, `"running 30 minutes"`, `"72.5kg"`)
- **7-Day Meal Planner** — Greedy dish selection with per-slot kcal targets, ingredient-run constraints (no ingredient 3 meals in a row), and seasoning preference filtering
- **Recipe Recommendation** — Score-based ranking by calorie fit, protein target, recency penalty, ingredient variety, and user preference bonuses
- **Weekly Nutrition Report** — Macro split, adherence rate, sodium trend analysis, micronutrient gap detection, and actionable suggestions
- **25 Preset Dishes + User Dishes** — Ships with 6 breakfasts, 14 mains, and 5 sides calibrated to real nutritional data; users can add their own dishes via `propose_dish` and `save_dish`
- **Bilingual i18n** — All user-facing templates available in both Chinese and English

## Architecture

```
src/
├── engine/          # Pure computation (calorie, meal-planner, recipe-engine, nutrition, natural-units, pattern-detector)
├── tools/           # Tool handlers (16 registered tools), nutrition estimation, candidate loading
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
| `nutrition_estimate` | read-only | Estimate nutrition for foods without writing logs. |
| `daily_summary` | read-only | Summarize one day of logged nutrition and activity. |
| `recipe_recommend` | read-only | Recommend recipes from available preferences and records. |
| `weekly_report` | read-only | Aggregate the last 7 days into a weekly nutrition report. |
| `recall` | read-only | Recall durable user preferences, dislikes, routines, and notes. |
| `propose_dish` | read-only | Review a proposed dish and compute nutrition without saving it. |
| `set_profile` | write | Set or update the user's physical profile and calorie/macro targets. |
| `log_meal` | write | Log a meal and its estimated nutrition. |
| `log_water` | write | Log water intake. |
| `log_exercise` | write | Log exercise activity. |
| `log_weight` | write | Log body weight. |
| `update_cooking_record` | write | Save or update a user's cooking record. |
| `generate_meal_plan` | write | Generate and store a 7-day meal plan. |
| `meal_checkin` | write | Record whether a planned meal was followed, substituted, or skipped. |
| `remember` | write | Store a durable user preference, dislike, routine, or note. |
| `save_dish` | write | Persist an approved user dish so it becomes a meal-plan candidate. |

Smart wrappers (`generate_meal_plan`, `recipe_recommend`) auto-load the user's BMR profile, candidate dishes, and seasoning preferences before calling the underlying engine.

## Tech Stack

- **Runtime**: Node.js + TypeScript (ES2022, NodeNext modules)
- **Database**: PostgreSQL via Drizzle ORM
- **Testing**: Vitest
- **Build**: `tsc` with separate build config

## How To Run

This repo is the domain-agent package. The real chat/runtime interface is the framework that imports it, normally pi-harness:

```powershell
pnpm build
pi-harness --agent compass-health
```

Local commands are still useful:

```powershell
# Smoke-check that the package entry point loads.
pnpm start

# Call one tool locally without an LLM.
'{"tool":"nutrition_estimate","args":{"description":"chicken breast 200g"}}' | pnpm dev:repl

# Verify the built package export surface.
pnpm smoke:exports
```

`pnpm start` is not a server; it prints the registered tool count. `pnpm dev:repl` is a small developer harness that reads one tool invocation from stdin, creates a tool context from env, invokes the tool, prints JSON, and exits.

## Setup

```bash
# Install dependencies
pnpm install

# Set up PostgreSQL (default: postgres://compass:compass@localhost:5433/compass_health)
export DATABASE_URL="postgres://compass:compass@localhost:5433/compass_health"

# Push schema and seed data
pnpm db:push
pnpm db:seed

# Run tests
pnpm test

# Build
pnpm build
```

## Integration

The agent exports a typed tool registry for use with any LLM agent framework:

Package subpath exports resolve to `dist`. Run `pnpm build` before consuming this package from another workspace, and use `pnpm smoke:exports` to verify the built public surface (`.`, `./tools/context`, `./tools/handlers`, `./engine/types`) still resolves.

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
