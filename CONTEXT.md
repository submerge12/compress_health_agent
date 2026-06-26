# Context

This file records the shared domain language for agents working in this
repository.

## Repository Shape

`compass-health-agent` is a TypeScript package for the Compass Health
pi-harness domain agent. It owns health-domain tool handlers, meal-planning
behavior, recipe recommendation behavior, repository access, localization, and
the public package exports consumed by pi-harness.

`G:\pi-harness` is a read-only framework reference for this workspace. This
repo should stay decoupled from pi-harness internals by keeping local
profile-compatible types and exporting stable handler/context surfaces.

## Glossary

| Term | Meaning |
| --- | --- |
| Compass Health agent | The domain agent implemented by this package. |
| pi-harness | The external framework that adapts and registers this package's exported profile and tools. |
| Agent profile | The metadata describing the agent name, model, prompt, tools, scheduled tasks, policy, and install behavior. |
| Tool context | Runtime dependencies and request context passed to tool handlers, including repository access and locale. |
| Tool handler | A function exported by this package that implements one agent tool or higher-level agent workflow. |
| Meal plan entry | A scheduled meal-plan row with meal type, status, dish details, nutrients, and serialized ingredients. |
| Smart meal plan | The higher-level meal-plan generation flow that uses user context and domain rules instead of a static dish list. |
| Smart recipe recommendation | The higher-level recipe recommendation flow that uses user context and domain rules. |
| Proactive check | A scheduled agent workflow for meal check-ins, daily summaries, and reminders. |
| Thaw reminder | A proactive reminder derived from upcoming meal-plan ingredients that need advance preparation. |

## Working Agreements

- Keep Compass Health domain logic in this repo, not in the framework.
- Treat `G:\pi-harness` as read-only reference material.
- Preserve this package's public exports when changing handler or context code.
- Prefer the vocabulary in this file for issues, refactor plans, tests, and ADRs.
