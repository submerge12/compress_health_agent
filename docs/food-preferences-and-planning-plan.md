# Plan: food-preference collection + meal-plan generation contract

Consolidated, codebase-grounded plan derived from the uploaded "Food Preference Collection and
Ingredient Selection Module" proposal, after pruning the parts that didn't fit this codebase. This
supersedes that proposal as the thing we build against.

## Decisions locked (from discussion)

- **Selection model, not a composer.** The planner keeps *selecting and portioning whole dishes*
  from a candidate pool (presets + user-added dishes). We are **not** building a raw-ingredient →
  dish generator. Users grow the pool by adding their own dishes (`propose_dish`/`save_dish`).
- **Low-burden collection.** Default basket + remove/add; defaults applied at generation time;
  refine later in conversation. **Allergies are the exception — gathered carefully up front.**
- **Categories are plain question headers**, not data the user selects; the user picks real foods.
- **Coverage checks are advisory**, never a gate.
- **Drop** the fixed "choose N per category" caps; drop the `UNAVAILABLE` status; keep
  cooking-method/flavor at the **dish** level, not on raw ingredients.
- **`weight_type` (raw/cooked/dry) is a precondition** for trustworthy macros, not a per-field
  afterthought (see §6).

## Status (this branch)

- **Phase 1 (interaction + basic safety) and Phase 2 (personalized macros + block-and-explain +
  coverage advisor): implemented.** Typecheck + non-DB tests green; DB-path e2e unverified (no Docker).
- **Fat ceiling is SOFT** (changed from the original hard proposal).
- Open items: (a) coverage advisor uses some hardcoded slug sets; (b) **sequencing caveat** — the hard protein/energy guarantees are
  only as trustworthy as the per-100g raw/cooked basis, which is not fixed until Phase 3 (§6). We are
  enforcing hard tiers against unaudited weight bases until then.

## 1. Generation contract (priority + enforcement)

Priority, highest first:

1. **Safety** — forbidden/allergy ingredients never appear. Absolute pre-filter.
2. **Daily protein floor** — **hard**.
3. **Daily energy band** — **hard**.
4. **Fat ceiling, personalized** (the user's `fatTargetGrams`) — **soft (high priority)**. Strongly
   steers dish selection and is surfaced as an advisory when exceeded, but **never blocks** plan
   generation (decided: hard fat + only the staple lever ⇒ too-frequent infeasibility; revisit if
   per-dish portion scaling lands).
5. Carbs / remaining macro fit — soft.
6. Variety & weekly coverage — soft.
7. Preferences (likes, flavor, cooking difficulty) — soft.

**Enforcement = block + explain (hard tiers only).** The generator must satisfy tiers **1–3** or, if
it cannot from the allowed pool, **stop and explain the conflict and offer to relax** (e.g. add a
lean protein, lower the protein target) — never silently emit a plan that breaches a *hard* tier.
This replaces today's flag-and-return. **Fat (tier 4) is soft:** it is weighted heavily in selection
(`comboScore`) and in `scorePlan`, and reported via `validateWeeklyMealPlan` as an advisory, but a
fat overage alone will not block a plan.

**Portion lever:** tiers 2–3 are only jointly satisfiable with a portion knob (and the fat soft-target
is easier to honor with one too). Use the existing **staple portion lever** in the meal-composition
model as the primary knob; per-dish scaling is an optional later refinement. If fat is ever promoted
back to hard, a portion lever becomes mandatory or "block + explain" fires constantly.

## 2. Where today's engine stands (grounding)

- Pre-filter removes forbidden/rejected/ wrong-role dishes (`recipe-engine.ts`, `meal-planner.ts:filterUsableCandidates`).
- Hard `protein_floor` + `energy_band` violations exist but are **flagged, not blocking**
  (`meal-planner.ts:320`).
- Fat/carbs are scored toward a **hardcoded 30%/45% split** (`meal-plan-scoring.ts:106`), **not** the
  user's `fatTargetGrams` — this is why low-fat goals aren't honored.
- Preferences: `loadUserPreferences` already yields `rejectedSeasonings` / `rejectedIngredients`
  (hard filter) and `preferredIngredients` (ranking bonus), sourced from `dislike` / `preference`
  memories.

## 3. Preference status model

Collapse the proposal's 5-status enum to what consumers can actually use:

| Proposal status | This system | Storage |
|---|---|---|
| LIKE | preferred ingredient (ranking bonus) | `remember(kind "preference")` |
| DISLIKE / FORBIDDEN | hard-excluded ingredient | `remember(kind "dislike")` today (both hard) |
| ACCEPT | the default — *no memory needed* | — |
| UNAVAILABLE/can't cook | split: skill → cooking difficulty (§5/P3); inventory → not stored (transient) | — |

Note: dislike and allergy both **hard-exclude** today, which is safe. A *soft* "avoid but rotate
occasionally" tier (true DISLIKE≠FORBIDDEN) would require a new memory kind → a `remember` param
change → **pi-harness edit**. Deferred unless wanted.

## 4. Interaction model (chat, not GUI)

Reframe the proposal's "frontend screens" as agent turns:

- **Default basket + remove/add** as the primary path; "use defaults for me" always offered.
- Per-category confirmation uses **plain headers** (staples / proteins / vegetables / fruits / fats /
  flavors), each presenting a short list of *real foods* — no fixed count, no >10–12 dump.
- **Allergies first and carefully:** explicitly ask for allergies/medical/religious restrictions
  before preferences; on any ambiguous phrasing ("seafood doesn't work for me") **ask allergy vs.
  dislike** before acting.
- Wording is suggestive, never blaming; never force fruit/vegetables.

All of this lives in `src/agent.ts` `systemPrompt` → flows to pi-harness via `pnpm build`.

## 5. Phases (with file/tool mapping)

### Phase 1 — Interaction + basic safety (prompt-only; no pi-harness edit)
- Rework onboarding into the basket + remove/add + per-category interview; allergy-first +
  ambiguity confirmation; no-blame wording; don't-force-fruit. — `src/agent.ts`.
- Explicitly named dislikes/allergies → `remember(kind "dislike")` → already hard-excluded by
  `loadUserPreferences`. Likes → `remember(kind "preference")` → bonus. (No code change; the wiring
  exists.)
- For "I hate boiled chicken breast" (Case 15) / flavor prefs (Case 17): store flavor/method as a
  preference and recommend flavored dish variants — dish-level, uses existing dish `method`/seasonings.

### Phase 2 — Personalized macros + block-and-explain + coverage advisor (in-repo engine) — IMPLEMENTED
- Personalize fat/carbs: replace the 30%/45% generic split with the user's `fatTargetGrams` /
  `carbsTargetGrams` (fat = one-sided soft ceiling penalty, carbs two-sided; generic split as
  fallback). — `meal-plan-scoring.ts`.
- Priority contract + **block-and-explain for hard tiers (1–3 only)**: planner throws
  `MealPlanInfeasibleError` with `reason` + `suggestions` for protein-floor / energy-band / safety /
  candidate-pool failures; `generate-meal-plan.ts` catches it and returns `cannotSatisfy`. **Fat is
  soft** — steered in `comboScore`, surfaced by `validateWeeklyMealPlan` as advisory, not a blocker.
- **Coverage advisor** (advisory only) in `plan-advisory.ts`. NOTE: it currently keys off some
  hardcoded slug sets (`LEAFY_SLUGS`, `CRUCIFEROUS_SLUGS`); prefer `category`/`executionBuckets` so
  it doesn't miss new/user foods.
- **Prompt relays `cannotSatisfy`** (workflow step 6): the agent explains `reason`, offers
  `suggestions`, refuses to relax allergies, and mentions the fat advisory as non-blocking. The
  "explain" half of block-and-explain is now wired.
- **Coverage advisor** (advisory only): min-coverage check (leafy / cruciferous / mushroom /
  low-fat-protein balance) over the user's accepted pool, using existing `category`/`executionBuckets`.
  Surfaced by the agent as a suggestion (Cases 8, 9). Fold into an existing handler's return to avoid
  a new tool; a standalone coverage **tool** would need a pi-harness edit.

### Phase 3 — Allergen taxonomy + ingredient data model + weight basis (data + schema; invasive)
- **Allergen taxonomy:** `allergen_tags` on foods + group expansion (seafood→fish/shrimp/shellfish/
  dried-shrimp; soy; nuts; dairy) + dish-level checking of *every* ingredient incl. hidden ones
  (dried shrimp in a sauce). Conservative + confirmed. — `schema.ts` (foodItems), `seed`/`data`,
  `recipe-engine`/`meal-planner` filters. Cases 3, 5, 6, 12.
- **`weight_type` precondition** (§6). Cases 11, 13.
- **Targeted ingredient fields only where a consumer exists:** `frequency_hint` (chicken liver =
  weekly, Case 14), cooking `difficulty`/`availability` (microwave-only user, Case 16),
  special-ingredient handling (konjac = filler not a vegetable Case 13; dried shrimp = seasoning/
  high-sodium not a main protein Case 12). — `schema.ts` + classification.
- Likely **pi-harness edits** here (new tool params for structured capture and/or new dish fields) →
  record in `pi-harness-pending-changes.md`.

## 6. `weight_type` precondition — blast radius

Nutrition is `grams × per-100g` (`engine/nutrition.ts`). A raw/cooked/dry basis must agree at every
producer of grams or per-100g:

1. Reference data — `food_items` per-100g basis must be declared; audit seed/CSV (`src/data`, `seed.ts`).
2. Logging (`log_meal`→`nutrition-estimate`) — user weights are usually cooked; table is raw.
3. Natural units (`natural-units`, `naturalUnits`) — "1 cup cooked rice" vs raw per-100g (gnarliest).
4. Dish definitions (`preset-dishes.ts`, `add-dish`) — recipe grams basis vs per-100g.
5. Procurement / thaw — want raw/purchase weight.
6. Display / portions (`common_portion`, i18n) — state basis or convert.
7. Conversion data (new) — per-food yield factors only for big-gap items (rice, oats, dried beans,
   dried mushrooms, meats).

Cheapest sane version: pick **one canonical basis (raw per-100g)**, declare it, add a logging
convention, add yield factors only where the gap is large.

## 7. pi-harness boundary

- **Phase 1:** none — prompt + existing tools, ships via `pnpm build` (pi-harness imports
  `compassHealthProfileSpec.systemPrompt` + handlers).
- **Phase 2:** none, *if* coverage/infeasibility ride on existing handler returns. A new standalone
  tool would need a `tools.ts` edit.
- **Phase 3:** likely tool param changes + a schema migration on the `compass_health` schema →
  pi-harness edits; add to `pi-harness-pending-changes.md`.

## 8. Test cases → phase

| # | Case | Phase |
|---|---|---|
| 1 | accept default basket | 1 |
| 2 | "use defaults for me" | 1 |
| 10 | no fruit (don't force) | 1 |
| 15 | dislikes boiled chicken breast → flavored variants | 1 |
| 17 | likes spicy/sour-spicy/cumin | 1 (store) / 3 (dish flavor tags if needed) |
| 18 | avoid long-list fatigue | 1 |
| 19 | natural-language parsing | 1 |
| 20 | ambiguous "seafood doesn't work" → confirm | 1 (confirm) / 3 (group exclude) |
| 7 | high-protein low-fat, fatty only → explain | 2 |
| 8 | only staples, no protein | 2 |
| 9 | only cucumber/tomato veg | 2 |
| 3 | seafood allergy (group) | 3 |
| 4 | lactose intolerance (limited) | 3 |
| 5 | soy allergy (group) | 3 |
| 6 | nut allergy (group) | 3 |
| 11 | red/mung/black bean classification + dry weight | 3 |
| 12 | dried shrimp = seasoning/high-sodium | 3 |
| 13 | konjac = filler, not a vegetable | 2 (advisory) / 3 (tag) |
| 14 | chicken liver = weekly frequency | 3 |
| 16 | microwave-only / can't cook | 3 (difficulty) / 1 (prompt) |

## 9. Non-goals / explicitly out

- Raw-ingredient → dish **composer** (we select+portion existing dishes).
- A GUI; this is a chat agent.
- Per-ingredient cooking-method/flavor matrices (kept at dish level).
- A full raw↔cooked conversion matrix (only big-gap yield factors).
- The soft "rotate occasionally" ACCEPT tier (deferred; needs a new memory kind = pi-harness edit).

## 10. Recommended start

Phase 1 — it's the allergy-safety + interaction win, almost entirely `src/agent.ts` prompt work,
needs no pi-harness edit, and ships via `pnpm build`.
