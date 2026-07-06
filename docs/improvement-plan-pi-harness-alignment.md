# Improvement Plan — Aligning compass-health-agent with the modified pi-harness

**Date:** 2026-06-25
**Status:** Proposed
**Scope:** `G:\compass-health-agent` only. `G:\pi-harness` is read-only — this plan never edits it, but it does produce surfaces the framework maintainer can adopt.

---

## 0. Situation

The pi-harness framework's compass-health profile
(`G:\pi-harness\src\agents\profiles\compass-health\{profile,tools,prompt}.ts`) has already been
built out into the *real* integration. It now carries:

- a single combined bilingual `systemPrompt` (`prompt.ts`) with Hard Rules (sodium 800/2300 mg),
  a `set_profile` onboarding workflow, and output formatting rules;
- `model: { provider: "deepseek", modelId: "deepseek-v4-pro" }`, `thinkingLevel: "medium"`;
- a `policy` that denies `destructive` and `network`;
- an `install` hook that builds the DB-backed `ToolContext` from env vars and disposes it;
- a `proactiveCheck` that drives meal check-ins, daily summaries, **and a thaw reminder** that
  inspects upcoming meal-plan ingredients for meat slugs;
- `scheduledTasks` modelled as `taskType: "proactive_check"` (cron only), not per-tool triggers;
- TypeBox tool registrations for all 12 tools, wired to **smart** handlers
  (`handleSmartGenerateMealPlan`, `handleSmartRecipeRecommend`).

It consumes this repo through the package `exports` map → `./dist/...`:

- `compass-health-agent/tools/context` → `initToolContext`, `ToolContext`
- `compass-health-agent/tools/handlers` → all `handle*` functions

**Verified current state:**

- `pnpm typecheck` → exit 0.
- Every symbol the framework imports exists in this repo and matches signatures.
- `ctx.repo.listMealPlanEntries` and the `MealPlanEntryRow` fields the proactive check reads
  (`mealType`, `status`, `dishName`, `caloriesKcal`, `proteinGrams`, `ingredientsJson`) all exist.

So the **runtime contract is satisfied** — nothing is broken. The problems the modification
surfaced are *drift*, *duplication*, and *missing guardrails*, listed below.

---

## 1. Problems

### P1 — `src/agent.ts` no longer mirrors the deployed profile (HIGH)

This repo's exported `AgentProfileCompatible` describes a different agent than the one actually
running in the framework:

| Field | This repo (`src/agent.ts`) | Reality (pi-harness profile) |
|---|---|---|
| `model.provider` | `"openai"` | `"deepseek"` |
| model id | `model: "default-health-agent"` | `modelId: "deepseek-v4-pro"` |
| tuning | `temperature: 0.2` | `thinkingLevel: "medium"` (no temperature) |
| `systemPrompt` | thin `{ zh, en }` pair | one combined bilingual string with Hard Rules / workflow |
| `scheduledTasks` | `{ name, toolName, schedule }` per-tool | `{ id, agentProfile, taskType: "proactive_check", schedule: { cron } }` |
| `proactiveCheck` | absent | present (check-ins + daily summary + thaw reminder) |
| `install` / `policy` / `context` | absent | all present |

`validateAgentProfile` enforces invariants that no longer match reality: it checks
`temperature ∈ [0,1]` (a field the real profile doesn't carry) and that every `scheduledTask.toolName`
is a known tool (the real tasks are `proactive_check`, not tool-named). The validator is guarding a
fiction.

### P2 — Domain knowledge leaked into the framework (HIGH)

The thaw reminder hardcodes `MEAT_SLUGS` and `findMeatIngredients` **inside pi-harness**
(`profile.ts:56-72`). Those slugs duplicate ingredient data that lives in *this* repo
(`src/data/preset-dishes.ts` / the food-items catalog). This is exactly the kind of domain logic the
"decoupled domain agent" boundary is meant to keep here. Drift risk: rename or add a meat slug in this
repo and the framework's reminder silently goes stale.

### P3 — Proactive output is English-only (MEDIUM)

`proactiveCheck` builds English strings ("Daily summary for…", "Meal check-in:…") even though the
agent is bilingual, `install` already passes `locale`, and `ctx.locale` is available. This repo owns
`src/i18n.ts`; the localized phrasing belongs here, not as English literals in the framework.

### P4 — The build/consumption contract is unguarded (MEDIUM)

The framework imports resolve to `./dist`, so a consumer gets whatever was last built. There is no
check that `dist` is fresh, that the `exports` map matches emitted files, or that the exact surface the
framework imports still resolves. A refactor here can break the framework with a green `typecheck`
(which never emits `dist`). Note also `exports["./engine/types"]` is declared but unused by the
framework — confirm whether it's needed.

### P5 — Agent-workflow docs referenced by CLAUDE.md are missing (MEDIUM)

`CLAUDE.md` points to `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`,
`docs/agents/domain.md`, plus a single-context `CONTEXT.md` + `docs/adr/`. **None exist.** Templates are
available under `.agents/skills/setup-matt-pocock-skills/`. Either create them or correct CLAUDE.md.

---

## 2. Workstreams

Ordered by priority. Each is independently shippable. TDD throughout (tests first, verify red).
No commits without an explicit ask.

### WS1 — Make `src/agent.ts` honest (closes P1)

The framework is read-only and CLAUDE.md mandates decoupling (local types, no hard pi-harness dep), so
we keep this repo's *own* profile object — but stop it from describing a different agent.

- Update `model` to reflect the deployed model (`provider: "deepseek"`, `modelId`/`thinkingLevel`), or
  reduce `model` to the fields this repo genuinely owns and drop the misleading `temperature`.
- Replace the `{ zh, en }` `systemPrompt` representation so it is consistent with the single combined
  bilingual prompt actually used; if the repo keeps a prompt, make it the source the framework mirrors.
- Re-model `scheduledTasks` to the `proactive_check` taxonomy (cron-only), matching reality.
- Rework `validateAgentProfile`: drop the `temperature` range check; change the scheduled-task
  invariant from "references a known tool" to the real invariant (unique cron ids, valid task type).
- Update `src/agent.test.ts` (and `src/index.ts`'s `ToolName` derivation if the tool list shape moves).

**Acceptance:** `agent.ts` metadata matches the pi-harness profile field-for-field where the repo
claims to describe it; validator invariants are all satisfiable by the real profile; tests green.

### WS2 — Own the thaw-reminder domain logic here (closes P2)

Expose a handler from this repo so the framework stops hardcoding domain knowledge:

- Add `handleProactiveCheck(ctx, { now?, locale? })` (or a narrower `buildThawReminder` / `buildMealCheckin`)
  to `src/tools/handlers.ts` that returns the structured message + thaw items.
- Source meat slugs from this repo's data (derive `MEAT_SLUGS` from `preset-dishes` / catalog metadata,
  e.g. an ingredient `category: "meat"`) instead of a hand-maintained literal.
- Export it through `compass-health-agent/tools/handlers`.

The framework change (swapping its inline logic for this handler) is out of scope here, but providing
the handler is the prerequisite and lets the framework maintainer delete the duplicate.

**Acceptance:** a unit test drives the thaw reminder off seeded meal-plan entries; meat detection comes
from repo data; no meat slug literal outside this repo's data layer.

### WS3 — Localize proactive output (closes P3)

- Move the proactive message phrasing into `src/i18n.ts` and have the WS2 handler localize via
  `ctx.locale`.
- Cover both `zh` and `en` in tests.

**Acceptance:** the handler returns Chinese for `locale: "zh"` and English for `"en"`.

### WS4 — Guard the consumption contract (closes P4)

- Add a build-and-resolve smoke test: run `pnpm build`, then assert each `exports` subpath
  (`.`, `./tools/context`, `./tools/handlers`, `./engine/types`) resolves and re-exports the symbols the
  framework imports.
- Decide and document whether `./engine/types` stays exported (framework doesn't import it today).
- Document in `CLAUDE.md` / README that consumers require a built `dist` (or wire a `prepare`/`prepack`
  build script).

**Acceptance:** a single test fails if the public surface the framework relies on stops resolving.

### WS5 — Restore the agent-workflow docs (closes P5)

- Create `docs/agents/{issue-tracker,triage-labels,domain}.md`, root `CONTEXT.md`, and `docs/adr/`
  from the `.agents/skills/setup-matt-pocock-skills/` templates — or trim CLAUDE.md to what exists.

**Acceptance:** every path CLAUDE.md references resolves.

### WS6 — Contract test mirroring framework usage (cross-cutting guard)

- Add `tests/contract/pi-harness-surface.test.ts` that imports exactly what
  `G:\pi-harness\src\agents\profiles\compass-health` imports (`initToolContext` signature, each
  `handle*` the framework calls, the `MealPlanEntryRow` fields the proactive check reads) so a
  breaking change here fails *here first*, before it reaches the read-only framework.

**Acceptance:** test enumerates the framework's import surface and asserts presence + arity.

---

## 3. Sequencing

1. **WS1** (honest metadata) and **WS5** (docs) — independent, low-risk, do first.
2. **WS2 → WS3** (own + localize the thaw/check-in logic) — WS3 depends on WS2's handler.
3. **WS6** then **WS4** — lock the surface with a contract test, then guard the build that ships it.

## 4. Constraints (from CLAUDE.md)

- Edit this repo only; **never** modify `G:\pi-harness`.
- pnpm + this repo's existing TS config; no new deps without approval.
- TDD: tests before production code, verify the red.
- No commits and no bulk deletion without an explicit ask.
