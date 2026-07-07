## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (using the `gh` CLI). External PRs are also a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## pi-harness framework context

This package is a **pi-harness domain agent** (`name: "compass-health"`): it exports a profile-compatible object
(`src/agent.ts`) that the **pi-harness** framework adapts and registers (wired into pi-harness via
`file:../compass-health-agent`). It is intentionally **decoupled** — it defines its own local profile types
(`AgentProfileCompatible` in `src/agent.ts`) and does **not** depend on pi-harness internals. Keep it that way (local
types, no hard pi-harness dependency).

- **Framework (READ-ONLY reference, pinned at SHA `da0be16`):** `G:\pi-harness`
- **Profile contract — how an agent plugs in:** `G:\pi-harness\docs\AGENT-ARCHITECTURE.md`. When changing the exported
  profile shape (`name`, `systemPrompt`, tools + `accessLevel`, `scheduledTasks`, `proactiveCheck`, `install`), keep it
  compatible with this contract.
- **Executor capabilities the framework provides:** `G:\pi-harness\docs\pi-harness-pi-executor-handoff.md`
- **Reference implementation to mirror:** `G:\travel-assistant\src\profile\`
- Tip: to consult the framework, run `/add-dir G:\pi-harness` (or read its absolute paths directly).

### Harness-facing contract branch
`codex/pi-harness-alignment` on `origin` is the branch pi-harness's optional CI job
("Compass Health integration") builds against. Whenever a handler that pi-harness consumes
is added, renamed, or has its signature changed (the `dist/tools/handlers.d.ts` surface,
`compassHealthProfileSpec`, `createToolContextFromEnv`, `ToolContext.close`), push the
alignment branch in the same change-set: `git push origin <branch>:codex/pi-harness-alignment`
(after secret scan + `CI=true pnpm install --frozen-lockfile` + build + typecheck + tests).

### Boundaries
- **Editability (global rule — identical in all three program repos):** each of
  `agent-orchestration-harness`, `pi-harness`, and `compass-health-agent` is edited only from a
  session working inside that repo itself; from any other seat it is read-only reference.
  Cross-repo changes are never applied directly — they are spec'd and handed to the owning seat
  (pi-harness-side edits via compass-health-agent's `docs/pi-harness-pending-changes.md` + G2
  gate, the CHA-MPV2-8/9 pattern; orchestration-level changes via AOH's coordination boards).
  All other sibling projects (MathPilot, knowledge-showcase, Multica, pi-agent,
  travel-assistant) are read-only from every seat.
  **In this repo:** you are in the compass-health-agent seat — EDIT this repo; never modify
  `G:\pi-harness` or `G:\agent-orchestration-harness` from here.
- Follow THIS repo's own conventions (pnpm, its existing TS config), not pi-harness's.
- No commits without an explicit ask. No bulk deletion.

## Cross-repo impact rules (three-repo program)

This package sits at the bottom of a three-repo program and has **two consumers**:

- `G:\pi-harness` — imports the built `dist/` via its `file:../compass-health-agent` optional
  dependency and registers the `compass-health` profile
  (`pi-harness/src/agents/profiles/compass-health/`).
- `G:\agent-orchestration-harness` (AOH) — the outer orchestrator; uses this agent (running on
  pi-harness) as its live governance workload. Its scripts hardcode this repo's tool names, DB
  identifiers, and folder path.

Changes here that ripple outward — handle the ripple in the same change-set:

1. **The export surface is a locked contract** (`tests/contract/pi-harness-surface.test.ts`):
   `compassHealthProfileSpec`, `createToolContextFromEnv`, `initToolContext`,
   `tools/handlers` (the `handle*` functions and their signatures), `tools/context`
   (`ToolContext`, incl. `close`). Changing any of it means: (a) spec the pi-harness-side edit
   in `docs/pi-harness-pending-changes.md` (never edit pi-harness directly — its
   `src/agents/profiles/compass-health/*` and `types/compass-health-agent/` stubs must be
   updated by a pi-harness session), and (b) push the `codex/pi-harness-alignment` branch as
   described above so pi-harness CI stays green.
2. **pi-harness runs the built `dist/`, not `src/`.** After any change the host should see,
   run `pnpm build`; without it pi-harness executes stale code.
3. **Tool names and DB identifiers are consumed by BOTH siblings.** pi-harness embeds them in
   tool registrations and write scopes (`compass-health-agent://database/compass_health/...`);
   AOH hardcodes the seven read-only tool names in its PI adapter's
   `HEALTH_READ_ONLY_ALLOWED_TOOLS` and touches `compass_health.diet_logs` /
   `nutrition_estimate` in its governance smokes (`p21-shadow-run.mjs`,
   `p3-governed-write.mjs`). Renaming a tool, a table, or the `compass_health` Postgres schema
   is a **three-repo change** — do not do it unilaterally.
4. **`docs/status-report.jsonl` is this repo's outbox into AOH** — read by
   `agent-orchestration-harness/scripts/audit-ledger.mjs` at that exact path. Append-only
   JSONL; never rename, move, or reformat it.
5. **The folder path `G:\compass-health-agent` is load-bearing**: pi-harness's relative
   `file:` link and AOH's `COMPASS_HEALTH_ROOT` default both point at it. Don't move or rename
   the folder.
6. **`scheduledTasks` and `policy` in the profile spec are executed by pi-harness** (scheduler,
   permission gate) and assumed by AOH's governance (policy denies `destructive` + `network`).
   Loosening the policy or changing the cron surface is a cross-repo decision, not a local
   tweak.
