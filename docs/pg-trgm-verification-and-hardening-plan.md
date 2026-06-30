# pg_trgm Verification & Hardening Plan

## Execution status (2026-06-27)

- R1 completed: local PostgreSQL connected successfully on 2026-06-27, accepted `pg_trgm`, `db:push`, and `db:seed`, and `tests/db/integration.test.ts` passed 14/14 tests with no DB-gated skips.
- R2 applied: `recallMemories` now runs `set_config(..., true)` and the recall CTE in one Drizzle transaction, so the pg_trgm threshold is local to the same pooled connection that runs the query.
- R2 coverage added: `tests/db/integration.test.ts` now includes a non-substring fuzzy Chinese recall case, so the substring shortcut cannot mask a broken trigram path.
- R2 live-DB adjustment: live `EXPLAIN` showed `<%` did not use `gin_trgm_ops` here, while `%` and `LIKE` did. The final recall candidate filter therefore uses `content_norm % query OR content_norm LIKE '%query%'`, and keeps `word_similarity` for ranking.
- R3 documented: `drizzle/0001_pg_trgm_memory_content_norm.sql` now calls the backfill best-effort SQL and explicitly notes runtime writes use the app's NFKC-aware `normalizeMemoryText`.
- R4 applied: `drizzle/0000_l2_l3_retrieval_memory.sql` now creates `content_norm` plus `memory_records_content_norm_trgm_idx` only; stale raw `content` / `subject` trigram indexes were removed.
- Verification: `tsc --noEmit` passed; `tests/db/integration.test.ts` passed 14/14 against live PostgreSQL; full Vitest passed 33/33 files and 209/209 tests; build passed; exports smoke passed.

Follow-up to `docs/agent-overview-repair-plan.md`. **All 8 repair-plan issues are now complete and verified**
(R1–R4 resolved on 2026-06-27 — see the Execution status block above). The sections below are retained as the
**historical plan and runbook** that produced that result; where a section still reads in future/pending tense,
the Execution status block is authoritative.

> You run everything; this doc does not execute anything. Commands are written for the project root
> (`G:\compass-health-agent`). A POSIX shell (Git Bash) is assumed; PowerShell notes are called out where the
> syntax differs.

---

## 1. Issues addressed (all RESOLVED 2026-06-27)

> Historical record. The "Original state" column describes each issue **as found**; the "Resolution" column
> records how it was closed. None remain open.

| # | Item | Original state (as found) | Resolution |
|---|---|---|---|
| R1 | **Run the pg_trgm recall path against a live Postgres** | Implemented + wired, but **never executed** — DB unavailable, so the SQL-exercising test was `skipIf`-skipped. | ✅ Ran against local PostgreSQL: `tests/db/integration.test.ts` 14/14, full suite 209/209, 0 skipped. |
| R2 | **`set_config` on a separate pooled connection; `position()` branch could mask a broken trigram path** | Threshold set in one `db.execute` and the CTE in a second → may hit different pooled sessions; a substring branch matched regardless of threshold. | ✅ `set_config(..., true)` + CTE wrapped in one `db.transaction` (same connection). Candidate filter is now `content_norm % q OR content_norm LIKE '%q%'` (both index-using; see R-pivot note in §4) and a **non-substring fuzzy** test proves the trigram path. |
| R3 | **Backfill normalization ≠ runtime normalization** | SQL backfill omits NFKC + `\p{S}`, so pre-existing rows differ from runtime-written `content_norm`. | ✅ Documented in `drizzle/0001_*.sql`: backfill is best-effort; runtime writes use the app's NFKC-aware `normalizeMemoryText`. |
| R4 | **Migration files inconsistent with `schema.ts`** | `drizzle/0000_*.sql` declared a `gin_trgm_ops` index before `CREATE EXTENSION`, plus a stale raw-`content`/`subject` index. | ✅ `0000_*.sql` now creates the extension first and declares only `memory_records_content_norm_trgm_idx`. |

All items are closed; the runbook in §2–§3 remains valid for reproducing the live-DB verification.

---

## 2. Environment setup (local PostgreSQL)

The repo ships a compose file: `docker-compose.yml` → service **`postgres`**, image **`pgvector/pgvector:pg17`**
(includes the `pg_trgm` contrib module), container **`compass-health-pg`**, published on **`localhost:5433`**,
credentials **`compass` / `compass`**, database **`compass_health`**. This matches the default
`DATABASE_URL=postgres://compass:compass@localhost:5433/compass_health` in `.env.example` and the test fallback
in `tests/db/integration.test.ts`.

### Step 2.1 — Start the database
```bash
docker compose up -d postgres
```
Wait until healthy:
```bash
docker inspect --format '{{.State.Health.Status}}' compass-health-pg
```
**Expected:** `healthy`.

### Step 2.2 — Create the `pg_trgm` extension FIRST (critical)
`pnpm db:push` is schema-driven and does **not** issue `CREATE EXTENSION`. The `content_norm` GIN index uses
`gin_trgm_ops`, which **fails to create unless `pg_trgm` already exists**. Create it manually before pushing:
```bash
docker exec compass-health-pg psql -U compass -d compass_health -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```
**Expected:** `CREATE EXTENSION` (or no error if it already exists).

### Step 2.3 — Push schema and seed the catalog
```bash
pnpm db:push
pnpm db:seed
```
**Expected:** `db:push` completes without an index/extension error and creates `memory_records.content_norm`
plus the index `memory_records_content_norm_trgm_idx`. `db:seed` populates `food_items` / `seasonings` /
`natural_units` (layer 0).

### Step 2.4 — Confirm extension + index + operator are live
```bash
docker exec compass-health-pg psql -U compass -d compass_health -c "\dx pg_trgm"
docker exec compass-health-pg psql -U compass -d compass_health -c "\d+ memory_records" | grep content_norm
docker exec compass-health-pg psql -U compass -d compass_health -c "SELECT word_similarity('香菜','不吃香菜') AS ws, similarity('香菜','不吃香菜') AS sim;"
```
**Expected:** `pg_trgm` listed; a `content_norm` column **and** a `gin` index named
`memory_records_content_norm_trgm_idx`; `ws` clearly larger than `sim` (e.g. ws ≈ 0.5, sim ≈ 0.14) — this is
exactly why the code uses `word_similarity` rather than plain `similarity`.

> PowerShell: replace `docker exec … psql -c "…"` quoting as needed, or open an interactive shell with
> `docker exec -it compass-health-pg psql -U compass -d compass_health` and paste the SQL.

---

## 3. R1 — Verify the live pg_trgm recall path

### Step 3.1 — Typecheck (no DB needed)
```bash
pnpm typecheck
```
**Expected:** exits 0, no output.

### Step 3.2 — Full suite WITH the database up
```bash
pnpm test
```
The integration suite picks up `DATABASE_URL` from the environment, falling back to the `localhost:5433` URL, so
no extra flags are needed once the container is running. If your shell does not export `.env` automatically:
```bash
DATABASE_URL=postgres://compass:compass@localhost:5433/compass_health pnpm test
```

**Expected successful results:**
- The `describe("database integration")` block **runs instead of skipping** (baseline with no DB was
  `178 passed | 30 skipped`; with the DB up the DB-gated tests move from skipped to passed — confirm the
  skipped count drops and **no `database integration` test is skipped**).
- The test **`recalls short Chinese queries through pg_trgm across the full memory table`** passes. It:
  - inserts an **old** (back-dated to 2020) record `不吃香菜` plus **30 newer noise** records,
  - calls `recallMemories(userId, "香菜", { kinds:["dislike"], limit:3 })`,
  - asserts the **old relevant** record ranks **first** (proves whole-table search, not a recency window),
  - runs `EXPLAIN` and asserts the plan contains `memory_records_content_norm_trgm_idx` and a
    `Bitmap Index Scan` / `Index Scan` (proves the GIN index is actually used).
- All previously-passing tests stay green.

### Step 3.3 — Manual smoke (optional, high-signal for a showcase)
```bash
docker exec compass-health-pg psql -U compass -d compass_health -c \
  "SET enable_seqscan=off; EXPLAIN ANALYZE SELECT id FROM memory_records WHERE content_norm % '香菜' OR content_norm LIKE '%香菜%';"
```
**Expected:** `Bitmap Index Scan on memory_records_content_norm_trgm_idx` for **both** the `%` and `LIKE`
branches (not a `Seq Scan`). On a tiny table `SET enable_seqscan=off` is needed to force the planner's hand —
the point is to prove the index *can* serve these operators, which it does.

> **Do not use `<%` here.** Live `EXPLAIN` on 2026-06-27 showed the `<%` (word_similarity) operator did **not**
> use `gin_trgm_ops` in this environment, whereas `%` and `LIKE` did. The shipped recall filter therefore uses
> `%` + `LIKE` (see the R2-pivot note in §4); `word_similarity` is kept for **ranking**, not candidate filtering.

---

## 4. R2 — Harden the `set_config` / connection-pooling risk — ✅ RESOLVED

> **As shipped (2026-06-27):** a hybrid of the options below. `set_config('pg_trgm.similarity_threshold', …, true)`
> and the recall CTE run inside **one `db.transaction`** (Option B), and after the live-DB `EXPLAIN` showed `<%`
> not using the index, the candidate filter was changed to `content_norm % q OR content_norm LIKE '%q%'`
> (index-using), with `word_similarity` retained for ranking. The `position()` snippets and `<%` references below
> are the **original analysis** and are kept for history — they do **not** describe the current code.

**Problem (as found).** In `src/db/repository.ts → recallMemories`, the thresholds were set in a separate statement:
```ts
await db.execute(sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${MEMORY_TRGM_THRESHOLD}, false), …`);
// …then a SECOND db.execute runs the CTE — possibly on a different pooled connection.
```
On a pool (`max:5`), the GUC may not apply to the connection that runs the query.

**Pick one fix:**

- **Option A (preferred) — inline explicit predicates, drop the session GUC.** Replace the operator-based
  `WHERE` (`<%` / `%`, which depend on the GUC) and the separate `set_config` call with thresholded function
  calls that carry the cutoff in the SQL itself:
  ```sql
  WHERE "user_id" = :userId AND "status" = 'active' :kindFilter AND "content_norm" <> ''
    AND (
      word_similarity(:q, "content_norm") >= 0.08
      OR word_similarity("content_norm", :q) >= 0.08
      OR position(:q in "content_norm") > 0
    )
  ```
  Remove the `await db.execute(sql\`SELECT set_config(...)\`)` call entirely. This makes the threshold
  deterministic regardless of which pooled connection serves the query.

- **Option B — pin one connection per recall.** Wrap the `set_config` (use `SET LOCAL`) and the query in a
  single transaction so they share a session:
  ```ts
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL pg_trgm.word_similarity_threshold = ${MEMORY_TRGM_THRESHOLD}`);
    return tx.execute(sql`WITH ranked AS ( … ) …`);
  });
  ```

**Then add a test that the `position()` branch cannot mask** — a **non-substring fuzzy** query, so the trigram
threshold path is actually exercised:
```ts
// in tests/db/integration.test.ts, inside the skipIf(!isDbAvailable) block
it("recalls a fuzzy (non-substring) Chinese query via trigram similarity", async () => {
  await repo.upsertMemory({ userId, kind: "dislike", subject: "fuzzy-cilantro",
    content: "我不吃香菜", confidence: 1 });
  // 香莱 is a near-miss for 香菜 (different 2nd char) → NOT a substring of the stored content
  const recalled = await repo.recallMemories(userId, "香莱", { kinds: ["dislike"], limit: 3 });
  expect(recalled.some((r) => r.subject === "fuzzy-cilantro")).toBe(true);
});
```
**Expected:** with the GUC reliably applied (Option A/B), this passes; if the threshold path were broken, it
fails (whereas the existing substring test would still pass — that's the point).

---

## 5. R3 — Align backfill normalization with runtime (cleanup)

**Problem.** Old rows backfilled by `drizzle/0001_pg_trgm_memory_content_norm.sql` use a SQL normalization that
omits NFKC folding and `\p{S}` stripping, so they differ from rows written by `normalizeMemoryText`.

**Fix options:**
- Simplest: after seeding/usage, **re-normalize in app code** — read each `memory_records` row and re-run
  `upsertMemory`-equivalent normalization to repopulate `content_norm`. (A tiny one-off script, or accept that
  only legacy rows are affected.)
- Or document the limitation explicitly: full-width/symbol characters in **pre-migration** rows may not match;
  all rows created at runtime are correct.

**Verification (if you re-normalize):**
```bash
docker exec compass-health-pg psql -U compass -d compass_health -c \
  "SELECT count(*) FROM memory_records WHERE content_norm <> lower(content) AND content ~ '[Ａ-Ｚａ-ｚ０-９]';"
```
**Expected:** `0` full-width rows whose `content_norm` was left unfolded (or a known, documented count).

---

## 6. R4 — Migration vs schema consistency (cleanup)

`pnpm db:push` (schema-driven) is the supported path and is correct. If you intend the raw `drizzle/*.sql`
files to be runnable in order, fix them so `CREATE EXTENSION IF NOT EXISTS pg_trgm;` precedes any
`gin_trgm_ops` index, and remove the stale raw-`content` trigram index that `schema.ts` no longer declares.
**Verification:** on a fresh database, applying the migration files in order completes without an
"operator class gin_trgm_ops does not exist" / "extension not found" error. (Not required if you standardize on
`db:push`.)

---

## 7. Acceptance criteria

1. **R1:** With the DB up, `pnpm test` runs the `database integration` block (0 DB-gated skips) and the pg_trgm
   recall test passes, including the `EXPLAIN` index-use assertion. `pnpm typecheck` and `pnpm build` stay green.
2. **R2:** `recallMemories` no longer depends on a session GUC set on a separate connection (Option A or B
   applied), and a **non-substring fuzzy** recall test passes — proving the trigram path works, not just the
   `position()` substring shortcut.
3. **R3:** Backfilled `content_norm` matches runtime normalization, or the divergence is explicitly documented.
4. **R4:** `db:push` remains the source of truth; raw migrations either fixed to run in order or marked
   non-authoritative.
5. **Docs:** `docs/agent-overview.md` status line updated from "runs when a live DB is available" to
   "verified against PostgreSQL on <date>", and `docs/agent-overview-repair-plan.md` Issue 2 / Issue 7 marked
   done with the run date.

---

## 8. Risks & caveats (read before running)

- **Extension ordering (most likely failure):** `pnpm db:push` will error on the `gin_trgm_ops` index if
  `pg_trgm` is not created first. Always do Step 2.2 before Step 2.3. Managed/hosted Postgres may forbid
  `CREATE EXTENSION` — confirm the deploy target allows it before relying on this in production.
- **`set_config` + pooling (R2 — resolved):** the threshold + CTE now run in one `db.transaction`, and a
  non-substring fuzzy test guards the trigram path, so a green pg_trgm test *does* prove correctness. The
  historical warning (a substring branch could carry a green test) no longer applies to the shipped code.
- **Normalization mismatch (R3):** backfilled vs runtime `content_norm` can differ on full-width/symbol input;
  only affects pre-migration rows (documented in `drizzle/0001_*.sql`).
- **Migration/schema drift (R4 — resolved):** `0000_*.sql` now creates the extension first and matches
  `schema.ts` (only the `content_norm` trigram index). `db:push` remains the source of truth.
- **Shell differences:** examples use Git Bash. In PowerShell, inline `VAR=… cmd` does not work — set
  `$env:DATABASE_URL` first, and adjust `psql -c "…"` quoting.
- **Boundary:** none of this touches `G:\pi-harness` (read-only). The add-dish side-dish capability still
  depends on the separately-tracked pi-harness schema change in `docs/pi-harness-pending-changes.md`.
