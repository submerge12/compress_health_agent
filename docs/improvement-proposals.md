# Improvement Proposals

Problems surfaced while figuring out how to run and use this agent, turned into concrete
solution proposals.

## Execution status (2026-06-30)

- Proposal 4 implemented in this branch: README docs now describe the actual 16-tool surface, 25 preset dishes, pnpm commands, `pnpm start` as a smoke check, and pi-harness as the real chat/runtime interface.
- Proposal 2(a) implemented in this branch: `pnpm dev:repl` reads a tool invocation from stdin, invokes the existing registry, prints JSON, and exits. Proposal 2(c) is reflected in README wording.
- Proposal 1 implemented in code/config/migrations: Drizzle tables now target `compass_health` via `pgSchema`, `drizzle.config.ts` filters that schema, Docker has init SQL for schema + `pg_trgm`, and raw SQL/tests were updated.
- Proposal 1 live-DB push/integration still needs a running Docker/Postgres engine. The current environment could not reach `//./pipe/dockerDesktopLinuxEngine`; non-DB verification passed.
- Proposal 3 remains out of scope for this repo and should be executed in a pi-harness session using `docs/pi-harness-pending-changes.md`.

**Suggested order:** 4 (cheap, fixes the confusion) → 2a (local test harness) → 1 (schema
isolation) → 3 (in a pi-harness session).

---

## Proposal 1 — Give the agent its own Postgres schema (isolation)

**Problem.** `src/db/schema.ts` uses plain `pgTable(...)` for every table, so they all land in
Postgres `public`. pi-harness core also uses `public`, and the architecture contract
(`G:\pi-harness\docs\AGENT-ARCHITECTURE.md`) says each agent must own a `pgSchema("name")`.

**Impact.** Running compass-health alongside pi-harness core or any other agent risks
table-name collisions (`users`, etc.) in shared `public`. This is the isolation guarantee the
framework promises, currently unmet.

**Proposed solution.**
- Introduce `export const compass = pgSchema("compass_health")` and convert all tables to
  `compass.table(...)`.
- Add `docker/init.sql` with `CREATE SCHEMA IF NOT EXISTS compass_health;`.
- Regenerate the Drizzle migration; update `repository.ts` and any raw SQL (the pg_trgm
  migration references) to the qualified schema; update DB tests.

**Scope / effort.** Medium — touches schema, migrations, repository, init.sql, tests. One branch.

**Risk.** Migration on an existing DB needs care (move tables vs. recreate); for a fresh dev DB
it's clean. Recommended to do first, since the other DB work builds on it.

---

## Proposal 2 — Add a real way to use the agent locally (usability)

**Problem.** There's no interface to actually exercise the agent here. `pnpm start` only prints a
readiness line; the tools are reachable only from code or from pi-harness.

**Impact.** "How do I use it?" has no local answer today.

**Proposed solution (pick one):**
- **(a) Smallest:** a `pnpm dev:repl` script — read a tool name + JSON args from stdin, call
  `invokeTool`, print the result. ~30 lines, no LLM.
- **(b) Better:** a tiny interactive CLI where you type natural language and it routes to a tool
  (still no LLM — keyword routing), good for demos.
- **(c) Correct long-term:** document that the real chat interface is
  `pi-harness --agent compass-health` and stop expecting a standalone one.

**Scope / effort.** (a) small, (b) small-medium, (c) docs-only.

**Risk.** Low. Recommend (a) + (c) — a dev harness for testing, plus honest docs.

---

## Proposal 3 — Close the pi-harness tool-surface drift (capability loss)

**Problem.** `docs/pi-harness-pending-changes.md` documents that `propose_dish`/`save_dish` gained
`role`/`sideKind`/`selfContained` here, but pi-harness's `tools.ts` doesn't declare them, so the
framework drops them.

**Impact.** Through pi-harness, the LLM **cannot create side dishes or non-self-contained mains**
— those fields get silently stripped. Main-dish add still works.

**Proposed solution.** Execute the checklist already written in `docs/pi-harness-pending-changes.md`:
`pnpm build` here, apply the two TypeBox schema additions to pi-harness's `tools.ts`, then
`typecheck && test && build` on the pi-harness side, and verify a `side` dish round-trips.

**Scope / effort.** Small, but **crosses the repo boundary** — CLAUDE.md forbids editing
`G:\pi-harness` from this repo. This must be done in a pi-harness session, not here.

**Risk.** Low technically; the constraint is the boundary, not the code.

---

## Proposal 4 — Resync the docs with the actual surface (root cause of the confusion)

**Problem.** README/architecture docs are stale: the table lists **12 tools** and "14 preset
dishes," but the registry actually exposes **16 tools** (`propose_dish`, `save_dish`, `recall`,
`remember` are undocumented), and the README's Setup uses `npm` while the project is pnpm.

**Impact.** The docs actively mislead a new user about what the agent is and how to run it — much
of why "how do I use this?" was so hard to answer.

**Proposed solution.**
- Update the README tool table to all 16 with correct access levels (source of truth:
  `src/agent.ts` + `src/index.ts`).
- Add a short **"How to run"** section: `pnpm build` → `pi-harness --agent compass-health` is the
  real interface; `pnpm start`/`pnpm test` are smoke checks.
- Fix `npm` → `pnpm` in Setup.

**Scope / effort.** Small, docs-only.

**Risk.** None. Recommend doing this regardless of the others.
