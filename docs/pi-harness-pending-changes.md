# Pending pi-harness changes

**Status:** To apply on the `pi-harness` side **after** the health-agent work is finished.
**Why this file:** track tool-surface changes made in `compass-health-agent` that the framework hasn't caught up to yet. (Domain/logic changes need no pi-harness edit — only tool *surface* changes do. See the "what does NOT need pi-harness" list below.)

## Rule of thumb
`pi-harness` only needs editing when a **tool is added/removed** or an existing tool's **parameters change**. Handler logic, scoring, presets, classification, etc. do **not** require a pi-harness edit — just a `pnpm build` of this repo so the framework's `file:` link picks up the new `dist`.

---

## Pending change (1) — add the dish-role fields to `propose_dish` / `save_dish`

The option-B work added `role` / `sideKind` / `selfContained` to the add-dish contract in this repo (`src/tools/add-dish.ts`):
- `DishDraft` (propose_dish input): optional `role`, `sideKind`, `selfContained`.
- `ResolvedDish` (save_dish input): optional `role`, optional `sideKind`, optional `selfContained`.

`pi-harness/src/agents/profiles/compass-health/tools.ts` does **not** yet declare these, so the framework would drop them. This repo now defaults missing `role` / `selfContained` to a self-contained main, so ordinary main-dish saves still round-trip. The remaining impact is capability loss: the LLM cannot create **side** dishes or **non-self-contained** mains until these fields are exposed.

**Not broken, but incomplete:** main-dish add-dish still works; only sides / non-self-contained mains are unreachable until this lands.

### Edit `tools.ts` — add the literal unions
```ts
const dishRole = Type.Union([Type.Literal("main"), Type.Literal("side")]);
const sideKind = Type.Union([Type.Literal("vegetable"), Type.Literal("soup")]);
```

### Extend `dishDraftParams` (propose_dish) — all optional
```ts
const dishDraftParams = Type.Object({
  name: Type.String(),
  mealCategory: dishMealCategory,
  role: Type.Optional(dishRole),            // + add
  sideKind: Type.Optional(sideKind),        // + add
  selfContained: Type.Optional(Type.Boolean()), // + add
  ingredients: Type.Array(dishDraftIngredientParams),
  seasonings: Type.Optional(Type.Array(Type.String())),
  method: Type.Optional(Type.String()),
  source: dishSource,
  notes: Type.Optional(Type.String()),
});
```

### Extend `saveDishParams` — expose the optional role metadata
```ts
const saveDishParams = Type.Object({
  name: Type.String(),
  mealCategory: dishMealCategory,
  role: Type.Optional(dishRole),            // + add
  sideKind: Type.Optional(sideKind),        // + add
  selfContained: Type.Optional(Type.Boolean()), // + add
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

No handler change on the framework side — it still delegates to `handlers.handleProposeDish` / `handleSaveDish`.

---

## What does NOT need a pi-harness change (done in this repo)
- Floor-sourcing fix, weekly-floor config.
- Meal-composition model (dish / staple / side separation, staple kcal-lever).
- Option-B side/soup composition + planner logic.
- Plant-protein presets (tofu mains, soy-milk breakfasts) + `tofu`/`soy_milk` seed slugs.
- Protein-only dish-name cleanups.
- All scoring / coverage / procurement changes.

These are internal logic or code-level data — the framework picks them up via `pnpm build` of this repo.

---

## Checklist for the eventual pi-harness session
1. `cd compass-health-agent && pnpm build` (publish current `dist`).
2. Apply Pending change (1) to `tools.ts` (the two schemas + the two unions).
3. (If new tools were added since — e.g. a future `suggest_dishes` or reminder tool — register them too. None pending today.)
4. `cd pi-harness && npm run typecheck && npm test && npm run build`.
5. Verify add-dish can now create a `side` dish end-to-end.

## How to refresh this note
Before the pi-harness session, re-diff the tool surface:
- New/removed tools: compare `src/agent.ts` tool metadata (this repo) vs the `name:` registrations in `pi-harness/.../tools.ts`.
- Param drift: compare each tool's input interface here vs its `*Params` TypeBox schema there. The known drift today is only add-dish (above).
