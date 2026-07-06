# Execution Plan — Option B: Single Source of Truth (compass-health-agent ↔ pi-harness)

**Date:** 2026-06-25
**Status:** Ready to execute
**Approach:** Option B — make `compass-health-agent` the single source of truth for all domain
metadata and behavior; reduce the framework's profile to a thin adapter.
**Sequence:** **A** — the repo (Plan 1) lands first as additive, backward-compatible changes; then
`pi-harness` (Plan 2) flips over against the already-published exports. The tree stays green at every
step.
**Resolved decision:** Keep the `🧊` thaw emoji, moved into the repo i18n template as the single source.

---

## 0. Why both repos change

The new proactive logic (`handleProactiveCheck`, category-derived thaw, localization) is already
implemented in this repo but **orphaned**: `pi-harness` defines its own `compass-health` profile and
never imports the repo's `profile`/`handleProactiveCheck`. Repo-only changes (Plan 1) are necessary but
not sufficient — the framework must be edited (Plan 2) to delegate to the repo. This is inherent to the
architecture: the framework owns the invocation point (`AgentProfile.proactiveCheck`) and profile
assembly.

### Ownership after refactor

| Concern | Owner |
|---|---|
| `systemPrompt`, `description`, `model`, `thinkingLevel`, `policy`, `compactionInstructions`, `scheduledTasks` | **compass-health-agent** (plain data via `compassHealthProfileSpec`) |
| Proactive behavior (meal selection, thaw look-ahead, meat detection, message text, localization) | **compass-health-agent** (`handleProactiveCheck`) |
| Env → DB context construction | **compass-health-agent** (`createToolContextFromEnv`) |
| TypeBox tool registrations | **pi-harness** (`tools.ts`) — needs framework types; not duplicated |
| Profile assembly, module-state plumbing (`setToolContext`/`getToolContext`), `satisfies AgentProfile` | **pi-harness** (`profile.ts`) |

---

## Export contract (the interface both sides agree on)

```ts
// from "compass-health-agent" (root export)
export interface CompassHealthProfileSpec {
  name: "compass-health";
  description: string;
  systemPrompt: string;
  model: { provider: "deepseek"; modelId: string };
  thinkingLevel: "low" | "medium" | "high";
  policy: { defaults: { "read-only": "allow"; write: "allow"; destructive: "deny"; network: "deny" } };
  context: { compactionInstructions: string };
  scheduledTasks: readonly {
    id: string; agentProfile: "compass-health"; taskType: "proactive_check"; schedule: { cron: string };
  }[];
}
export const compassHealthProfileSpec: CompassHealthProfileSpec;
export function createToolContextFromEnv(): Promise<ToolContext>;

// from "compass-health-agent/tools/handlers" (already exists)
export function handleProactiveCheck(ctx: ToolContext): Promise<ProactiveCheckResult>; // use .message
```

Verified structurally compatible with framework types: `AgentModelDefault`, `PermissionPolicy`
(`defaults: Record<ToolAccessLevel, PermissionLevel>`), `ScheduledTaskDefinition`, `ThinkingLevel`
(includes `"medium"`), `KnownProvider` (includes `deepseek`), `AgentProfileInstall`.

---

# PLAN 1 — compass-health-agent (execute FIRST)

Additive and backward-compatible. The current, unmodified `pi-harness` keeps building against the
rebuilt `dist`.

### Step 1.1 — Extract `createToolContextFromEnv()`
- **File:** `src/agent.ts`
- **Change:** Move the env-var logic out of `installCompassHealthAgent()` into a new exported function;
  have `installCompassHealthAgent()` call it (identical behavior).
```ts
export async function createToolContextFromEnv(): Promise<ToolContext> {
  return initToolContext({
    externalUserId: process.env["COMPASS_HEALTH_USER_ID"] ?? "default-user",
    locale: localeFromEnv(process.env["COMPASS_HEALTH_LOCALE"]),
    databaseUrl: process.env["COMPASS_HEALTH_DATABASE_URL"] ?? process.env["DATABASE_URL"],
    timezone: process.env["COMPASS_HEALTH_TIMEZONE"],
  });
}
// installCompassHealthAgent(): const ctx = await createToolContextFromEnv(); installedToolContext = ctx; ...
```

### Step 1.2 — Add the exported spec; compose `profile` from it
- **File:** `src/agent.ts`
```ts
export interface CompassHealthProfileSpec {
  name: "compass-health";
  description: string;
  systemPrompt: string;
  model: AgentModelRegistration;
  thinkingLevel: "low" | "medium" | "high";
  policy: AgentPolicy;
  context: { compactionInstructions: string };
  scheduledTasks: readonly ScheduledTaskRegistration[];
}

export const compassHealthProfileSpec: CompassHealthProfileSpec = {
  name: "compass-health",
  description: "Bilingual health and nutrition agent: meal logging, calorie tracking, weekly meal plans.",
  systemPrompt,
  model: { provider: "deepseek", modelId: "deepseek-v4-pro" },
  thinkingLevel: "medium",
  policy: { defaults: { "read-only": "allow", write: "allow", destructive: "deny", network: "deny" } },
  context: {
    compactionInstructions:
      "Preserve the user's profile (sex, age, height, weight, goal), today's logged meals and their nutrition, daily targets, and any pending meal-plan check-ins.",
  },
  scheduledTasks: [ /* existing 4 proactive_check tasks, moved here verbatim */ ],
};

export const profile: AgentProfileCompatible = {
  ...compassHealthProfileSpec,
  tools: [...readOnlyTools, ...writeTools],
  proactiveCheck,
  install: installCompassHealthAgent,
  skills: [],
  templates: [],
};
```
- `validateAgentProfile` unchanged.

### Step 1.3 — Re-export from the package root
- **File:** `src/index.ts`
```ts
export { profile, compassHealthProfileSpec, createToolContextFromEnv, systemPrompt,
         type CompassHealthProfileSpec } from "./agent.js";
```
- **File:** `package.json` — no change (root `.` export already maps to `dist`).

### Step 1.4 — Move the `🧊` emoji into the template
- **File:** `src/i18n.ts` — prepend `🧊 ` to both `proactiveThawReminder` variants:
  - zh: `🧊 解冻提醒：${items}。请提前把冷冻食材取出解冻。`
  - en: `🧊 Thaw reminder: ${items} — take the meat out of the freezer to thaw in advance.`
- **File:** `src/tools/handlers.ts` — no change (renders via this template; emoji flows automatically).

### Step 1.5 — Update guarding tests
- **File:** `tests/i18n.test.ts` — assert `proactiveThawReminder` renders with leading `🧊` (zh + en).
- **File:** `tests/handlers/proactive-check.test.ts` — strengthen thaw assertion to
  `expect(result.message).toContain("🧊 Thaw reminder")`.
- **File:** `tests/contract/pi-harness-surface.test.ts` — assert `compassHealthProfileSpec`
  (`model.provider === "deepseek"`, `thinkingLevel === "medium"`, `policy.defaults.destructive/network === "deny"`,
  4 `proactive_check` tasks) and `typeof createToolContextFromEnv === "function"` (`.length === 0`).
- **File:** `tests/smoke/resolve-package-exports.mjs` — assert `root.compassHealthProfileSpec` is an
  object and `typeof root.createToolContextFromEnv === "function"`.

### Tests to run
```
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:exports
```

### Acceptance criteria
- `pnpm typecheck` → exit 0.
- `pnpm test` → all previously-passing tests green (≥111) plus new assertions; 0 failures.
- `pnpm build` + `pnpm smoke:exports` → exit 0; new root exports resolve from `dist`.
- `compassHealthProfileSpec` and `createToolContextFromEnv` importable from `compass-health-agent`.
- Repo proactive thaw output contains `🧊 Thaw reminder` / `🧊 解冻提醒` from the template (no emoji
  literal in handler code).
- Backward compatible: `profile`, `handlers.*`, `initToolContext` unchanged in shape.

---

# PLAN 2 — pi-harness (execute SECOND, after Plan 1 is built)

Pre-req: `compass-health-agent` has been rebuilt (`pnpm build`) so `dist` carries
`compassHealthProfileSpec` + `createToolContextFromEnv` (linked via `file:../compass-health-agent`).

### Step 2.1 — Rewrite the profile into a thin adapter
- **File:** `src/agents/profiles/compass-health/profile.ts`
- **Delete:** `MEAT_SLUGS`, `findMeatIngredients`, `todayIso/yesterdayIso/tomorrowIso`, the inline
  `scheduledTasks`, the inline `proactiveCheck` body, and the hardcoded
  `model`/`policy`/`description`/`context`/`systemPrompt` import.
- **Replace whole file with:**
```ts
import type { AgentProfile } from "../../profile.ts";
import { compassHealthProfileSpec, createToolContextFromEnv } from "compass-health-agent";
import * as handlers from "compass-health-agent/tools/handlers";
import { createCompassHealthToolRegistrations, setToolContext, getToolContext } from "./tools.ts";

export { createCompassHealthToolRegistrations } from "./tools.ts";

export const compassHealthProfile = {
  name: compassHealthProfileSpec.name,
  description: compassHealthProfileSpec.description,
  systemPrompt: compassHealthProfileSpec.systemPrompt,
  model: compassHealthProfileSpec.model,
  thinkingLevel: compassHealthProfileSpec.thinkingLevel,
  policy: compassHealthProfileSpec.policy,
  context: compassHealthProfileSpec.context,
  scheduledTasks: compassHealthProfileSpec.scheduledTasks,
  tools: [() => createCompassHealthToolRegistrations()],
  proactiveCheck: async (): Promise<string> => {
    const ctx = getToolContext();
    if (!ctx) return "Compass Health agent not initialized.";
    return (await handlers.handleProactiveCheck(ctx)).message;
  },
  install: async () => {
    const ctx = await createToolContextFromEnv();
    setToolContext(ctx);
    return async () => { await ctx.close(); };
  },
  skills: [],
  templates: [],
} satisfies AgentProfile;

export default compassHealthProfile;
```

### Step 2.2 — Delete the duplicated prompt
- **File:** `src/agents/profiles/compass-health/prompt.ts` → **delete** (only importer was `profile.ts`).

### Step 2.3 — Clean the now-unused value import
- **File:** `src/agents/profiles/compass-health/tools.ts`
- **Change:** line 6 → `import type { ToolContext } from "compass-health-agent/tools/context";`
  (drop the unused `initToolContext` value import). Tool registrations unchanged.

### Step 2.4 — Confirm the registry needs no change
- **File:** `src/agents/profiles/index.ts` — verify only (imports `compassHealthProfile` +
  `createCompassHealthToolRegistrations`, both still exported). No edit expected.

### Step 2.5 — Sweep for dangling references
```
grep -rn "MEAT_SLUGS\|findMeatIngredients\|compass-health/prompt\|from \"./prompt" src test
```
Expect no matches. Update any test asserting old compass prompt/model literals to read from
`compassHealthProfileSpec`.

### Tests to run
```
npm run typecheck      # tsc --noEmit
npm test               # vitest --run
npm run build          # tsc -p tsconfig.build.json
```
Watch: `test/agent-profiles-builtins.test.ts`, `test/scheduler/scheduler.test.ts`,
`test/agents-profile.test.ts` (current scans show none assert compass-health prompt/meat content).

### Acceptance criteria
- `npm run typecheck` + `npm run build` → exit 0; `compassHealthProfile` still `satisfies AgentProfile`.
- `npm test` → green (no regressions).
- `prompt.ts` deleted; Step 2.5 grep returns nothing.
- `registerBuiltInProfiles()` still registers `compass-health`.
- After `install()`, `proactiveCheck()` returns the localized string from the repo (zh default), with the
  `🧊` thaw reminder when upcoming meals contain `meat`/`poultry`/`seafood` ingredients (category-derived).
- No domain duplication remains in the framework: prompt, model/policy, scheduled tasks, proactive
  behavior, and meat detection live only in `compass-health-agent`.

---

## Optional hardening (after both land)
- Add a pi-harness test asserting `compassHealthProfile.systemPrompt` contains `"Hard Rules"` and
  `proactiveCheck()` returns a `string`, locking the delegation contract.
- Wire `pnpm smoke:exports` into CI so the repo's published surface is guarded automatically.

---

## Execution order

1. **Plan 1 — compass-health-agent (this repo).** Apply Steps 1.1 → 1.5.
2. **Build + verify the repo.** `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm smoke:exports`.
   All must pass. This publishes the new exports into `dist`.
3. **Confirm `dist` is current** (the `file:../compass-health-agent` link means pi-harness consumes it
   directly).
4. **Plan 2 — pi-harness.** Apply Steps 2.1 → 2.5.
5. **Build + verify the framework.** `npm run typecheck` → `npm test` → `npm run build`. All must pass.
6. **End-to-end check.** Install the agent and trigger a proactive check; confirm localized output and the
   `🧊` category-derived thaw reminder.
7. **(Optional) Hardening** above.

> Do not start Plan 2 until Plan 1's build/verify (steps 2–3) is green — pi-harness imports resolve from
> the repo's `dist`.
