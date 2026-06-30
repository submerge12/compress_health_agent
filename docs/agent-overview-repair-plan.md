# Repair Plan — `agent-overview.md` & implementation gaps

Source: adversarial review of `docs/agent-overview.md` against the live code, schema, tests, and the
pi-harness adapter (`G:\pi-harness\src\agents\profiles\compass-health\`). This plan fixes the defects the
review found. Most are **doc accuracy** fixes; one (`save_dish`) is a **latent integration bug**.

Branch: `codex/pi-harness-alignment`. Boundary reminder (CLAUDE.md): **EDIT this repo only; never modify
`G:\pi-harness`.** Items that require a pi-harness schema change are tracked here but must be applied on the
framework side by its owner — this repo's job is to make the contract unambiguous and test-detectable.

---

## Issue inventory

| # | Severity | Issue | Type |
|---|---|---|---|
| 1 | High | `save_dish` schema omits `role`/`selfContained`/`sideKind`, but `validateResolvedDish` requires `role` → propose→save can fail (not just "sides only") | Code/contract bug |
| 2 | High | Doc claims `recall` uses **pg_trgm**; it is in-JS n-gram Jaccard over a btree-indexed fetch. **Decision: implement real pg_trgm** (showcase feature) so the claim becomes true | Feature + doc |
| 3 | Medium | Doc lists **H4 protein floor** as one of "two real hard gates"; it is a soft penalty + reported violation. Only H1 is a true filter | Doc inconsistency |
| 4 | Medium | Supersession example (`我不吃肉`→`我吃了鸡肉`) cannot trigger the code path (supersession is `(kind, subject)`-scoped exact replace) | Doc overclaim |
| 5 | Low | Architecture section says pi-harness was refactored to a thin adapter; caveats say pi-harness is "untouched" — self-contradiction | Doc inconsistency |
| 6 | Low | "~20 presets" — actual count is **25** (6 breakfast / 14 mains / 5 sides) | Doc stale number |
| 7 | Low | No live-DB end-to-end pass; SQL paths only exercised via fakes/fixtures | Validation gap |
| 8 | Low | Example C ("280g 豆腐配葱" → tofu + scallion) overclaims the NL parser: `parseNaturalLanguage` only captures ingredients with explicit grams (`<num>g <food>`), so "配葱" (no grams) is dropped | Doc overclaim |

---

## Priority order

1. **Issue 1** — latent bug, blocks the documented add-dish flow. Fix + test first.
2. **Issue 2** — false technical claim. **Decided: implement real pg_trgm recall** (a showcase feature), then update the doc to match. This is now feature work, not a doc edit.
3. **Issue 3**, **Issue 4** — correctness of the mental model the doc teaches.
4. **Issue 5**, **Issue 6**, **Issue 8** — internal consistency / stale facts / example accuracy.
5. **Issue 7** — standing validation; do the live-DB run last, once code is settled.

---

## Affected files

| Area | Files |
|---|---|
| `save_dish` contract (this repo) | `src/tools/add-dish.ts`, `src/tools/handlers.ts`, `tests/handlers/add-dish.test.ts`, `tests/contract/pi-harness-surface.test.ts` |
| `save_dish` schema (framework, **out-of-repo, owner-applied**) | `G:\pi-harness\src\agents\profiles\compass-health\tools.ts` (`saveDishParams`, `dishDraftParams`), `docs/pi-harness-pending-changes.md` |
| pg_trgm recall (implement) | `src/db/schema.ts` (extension + normalized column + GIN index), `src/db/repository.ts` (`recallMemories`, drop/keep JS scorers), new migration under `drizzle/`, `tests/handlers/memory.test.ts` + a new `skipIf(!isDbAvailable)` recall test, then `docs/agent-overview.md` L3 + example D |
| Hard-gate & supersession wording | `docs/agent-overview.md` |
| Architecture vs. caveats, preset count | `docs/agent-overview.md` |
| Live-DB run | `tests/db/integration.test.ts` (existing), local Postgres |

---

## Repair steps

### Issue 1 — `save_dish` round-trip contract

**Goal:** the exact payload an LLM sends to `save_dish` (the object returned by `propose_dish`, minus any
fields the schema drops) must save successfully for mains, and `role`/`selfContained`/`sideKind` must be
expressible so sides can be created.

Steps:
1. Decide the contract. Two viable options — pick one and make it explicit:
   - **(A) Tolerant handler (this-repo-only fix, unblocks mains now):** in `userDishRowFromResolvedDish` /
     `validateResolvedDish` (`src/tools/add-dish.ts`), default a missing `role` to `"main"` and
     `selfContained` to `true` instead of throwing, so a schema that strips those keys still round-trips.
     Side creation still needs option B.
   - **(B) Surface the fields (full fix, requires framework edit by owner):** add `role`, `selfContained`,
     `sideKind` to `saveDishParams` and `dishDraftParams` in pi-harness `tools.ts`, keeping them optional with
     the same defaults this repo applies.
   - Recommended: **do A in this repo now** (removes the latent failure regardless of framework state) **and**
     record B in `docs/pi-harness-pending-changes.md` as the owner-applied change for sides.
2. Implement the chosen handler behavior in `src/tools/add-dish.ts`; keep the `role==="side" ⇒ mealCategory==="main"`
   and side-ingredient invariants intact.
3. Update `docs/pi-harness-pending-changes.md` to state the *true* impact: without the schema fields, **side
   dishes cannot be created**, and (before fix A) mains fail if the framework strips unknown keys.

### Issue 2 — implement real `pg_trgm` recall (showcase feature)

**Decision:** the doc's `pg_trgm` claim is currently false; rather than soften the doc, **build the feature** so
the claim is true. This is a deliberate showcase of Postgres-native trigram search.

#### Background — JS n-gram (now) vs `pg_trgm` (goal)

Both compute the **same idea**: chop text into 3-character trigrams and measure overlap with Jaccard
similarity (`|A∩B| / |A∪B|`). The differences are what make `pg_trgm` worth showcasing:

| | JS n-gram (current) | `pg_trgm` (goal) |
|---|---|---|
| Where it runs | Node app loop, after fetching rows | Inside Postgres, accelerated by a GIN index |
| What is searched | only the newest `limit*4` rows (ordered by `lastConfirmedAt`) — older relevant memories are never fetched | the **whole table**, via the index |
| Trigram generation | spaces/punct stripped, raw sliding 3-char window | per **word**, padded with 2 leading + 1 trailing space (encodes word boundaries) — inspect with `SELECT show_trgm('tomato egg')` |
| Short-query match | `includes()` substring shortcut → score `1.0` | use `word_similarity()` / `strict_word_similarity()` (plain `similarity()` penalizes long content via the union denominator) |
| Normalization | your `normalizeMemoryText` (NFKC + lowercase + strip punct) | Postgres' own (lowercase, non-alphanumeric = word break); **cannot** inject NFKC/full-width folding → must index a pre-normalized column |
| Chinese, short query | fine (substring shortcut) | coarse: `相似度('香菜','不吃香菜')` ≈ 0.14 with plain `similarity()`, **below** the 0.3 default threshold → needs `word_similarity` + lowered threshold |

The two headline wins to demo: **(a) index-accelerated search across the entire table** (the current loop
only scores a recency window and silently misses old matches), and **(b) similarity computed in the DB**.
The two traps to handle: **short-query-vs-long-content** (use `word_similarity`, not `similarity`) and
**Chinese** (few trigrams per phrase → tune the threshold and pre-normalize).

#### Implementation steps

1. **Extension + normalized column + index** (`src/db/schema.ts` + a Drizzle migration in `drizzle/`):
   - `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
   - Add a `content_norm` column to `memory_records` populated by the **same** normalization as
     `normalizeMemoryText` (NFKC + lowercase + strip punct/space), so zh/en folding is preserved. Populate it
     on insert/update in `upsertMemory`, or as a generated column if the normalization can be expressed in SQL
     (it cannot easily do NFKC, so prefer writing it from the app in `upsertMemory`).
   - `CREATE INDEX memory_records_content_norm_trgm_idx ON memory_records USING gin (content_norm gin_trgm_ops);`
2. **Rewrite `recallMemories`** (`src/db/repository.ts`):
   - Normalize the query with the same function, then query filtered by `userId`/`status`/`kinds`, ordered by
     score `DESC`, `LIMIT`, with `word_similarity` driving the score.
   - Keep the **recency boost** but move it into SQL on top of the DB score
     (`ORDER BY word_similarity(:q, content_norm) * (1 + recency_factor) DESC`), preserving current behavior.
   - Decide the fate of the now-unused JS `memoryRecallScore`/`textSimilarity`/`ngrams` helpers: remove them, or
     keep as a no-DB fallback (if kept, gate clearly so the doc doesn't re-introduce the same false claim).

   > **As-shipped pivot (2026-06-27, IMPORTANT for maintainers):** the candidate **filter** does **not** use the
   > `<%` word-similarity operator. Live `EXPLAIN` showed `<%` did not use `gin_trgm_ops` in our environment,
   > while `%` and `LIKE` did. The shipped `WHERE` is therefore
   > `content_norm % :q OR content_norm LIKE '%:q%'` (both index-using), with `word_similarity` kept only for
   > **ranking** in the `SELECT`/`ORDER BY`. The threshold is set as `pg_trgm.similarity_threshold` (what `%`
   > needs) via `set_config(..., true)` inside a single `db.transaction` that also runs the CTE, so the GUC is
   > local to the connection serving the query. Do **not** "simplify" the filter back to `<%` — it will silently
   > fall back to a seq scan here. See `docs/pg-trgm-verification-and-hardening-plan.md` §4.
3. **Update the doc** (`docs/agent-overview.md` L3 + example D) to describe the real pg_trgm path: normalized
   column, GIN index, `word_similarity`, threshold tuning, recency factor — with citable symbols.

> Note: this adds a hard runtime dependency on Postgres having `pg_trgm` (a contrib module — present in
> standard images and most managed Postgres, but confirm the deploy target allows `CREATE EXTENSION`).

### Issue 3 — hard gates vs. soft objective

1. In `docs/agent-overview.md` "Hard gates vs soft objective", state there is **one** hard filter (H1
   exclusions, `filterUsableCandidates`). Energy band and protein floor are **strongly-weighted soft penalties
   plus reported `hardViolation`s** — they never reject a plan. Remove the "two real gates" framing so it no
   longer contradicts "best-effort: always returns a plan."

### Issue 4 — supersession example

1. Replace the example with one that matches the code: same `kind`+`subject`, changed `content`
   (e.g. dislike/subject=`cilantro`: "不吃香菜" later softened/changed). State explicitly that supersession is
   subject-scoped exact replacement, not semantic inference.

### Issue 5 — architecture vs. caveats

1. Reconcile the two sections: the pi-harness `profile.ts`/`tools.ts` adapter **exists and is wired**; what is
   outstanding is only the `save_dish`/`propose_dish` schema fields (Issue 1B). Drop "pi-harness untouched"
   wording or qualify it to "no further framework edits pending except the noted schema change."

### Issue 6 — preset count

1. Change "~20 presets" to "25 preset dishes (6 breakfast / 14 mains / 5 sides)" in the data-layer table and
   anywhere else the number appears.

### Issue 8 — example C overclaims the NL parser

1. Fix example C in `docs/agent-overview.md` so it reflects `parseNaturalLanguage` (`src/tools/add-dish.ts:198-214`):
   the regex only captures ingredients written as `<number>g <food>`. Either (a) reword the example so every
   ingredient has explicit grams (e.g. "280g 豆腐, 20g 葱"), or (b) note that ingredients without a gram amount
   (like a bare "配葱") are not parsed and must be given a quantity. Do not imply the parser infers unquantified
   ingredients.

### Issue 7 — live-DB pass

1. Start local Postgres (`docker compose` / the project's DB), run `pnpm db:push && pnpm db:seed`.
2. Run `pnpm test` with `DATABASE_URL` set so `tests/db/integration.test.ts` and other `skipIf` suites execute.
3. Manually exercise: `set_profile` → `log_meal` (zh) → `generate_meal_plan` → `meal_checkin` →
   `remember`/`recall` → `propose_dish`/`save_dish`. Record results.

---

## Tests / verification

- **Issue 1:** add a test in `tests/handlers/add-dish.test.ts` that feeds `handleSaveDish` a payload **shaped
  like the pi-harness `saveDishParams` schema** (i.e. `role`/`selfContained`/`sideKind` absent) and asserts a
  main dish saves; add a second asserting a `role:"side"` dish persists with `sideKind`. Extend
  `tests/contract/pi-harness-surface.test.ts` to pin the `save_dish` field set so future schema drift is caught.
- **Issue 2 (pg_trgm):** add a `skipIf(!isDbAvailable)` test that seeds several memories (zh + en) and asserts
  recall ranks the relevant one first, including a **short Chinese query** (e.g. `香菜` → finds `不吃香菜`) and an
  **old-but-relevant** record that the previous recency-window approach would have missed. Verify the query uses
  the GIN index (`EXPLAIN` shows a bitmap index scan, not a seq scan) on a seeded table. Confirm `show_trgm`
  /`word_similarity` behavior matches expectations during development.
- **Issues 3–6, 8:** doc-only — verify by re-reading against `meal-planner.ts`, `repository.ts`,
  `preset-dishes.ts`, `add-dish.ts`; no claim or example should remain unsupported by a cited symbol.
- **Whole suite:** `pnpm typecheck && pnpm test` stays green (baseline: 174 passed / 29 skipped).
- **Build/contract:** `pnpm build` succeeds and `node dist/index.js` prints "16 tools registered".
- **Exports smoke:** `pnpm smoke:exports` passes.

---

## Acceptance criteria

1. `save_dish` round-trips a schema-shaped payload: a **main** dish persists without `role` present, and a
   **side** dish (with `role`/`sideKind`) persists; both covered by tests, and the pi-harness surface test pins
   the field set. `docs/pi-harness-pending-changes.md` states the true impact.
2. `recall` actually uses Postgres `pg_trgm`: `memory_records` has a normalized column + GIN trigram index, and
   `recallMemories` ranks via `word_similarity` (with recency factor) over the whole table. A DB-backed test
   proves short-Chinese-query recall and old-record recall, and `EXPLAIN` shows index use. Verified against local
   PostgreSQL on 2026-06-27 (`tests/db/integration.test.ts`: 14 passed). `docs/agent-overview.md` L3 + example D
   describe this real path with citable symbols (no stale JS-only claim left behind).
3. The doc describes exactly **one** hard filter (H1); energy/protein are documented as soft penalties +
   reported violations, with no remaining "always returns a plan" contradiction.
4. The supersession example is realizable by the code path and labeled subject-scoped.
5. Architecture and caveats agree on pi-harness state; preset count reads **25**; example C only uses
   quantified ingredients (or explicitly notes unquantified ones aren't parsed).
6. `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke:exports` all pass; tool count remains 16.
7. (Issue 7) Live-DB run completed and recorded on 2026-06-27: local PostgreSQL accepted the schema/seed, and the
   DB integration file passed 14/14 tests.

---

## Out of scope / follow-ups (unchanged from overview)

- Generative `suggest_dishes` flow; hard per-dish weekly usage cap; scheduled reminders + habit learning.
- (pg_trgm recall is now **in scope** — Issue 2.)
