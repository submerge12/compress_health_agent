# Compass Health Agent

**English** | [简体中文](README.zh-CN.md)

A bilingual nutrition and health Agent that turns everyday records into practical meal planning,
tracking, and weekly feedback.

Compass Health Agent is a standalone TypeScript domain package designed to run on pi-harness or
another compatible Agent runtime.

## Product features

- personal BMR, TDEE, calorie, and macro targets using the Mifflin–St Jeor equation;
- Chinese and English meal, water, exercise, and weight logging;
- nutrition estimation from free-text meal descriptions;
- seven-day meal planning with rotation and preference rules;
- recipe recommendations and 25 built-in dishes;
- meal check-ins, weekly nutrition reports, and durable preferences;
- bounded meal replacement that revalidates safety and nutrition before saving;
- PostgreSQL persistence through Drizzle ORM;
- 17 typed tools for use by an Agent runtime.

## Typical workflow

```text
Create profile
  -> generate a seven-day plan
  -> log meals, water, exercise, and weight
  -> check in or replace a meal
  -> review the weekly nutrition report
```

## Quick start

```bash
pnpm install
pnpm db:push
pnpm db:seed
pnpm test
pnpm build
```

The package exports an Agent profile, tool registry, context factory, and handlers for integration
with pi-harness or another runtime.

## Current availability

Core nutrition calculations, logging, meal planning, recommendations, reports, persistence, and the
17-tool interface are available. Meal replacement currently supports a bounded confirmed-change flow. Concurrent edit protection and
explicit previews for changes that affect another meal are not yet exposed as product features.

## Public data boundary

The public repository contains domain source, tests, database schema/migrations, and synthetic seed
dishes. Real health profiles, logs, plans, memories, database dumps, model transcripts, credentials,
and other user-linked data remain local.

## License

MIT
