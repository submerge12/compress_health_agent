# Add-Dish Ingestion Spec

**Status:** Draft for implementation
**Scope:** Let users add their own dishes to `compass-health-agent` so they become meal-plan candidates.
**Context:** Today the planner only ever sees the 14 code presets — the `update_cooking_record` path captures a single ingredient with no nutrition and is filtered out (`candidate-loader.ts` requires `caloriesKcal > 0`). This spec replaces that with a real dish-ingestion path.

## Goals

1. **Now:** a user describes a dish in natural language → the agent parses it → presents a structured draft → **user approves** → it's saved and becomes a planner candidate.
2. **Reserved:** the same save path accepts a **pre-structured** dish from the *main agent* (which will later research/process videos, articles, or eaten dishes). We build the interface seam now, not the research pipeline.

## Core principle — one structured target, two entry points

Both the NL path and the future main-agent path converge on the **same `DishDraft`** and the **same approval + save** step. Parsing differs; everything downstream is shared.

```
NL string ─┐
           ├─► DishDraft ─► (nutrition computed from catalog) ─► APPROVAL ─► persist ─► planner candidate
structured ┘   (main agent)
```

**Nutrition is always computed deterministically from the catalog**, never taken from the LLM or the caller. The model/main-agent only proposes *name + ingredients (with grams) + seasonings + method*; the health-agent owns the numbers.

## 1. The structured dish record

```ts
interface DishDraft {
  name: string;                 // e.g. "洋葱炒牛肉"
  mealCategory: "breakfast" | "main";   // per the constraint spec — NO lunch/dinner split
  ingredients: { slug: string; grams: number }[];
  seasonings: string[];         // seasoning slugs
  method?: string;              // stir_fry | steaming | braising | ... (optional)
  source: "user_nl" | "agent_research" | "preset";
  notes?: string;
}

interface ResolvedDish extends DishDraft {
  slug: string;                 // slugify(name), unique per user
  nutrition: { kcal: number; proteinGrams: number; carbsGrams: number; fatGrams: number; sodiumMg: number };
  buckets: string[];            // derived from ingredient classification (red_meat, deep_sea_fish, ...)
  roles: string[];              // derived (iron, b12, omega3, ...)
  unresolved: string[];         // ingredient names that did NOT map to a catalog slug
}
```

`buckets`/`roles` are **auto-derived** from the ingredients' `food_library` classification — the user never tags them. This is what lets an added dish participate in the weekly-floor / red-meat-day logic for free.

## 2. Flow — propose → approve → save

Two tool calls, so the approval gate is on *content*, not just a yes/no permission prompt.

### Step A — `propose_dish` (read-only, no write)
- Input: `{ naturalLanguage?: string; draft?: DishDraft }` (exactly one).
- **NL path:** the agent (LLM) extracts `name`, `ingredients` (name + grams), `seasonings`, `method` from the text. Ingredient/seasoning **names are mapped to catalog slugs** (by name/alias, zh + en).
- **Structured path:** `draft` is used directly (main-agent reserved).
- Compute `nutrition` from the catalog (`nutritionEstimate` / `aggregateNutrition`). Derive `buckets`/`roles`. Collect `unresolved` ingredients.
- **Returns** a `ResolvedDish` for the user to review. **Persists nothing.**

### Step B — user approval (required)
- The agent shows the `ResolvedDish`: name, mealCategory, ingredients+grams, computed kcal/protein, and any `unresolved` items.
- User confirms, edits (fix a gram amount, map an unresolved ingredient, change category), or cancels.
- **Nothing is saved without explicit confirmation.** (Maps onto the harness write-permission gate, but the *review of parsed content* is the real gate.)

### Step C — `save_dish` (write)
- Input: the approved `ResolvedDish`.
- Validates (§4), persists to the dishes table (§3), returns the saved record.
- Idempotent on `(userId, slug)` — re-saving updates.

> **Why two steps:** a single auto-save tool would persist whatever the LLM guessed. Propose→approve makes the parse reviewable and gives a natural place for the user to correct slug/gram mistakes before they pollute the planner.

## 3. Storage & planner wiring

- **New table `user_dishes`** (don't overload `cooking_records`, which is semantically a cooking *log* keyed by ingredient): columns `id, user_id, slug, name, meal_category, ingredients_json, seasonings_json, method, calories_kcal, protein_g, carbs_g, fat_g, sodium_mg, source, created_at`. Unique `(user_id, slug)`.
- **`loadCandidateDishes`** (`candidate-loader.ts`) reads presets **+ `user_dishes`** (replacing the broken cooking-record path), dedups by slug, and filters to dishes with valid nutrition. `meal_category` drives eligibility (`breakfast` vs `main`).
- A saved dish is immediately eligible for the next `generate_meal_plan`.

## 4. Validation (in `save_dish`)

- `name` non-empty; `mealCategory ∈ {breakfast, main}`.
- ≥ 1 ingredient; every ingredient `slug` resolves to the catalog; `grams > 0`.
- `unresolved.length === 0` — unmapped ingredients must be resolved or dropped during approval (a dish with an unknown ingredient can't have correct nutrition).
- Computed `kcal > 0` and `proteinGrams ≥ 0`.
- Seasoning slugs resolve (unknown seasonings → warn, allow).

## 5. Tool surface

| Tool | Access | Purpose |
|------|--------|---------|
| `propose_dish` | read-only | Parse NL (or accept a structured draft) → return `ResolvedDish` with computed nutrition + unresolved list. No write. |
| `save_dish` | write | Persist an approved `ResolvedDish` to `user_dishes`. |

`propose_dish` accepting **either** `naturalLanguage` **or** `draft` is exactly the seam that reserves the main-agent workflow — the research agent will later call `propose_dish({ draft })` (or `save_dish` directly with its own approval), with no change to this contract.

## 6. Reserved: main-agent research workflow (not built now)

Documented boundary so the seam is intentional:
- **Main agent** owns research/collection/processing of videos, articles, and eaten-dish reports → emits a `DishDraft` conforming to §1.
- **Health-agent** owns: slug resolution, **nutrition computation from the catalog**, classification derivation, validation, approval surfacing, and persistence.
- The main agent never writes nutrition numbers; it only proposes structure. This keeps a single source of truth for nutrition and lets the approval gate apply uniformly.

## 7. Testing

- **Parsing** (NL → draft) is LLM-driven and **non-deterministic** → test with an eval/rubric (did it extract the right ingredients + plausible grams?), not exact assertions.
- **Deterministic core** (unit tests): slug resolution (zh + en names → slugs), nutrition computation from a fixed catalog, bucket/role derivation, validation rejects (unresolved ingredient, zero grams, empty name).
- **Approval gate**: `propose_dish` writes nothing (assert no DB mutation); `save_dish` persists and is idempotent on `(userId, slug)`.
- **Planner integration**: after `save_dish`, the dish appears in `loadCandidateDishes` and can be selected by `generate_meal_plan`.

## 8. Implementation order

1. `user_dishes` table + migration.
2. Slug-resolution helper (zh/en ingredient & seasoning name → catalog slug) — reused by `propose_dish`.
3. `propose_dish` (compute nutrition + buckets/roles + unresolved) — pure over the catalog.
4. `save_dish` (validate + persist).
5. Rewire `loadCandidateDishes` to read `user_dishes` instead of the `caloriesKcal>0` cooking-record path.
6. Eval harness for the NL parse.

## Open decisions

- **Legacy import — DECIDED: do NOT bulk-import.** Start clean. The system carries only the ~dozen curated preset dishes (`preset-dishes.ts`); the old Python DB's 99 recipes (duplicates + test rows) are **not** imported. The `user_dishes` table starts **empty**, and users grow it via the add-dish flow. Import remains *supported* (the `propose_dish`/`save_dish` seam + the reserved main-agent path), just not auto-seeded. If a one-off legacy import is ever wanted, it goes through `save_dish` (with its validation + approval), not a raw insert.
- **Clean-start / reset:** "actual use" begins with only the curated presets as candidates. Because those live in **code**, no destructive DB clear is required — an empty `user_dishes` table *is* the clean state. A `reset` that truncates `user_dishes` (presets untouched) can be provided if a populated environment ever needs wiping.
- **Edit/delete dishes:** v1 supports add + idempotent update on re-save; explicit delete tool deferred unless needed.
- **Per-dish servings:** store single-serving grams (current model) vs scalable portions (Python used `serving_g`). Recommend single-serving for v1.
