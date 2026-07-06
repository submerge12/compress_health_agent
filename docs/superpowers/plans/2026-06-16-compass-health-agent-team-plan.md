# Compass Health Agent Team Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each worker must follow the provided worker protocol and stay inside its assigned file scope. Each reviewer must follow the provided reviewer protocol and review only its assigned scope.

**Goal:** Build a TypeScript Compass Health Agent skeleton with database schema, nutrition engines, logging tools, meal planning, reporting, and bilingual agent integration.

**Architecture:** The implementation is split into independent modules with shared domain types. Pure calculation code lives under `src/engine`, database definitions under `src/db`, user-facing tool functions under `src/tools`, and agent wiring under `src/agent.ts` and `src/i18n.ts`.

**Tech Stack:** TypeScript 5, Node.js, pnpm, Vitest, Drizzle ORM, postgres, tsx.

---

## Worker Split

### Worker 1: Project Scaffold And Database

**Files to write:**
- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `drizzle.config.ts`
- `.gitignore`
- `src/index.ts`
- `src/db/schema.ts`
- `src/db/connection.ts`
- `src/db/seed.ts`
- `tests/db/schema.test.ts`
- `tests/index.test.ts`
- `.ai/checkpoints/scaffold-db/step-*.md`

**Responsibility:** Project setup, Drizzle table definitions, connection helper, CSV seeding helpers, and smoke tests.

### Worker 2: Nutrition Engine

**Files to write:**
- `src/engine/calorie.ts`
- `src/engine/natural-units.ts`
- `src/engine/nutrition.ts`
- `src/engine/types.ts`
- `tests/engine/calorie.test.ts`
- `tests/engine/natural-units.test.ts`
- `tests/engine/nutrition.test.ts`
- `.ai/checkpoints/nutrition-engine/step-*.md`

**Responsibility:** BMR/TDEE/macros, natural unit resolution, nutrition aggregation, and seasoning sodium accounting.

### Worker 3: Core Logging Tools

**Files to write:**
- `src/tools/store.ts`
- `src/tools/log-meal.ts`
- `src/tools/nutrition-estimate.ts`
- `src/tools/log-water.ts`
- `src/tools/log-exercise.ts`
- `src/tools/log-weight.ts`
- `src/tools/daily-summary.ts`
- `tests/tools/logging.test.ts`
- `tests/tools/daily-summary.test.ts`
- `.ai/checkpoints/logging-tools/step-*.md`

**Responsibility:** In-memory repository contract, meal/water/exercise/weight logging, daily summary aggregation.

### Worker 4: Recipes And Meal Planning

**Files to write:**
- `src/engine/recipe-engine.ts`
- `src/engine/meal-planner.ts`
- `src/tools/update-cooking-record.ts`
- `src/tools/recipe-recommend.ts`
- `src/tools/generate-meal-plan.ts`
- `src/tools/meal-checkin.ts`
- `tests/engine/recipe-engine.test.ts`
- `tests/engine/meal-planner.test.ts`
- `tests/tools/meal-plan-tools.test.ts`
- `.ai/checkpoints/recipes-planning/step-*.md`

**Responsibility:** Recipe recommendation, seven-day meal planning constraints, generation tool, and meal check-in flows.

### Worker 5: Agent, I18n, And Reporting

**Files to write:**
- `src/i18n.ts`
- `src/agent.ts`
- `src/tools/weekly-report.ts`
- `src/engine/pattern-detector.ts`
- `tests/i18n.test.ts`
- `tests/agent.test.ts`
- `tests/tools/weekly-report.test.ts`
- `tests/engine/pattern-detector.test.ts`
- `.ai/checkpoints/agent-reporting/step-*.md`

**Responsibility:** Bilingual templates, local AgentProfile-compatible object, tool registration metadata, weekly reporting, and pattern detection.

---

## Reviewer Split

### Reviewer A: Scaffold And DB

Review Worker 1 files for contract coverage, schema completeness, config correctness, seed parsing safety, and tests.

### Reviewer B: Nutrition Engine

Review Worker 2 files for formula correctness, boundary handling, sodium calculations, deterministic tests, and no DB/tool coupling.

### Reviewer C: Logging Tools

Review Worker 3 files for repository contract consistency, input validation, idempotency expectations, summary correctness, and tests.

### Reviewer D: Recipes And Planning

Review Worker 4 files for meal-planning constraints, check-in flows, fallback behavior, and tests.

### Reviewer E: Agent And Reporting

Review Worker 5 files for bilingual output separation, tool access levels, reporting correctness, pattern detection, and tests.

---

## Global Constraints

- Do not batch delete files or directories.
- Do not use `del /s`, `rd /s`, `rmdir /s`, `Remove-Item -Recurse`, or `rm -rf`.
- Do not add dependencies outside the declared TypeScript stack unless the coordinator approves.
- Use TDD: write tests before production code and verify the red failure where possible.
- Keep write scopes disjoint. If a scope boundary is wrong, stop and report instead of editing another worker's files.
- Run `pnpm test` and `pnpm typecheck` before reporting completion when dependencies are available.
