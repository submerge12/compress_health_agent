# pi-harness changes — unified plan

**Status:** To apply on the `pi-harness` side. `pi-harness` is read-only from the
compass-health-agent session, so these edits must be made in a pi-harness session.
**Scope of this plan:** every pi-harness-side change implied by the recent compass-health work —
the add-dish role fields, user-preference wiring, the get_profile rehydration tool, and the
returning-user prompt flow.

## TL;DR

Only **two tool-surface edits** to `pi-harness/src/agents/profiles/compass-health/tools.ts` are
required:

1. **Add dish-role fields** to `propose_dish` / `save_dish` params.
2. **Register the new `get_profile`** read-only tool.

**Everything else flows automatically via `pnpm build` of this repo** — no pi-harness edit. That
includes the entire user-preference feature, the `get_profile` *handler*, and all *prompt* changes
(dislike onboarding + the "call get_profile at the start" step), because pi-harness's profile
imports them from the package:

```ts
// pi-harness/src/agents/profiles/compass-health/profile.ts
import { compassHealthProfileSpec, createToolContextFromEnv } from "compass-health-agent";
import * as handlers from "compass-health-agent/tools/handlers";
systemPrompt: compassHealthProfileSpec.systemPrompt,   // ← prompt comes from this repo
```

## Rule of thumb

`pi-harness` only needs editing when a **tool is added/removed** or an existing tool's
**parameters change**. Handler logic, scoring, presets, classification, prompts, and the system
prompt do **not** require a pi-harness edit — just a `pnpm build` of this repo so the framework's
`file:` link picks up the new `dist`.

---

## Change 1 — add the dish-role fields to `propose_dish` / `save_dish`

The option-B work added `role` / `sideKind` / `selfContained` to the add-dish contract
(`src/tools/add-dish.ts`). `tools.ts` does not declare them, so the framework drops them: the LLM
cannot create **side** dishes or **non-self-contained** mains (ordinary main saves still work,
because this repo defaults missing `role`/`selfContained` to a self-contained main).

### Add the literal unions
```ts
const dishRole = Type.Union([Type.Literal("main"), Type.Literal("side")]);
const sideKind = Type.Union([Type.Literal("vegetable"), Type.Literal("soup")]);
```

### Extend `dishDraftParams` (propose_dish) — all optional
```ts
const dishDraftParams = Type.Object({
  name: Type.String(),
  mealCategory: dishMealCategory,
  role: Type.Optional(dishRole),                 // + add
  sideKind: Type.Optional(sideKind),             // + add
  selfContained: Type.Optional(Type.Boolean()),  // + add
  ingredients: Type.Array(dishDraftIngredientParams),
  seasonings: Type.Optional(Type.Array(Type.String())),
  method: Type.Optional(Type.String()),
  source: dishSource,
  notes: Type.Optional(Type.String()),
});
```

### Extend `saveDishParams` — expose the same optional role metadata
```ts
const saveDishParams = Type.Object({
  name: Type.String(),
  mealCategory: dishMealCategory,
  role: Type.Optional(dishRole),                 // + add
  sideKind: Type.Optional(sideKind),             // + add
  selfContained: Type.Optional(Type.Boolean()),  // + add
  ingredients: Type.Array(resolvedDishIngredientParams),
  seasonings: Type.Array(Type.String()),
  method: Type.Optional(Type.String()),
  source: dishSource,
  notes: Type.Optional(Type.String()),
  slug: Type.String(),
  nutrition: dishNutritionParams,
  buckets: Type.Array(Type.String()),
  roles: Type.Array(Type.String()),
  unresolved: Type.Array(Type.String()),
});
```

No handler change — still delegates to `handlers.handleProposeDish` / `handleSaveDish`.

---

## Change 2 — register the new `get_profile` read tool

This repo added a read-only `get_profile` tool (`handlers.handleGetProfile`) so the agent can detect
a returning user and skip re-onboarding. The handler and the prompt step that calls it already ship
via the package, but `tools.ts` doesn't declare the tool, so the framework won't expose it — and the
prompt's "call get_profile at the start" step would have no tool to call (silently falling back to
onboarding; old behavior, not broken).

### Add the params (no input)
```ts
const getProfileParams = Type.Object({});
```

### Add the registration inside `createCompassHealthToolRegistrations()`
Match the file's existing entry shape (the `execute` signature/`jsonResult`/`requireCtx` helpers are
already used by every other tool):
```ts
{
  tool: {
    name: "get_profile",
    label: "Get Profile",
    description: "Read the user's saved profile and calorie/macro targets; returns null if none exists yet.",
    parameters: getProfileParams,
    async execute(_toolCallId, params) {
      return jsonResult(await handlers.handleGetProfile(requireCtx(), params));
    },
  },
  accessLevel: "read-only",
},
```

---

## Change 3 — register the new `swap_meal` write tool (V2-P5)

> **AMENDED 2026-07-06 (CHA-MPV2-8, G2 decision HD-CHAMPV2-8-G2-SWAP-TOOL-SURFACE):** swap
> semantics are now BOUNDED — the target must be one of the entry's pre-vetted alternates;
> free-form substitution is rejected CHA-side with a clear error naming the currently
> pre-vetted swaps. If the original Change 3 was already applied, only the `description`
> string and the schema comment below need updating (wiring is unchanged); node 9 applies /
> verifies this in a PI session.

The rotation-planner v2 work added per-entry pre-vetted `alternates` to `generate_meal_plan` output
(pass-through JSON, no pi-harness change) and a new write tool `swap_meal`
(`handlers.handleSwapMeal`) that swaps a planned lunch/dinner to ONE OF ITS PRE-VETTED ALTERNATES
and re-balances the day's staple and protein top-ups. The bounded semantics are enforced CHA-side
(A2 repair, 2026-07-06): the target must belong to the WEEK'S SELECTED POOL — derived at swap time
through the same `buildPoolRequest` → `selectWeeklyPool` wiring generation uses, which also
carries the skipped-≥2 (`avoidedDishSlugs`) exclusion — plus safety filters, same-day/adjacent-day
rotation collisions, minimal weekly use count, and hard day gates re-levered through the
production path. The full dish catalog is NOT the candidate set. The handler, prompt step 6b, and
the repository method all ship via the package; only the tool registration is pi-harness-side.
Write scope: `meal_plan_entries` rows only, via the repository layer (`accessLevel: "write"`).

### Add the params
```ts
const swapMealParams = Type.Object({
  date: Type.String(),          // YYYY-MM-DD
  mealType: Type.String(),      // "lunch" | "dinner"
  alternateSlug: Type.String(), // MUST be one of the entry's pre-vetted alternates; others are rejected
});
```

### Add the registration inside `createCompassHealthToolRegistrations()`
```ts
{
  tool: {
    name: "swap_meal",
    label: "Swap Meal",
    description: "Swap a planned lunch/dinner to one of its pre-vetted alternates and re-balance the day's staple and protein. Non-alternate targets are rejected.",
    parameters: swapMealParams,
    async execute(_toolCallId, params) {
      return jsonResult(await handlers.handleSwapMeal(requireCtx(), params));
    },
  },
  accessLevel: "write",
},
```

Verification: generate a plan, pick a lunch entry's alternate, call `swap_meal`, then confirm the
entry row shows the new dish and `meal_checkin` still attaches to it ("换一个 round-trips"). Also
confirm the bounded rejection: calling `swap_meal` with a main that is NOT one of the entry's
alternates (e.g. a dish already planned on the adjacent day) must return the "not one of this
entry's pre-vetted alternates" error rather than writing.

---

## What does NOT need a pi-harness change (already done in this repo)

Reaches the framework via `pnpm build` only:

- **User preferences** — onboarding now asks for disliked foods/seasonings and stores them with the
  existing `remember` tool; `loadUserPreferences` derives rejected ingredients/seasonings from active
  `dislike` memories; the recipe engine now applies a `rejectedIngredients` hard filter; `context`
  exposes a name-bearing `seasoningCatalog`. All internal — `remember`/`recall` are already
  registered in `tools.ts`.
- **The `get_profile` handler and the returning-user prompt flow** — handler is exported; prompt is
  imported via `compassHealthProfileSpec.systemPrompt`.
- Floor-sourcing fix, weekly-floor config, meal-composition model, option-B planner logic,
  plant-protein presets, dish-name cleanups, all scoring/coverage/procurement changes.

## Out of scope (separate track)

The Claude-Code-style CLI TUI is a much larger, framework-wide pi-harness change tracked separately
in [`pi-harness-tui-spec.md`](./pi-harness-tui-spec.md). It is independent of the two tool-surface
edits above.

---

## Phase 3 food-safety/data-model follow-up

The compass-health-agent repo now includes an in-repo Phase 3 migration:
`drizzle/0002_food_safety_basis.sql`.

This does **not** require a `tools.ts` edit as long as the design stays on the low-burden path:
allergy groups continue to use free-text `remember(kind: "dislike")`, weight basis is inferred from
catalog data and surfaced as warnings, and dish metadata is derived from ingredients instead of being
set through new tool parameters.

The remaining pi-harness-side work is operational only:

1. Apply the compass-health schema migration in the pi-harness environment.
2. Re-seed/reference-refresh so existing `food_items` rows receive `allergen_tags`, `weight_type`,
   `frequency_hint`, and `special_handling_tags`.
3. Rebuild the compass-health-agent package consumed by pi-harness.

Do not add a new `remember` kind, `weight_basis` tool parameter, or extra settable dish fields unless
the tool surface is intentionally expanded in a separate pi-harness change.

---

## Execution checklist (the pi-harness session)

1. `cd compass-health-agent && pnpm build` — publish current `dist`.
2. Apply **Change 1** to `tools.ts` (the two unions + the two schema extensions).
3. Apply **Change 2** to `tools.ts` (the `get_profile` params + registration).
4. `cd pi-harness && npm run typecheck && npm test && npm run build`.
5. Verify end-to-end:
   - add-dish can create a `side` dish (`role:"side"`, `sideKind:"vegetable"`) and a
     non-self-contained main (`selfContained:false`) and they persist.
   - `get_profile` is callable; a returning user is greeted with their targets and **not**
     re-onboarded.
   - a stated dislike actually removes a dish from a recommendation (preferences round-trip).

## How to refresh this plan

Before the pi-harness session, re-diff the tool surface:
- **New/removed tools:** compare `src/agent.ts` tool metadata (this repo) vs the `name:`
  registrations in `pi-harness/.../tools.ts`. Known gaps today: `get_profile` (Change 2).
- **Param drift:** compare each tool's input interface here vs its `*Params` TypeBox schema there.
  Known drift today: add-dish (Change 1).
