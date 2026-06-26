# Execution Plan — L2/L3 Retrieval & Memory (compass-health-agent)

**Date:** 2026-06-26
**Status:** Ready to execute (L2 + L3 are independent of each other; both shippable now)
**Approach:** Hybrid retrieval — structured-first, semantic-fallback. Keep deterministic matching for the
common case; use embeddings only for "same meaning, different words." Bulk in this repo; a thin tool
registration in the pi-harness `compass-health` profile.

---

## 0. Problem & scope

Retrieval in this agent has three layers; only one is actually broken today:

| Layer | Retrieves | Today | Action |
|---|---|---|---|
| **L1 — facts** | logs/targets/plans (`listDietLogsRange`, `getLatestBmrProfile`, …) | structured SQL by user/date | ✅ keep as-is |
| **L2 — entity resolution** | free-text food → catalog item | **substring `includes()`** in `src/tools/nutrition-estimate.ts:78 findFood` | ❌ **fix (this plan)** |
| **L3 — episodic memory** | preferences/dislikes/notes recalled across sessions | none | ➕ **add (this plan)** |

L2 is the real pain: `findFood` only matches when the user's text literally contains a catalog
name/slug/alias. Paraphrases, synonyms, EN↔ZH, and typos silently fail (the food is dropped, or
`parseMealItems` throws "must include at least one recognized food").

## Locked decisions (from prior review)
- **Hybrid:** exact → alias → fuzzy → (semantic) → clarify.
- **Confidence-gated clarify:** a weak match returns `needs_confirmation` (candidates) — never a silent guess.
- **Matcher in the agent; governance in the harness.** L2/L3 logic lives here; the AOH harness reviews/gates
  outputs when the agent runs through it.
- **Scope = L2 and L3.** Graph/ontology/auto-distillation deferred (Build Gate).
- **D1 (embedding source) — OPEN, gates only the semantic steps.** Recommendation: ship lexical now
  (in-memory trigram for L2, `pg_trgm` for L3 recall), add a **local bilingual model (e.g. bge-m3)** later as
  the semantic fallback. Avoid an external embedding API — it breaks the profile's `network: deny` and sends
  food/health text off-box. Keep any `embedding` column **nullable** so adding it later is non-breaking.

**No-D1 rule:** every step below ships without deciding D1 **except** the two marked **(D1)**.

## Ownership / where each change lands
- **compass-health-agent (this repo):** schema, migrations, repository, the matcher, the memory logic, the
  tool handlers, system-prompt guidance.
- **pi-harness (`src/agents/profiles/compass-health/tools.ts` only):** register the new `remember`/`recall`
  tools (thin TypeBox wrappers that call this repo's handlers). After the Option-B refactor the system prompt
  is owned here, so prompt guidance for the new tools goes in this repo's `systemPrompt`.

---

# PLAN L2 — food/dish resolution

> Note on mechanism: the catalog is already preloaded into `ctx.catalog` (`loadMealCatalog`), and it's small,
> so L2 fuzzy matching is done **in-memory in JS** (no DB round-trip per segment). `pg_trgm` is used for L3
> recall (a per-user DB query), not here.

### L2.1 — Normalization util
- **File:** `src/tools/food-matcher.ts` (new)
- `normalize(s)`: lowercase · strip punctuation/whitespace/emoji · traditional→simplified · full-width→half-width.
  Apply to **both** the user segment and every catalog label.

### L2.2 — Aliases & richer labels
- **File:** `src/db/schema.ts` — add `food_aliases` (mirror existing helpers):
  ```ts
  export const foodAliases = pgTable("food_aliases", {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),          // → food_items.slug
    alias: text("alias").notNull(),
    locale: text("locale"),                // "zh" | "en" | null
    ...timestamps(),
  }, (t) => [ unique().on(t.slug, t.alias) ]);
  ```
- **File:** `src/db/catalog.ts` — in `loadMealCatalog`, populate each `FoodCatalogRecord.aliases` from
  `food_aliases`, and include `nameZh` in the labels (today `labelsFor` uses only `name`/`slug`/`aliases`).

### L2.3 — Hybrid in-memory matcher
- **File:** `src/tools/food-matcher.ts` — `matchFood(segment, catalog) → { food, score } | undefined`:
  ```
  exact normalized label hit  → score 1.0
  alias hit                   → score ~0.95
  else best character-trigram (Jaccard) similarity over normalized labels → score in [0,1)
  ```
- **File:** `src/tools/nutrition-estimate.ts` — replace `findFood` (line 78) with `matchFood`; carry `score`.

### L2.4 — Confidence gate (clarify, don't guess)
- **File:** `src/tools/nutrition-estimate.ts` — thresholds `HIGH` / `LOW`:
  - `score ≥ HIGH` → accept.
  - `LOW ≤ score < HIGH` → emit a `needs_confirmation` result carrying top-N candidate slugs (do **not** match).
  - `score < LOW` → unmatched candidate list (do **not** throw).
  Extend `NutritionEstimateResult` with an optional `needsConfirmation?: { segment: string; candidates: {slug,label,score}[] }[]`.
- **System prompt (`src/agent.ts` `systemPrompt`):** add "if a tool result contains `needsConfirmation`, ask the
  user to pick before logging."

### L2.5 — Semantic fallback **(D1)**
- Only when exact/alias/trigram all fall below `LOW`: embed the segment, take nearest catalog item by vector.
  Deferred until D1 (local bge-m3). Keep `food_items` embeddable but the column nullable.

### L2.6 — Eval set
- **File:** `tests/retrieval/food-match-eval.test.ts` (new) — ~100–200 `{description → expected slug}` bilingual
  cases incl. paraphrase/typo/EN↔ZH. Assert coverage/precision before vs after L2.1–L2.4. This doubles as the
  AOH reviewer's ground truth.

### L2 acceptance
- `pnpm typecheck` + `pnpm test` + `pnpm build` green.
- EN/ZH paraphrase ("tomato scrambled eggs", "西红柿炒蛋") resolves to the right slug.
- A genuinely ambiguous input returns `needsConfirmation` (no silent guess), and an unmatched segment no longer
  throws.
- Eval-set precision/coverage improved vs the substring baseline.

---

# PLAN L3 — episodic memory

Agent-curated store with explicit recency/supersession (the Hermes / Claude-Code pattern — not a vector dump).

### L3.1 — Schema
- **File:** `src/db/schema.ts`:
  ```ts
  export const memoryRecords = pgTable("memory_records", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    kind: text("kind").notNull(),                 // preference | dislike | routine | note
    subject: text("subject").notNull(),           // dedup/conflict key, e.g. "cilantro"
    content: text("content").notNull(),           // durable fact, e.g. "不吃香菜"
    sourceText: text("source_text"),              // provenance: what the user actually said
    confidence: doublePrecision("confidence").notNull().default(1),
    status: text("status").notNull().default("active"), // active | superseded | retracted
    supersededBy: uuid("superseded_by"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).defaultNow(),
    timesReferenced: integer("times_referenced").notNull().default(0),
    // embedding vector(N) — deferred (D1); add nullable later
    ...timestamps(),
  });
  ```

### L3.2 — Migration
- `CREATE EXTENSION IF NOT EXISTS pg_trgm;` + a **GIN trigram index** on `content` (and `subject`). Generate via
  the repo's existing drizzle migration flow (`drizzle.config.ts`). Leave `embedding` out for now.

### L3.3 — Repository methods
- **File:** `src/db/repository.ts` (same `db.select/insert/update` style):
  - `upsertMemory({userId, kind, subject, content, sourceText, confidence})` — **supersession**:
    ```
    find active row where (userId, kind, subject)
    if found and content differs → old.status='superseded', old.supersededBy=new.id, old.validTo=now(); insert new active
    else if found and content same → bump lastConfirmedAt, timesReferenced++
    else → insert new active
    ```
  - `recallMemories(userId, query, {kinds?, limit=5})` — `where status='active'`, rank by
    `similarity(content, query)` × recency boost, **dedup by subject**, small `k`.
  - `confirmMemory(id)` / `retractMemory(id)`.

### L3.4 — Handlers
- **File:** `src/tools/memory.ts` (new) + export from `src/tools/handlers.ts`:
  - `handleRemember(ctx, {kind, subject, content, sourceText?})` → `upsertMemory` (low confidence → return a
    `needsConfirmation` instead of persisting).
  - `handleRecall(ctx, {query, kinds?})` → `recallMemories`.

### L3.5 — Tool registration (pi-harness profile)
- **File (pi-harness):** `src/agents/profiles/compass-health/tools.ts` — add `remember` (`accessLevel: "write"`)
  and `recall` (`accessLevel: "read-only"`) registrations that delegate to this repo's handlers (mirror the
  existing 12 blocks). 12 → 14 tools.
- **System prompt (this repo, `src/agent.ts`):** when the user states a durable preference/dislike/routine, call
  `remember` (confirm low-confidence first); call `recall` before personalized recommendations/plans.
- *(Optional later)* auto-inject top active memories via pi-harness `src/context/jit-loader.ts` instead of an
  explicit `recall` tool. Start with the `recall` tool (no dynamic-prompt coupling).

### L3.6 — Embedding recall **(D1)**
- Add the nullable `embedding` column + hybrid recall (trgm ∪ vector, dedup, recency). Deferred until D1.

### L3 acceptance
- Conflict: "我不吃肉" then "我吃了鸡肉" → old record `superseded`, `recall` returns only the new active fact.
- Recency: newest active record per `subject` wins.
- A Chinese `recall` query returns the relevant memory via `pg_trgm`.
- A low-confidence statement triggers a confirm turn, not a silent write.
- `pnpm typecheck` + `pnpm test` + `pnpm build` green.

---

## What needs D1 vs ships now
- **Ship now (no D1):** L2.1–L2.4, L2.6, L3.1–L3.5. This is the majority and closes most of the real gap.
- **Needs D1 (embedding source):** L2.5 and L3.6 (semantic fallbacks). Recommended D1 = local bge-m3; `embedding`
  columns nullable.

## Execution order & gating
1. **L2.1 → L2.4** (matcher + alias table + clarify) — verify: `pnpm typecheck && pnpm test && pnpm build`.
2. **L2.6** eval set — lock the baseline→after numbers.
3. **L3.1 → L3.4** (schema + migration + repo + handlers) — verify build + the L3 acceptance tests.
4. **L3.5** register `remember`/`recall` in the pi-harness profile (after Option-B refactor; touches the profile
   folder only). Verify pi-harness `npm run typecheck && npm test && npm run build`.
5. **(D1 decision)** then **L2.5 + L3.6** semantic fallbacks.
- *Gating:* L2 and L3 are independent — either can go first. L3.5 (pi-harness) requires this repo rebuilt
  (`pnpm build`) so the new handler exports are in `dist` (consumed via the `file:` symlink), same rule as the
  Option-B plan.

## Out of scope (Build Gate)
Knowledge graph / ontology; auto-distillation from full transcripts (the agent writes memory explicitly);
migrating structured prefs (e.g. `listRejectedSeasoningSlugs`) into `memory_records`; embeddings in v1.
