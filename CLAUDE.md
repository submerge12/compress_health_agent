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

### Boundaries
- EDIT this repo. **NEVER modify `G:\pi-harness`** from here — it is the read-only framework.
- Follow THIS repo's own conventions (pnpm, its existing TS config), not pi-harness's.
- No commits without an explicit ask. No bulk deletion.
