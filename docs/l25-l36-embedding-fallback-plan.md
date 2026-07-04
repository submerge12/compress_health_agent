# Execution Plan — L25 / L36 Semantic Embedding Fallbacks (compass-health-agent)

**Date:** 2026-07-01
**Status:** READY (D1 decided). Parent: `docs/l2-l3-retrieval-and-memory-plan.md`. Nodes: **L25** (food semantic
fallback), **L36** (memory semantic recall) on the AOH board.
**Decision (D1):** embeddings via an **OpenAI-compatible `/v1/embeddings` API**; **no local model**.

## Locked parameters
- **Provider:** OpenAI-compatible endpoint (swappable via config).
- **`EMBEDDING_DIM` = 1024** (default; **confirm the exact model** — a strong multilingual model at 1024 fits the
  bilingual zh+en catalog; `text-embedding-3-small`@1536 is an index-safe alternative). Must stay **≤ 2000** to keep
  pgvector HNSW indexes valid; **do not** use 3072 native.
- **Metric:** cosine (`vector_cosine_ops`).
- **Where calls happen:** catalog/memory embedded **offline** at seed/build; **only the short user query** is embedded
  **at runtime**, and **only on the fallback path** (after exact/alias/trigram miss).
- **PII:** food/memory text goes to the embedding endpoint — same exposure profile already accepted for DeepSeek.

---

## E1 — Shared infrastructure (prerequisite for both L25 and L36)

**E1.1 — Config** (`src/config` / env): `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`,
`EMBEDDING_DIM` (default 1024). Fail fast if the API returns a vector whose length ≠ `EMBEDDING_DIM`.

**E1.2 — Embedding client** (`src/embeddings/client.ts`, new):
- `embed(texts: string[]): Promise<number[][]>` → POST `${EMBEDDING_BASE_URL}/embeddings` (OpenAI shape) with
  `{ model, input, dimensions? }`; timeout + bounded retry; batch for offline runs.
- Dependency-injectable so tests pass a **mock** (fixed deterministic vectors) — unit tests must **not** hit the
  network or cost money.
- Assert output dimension == `EMBEDDING_DIM`.

**E1.3 — pgvector** migration: `CREATE EXTENSION IF NOT EXISTS vector;` (L3 already added `pg_trgm`).

- *Done-when:* `embed(["chicken"])` against the real endpoint returns a `1024`-length vector (one live smoke);
  mock client returns fixed vectors in tests; `pnpm typecheck && pnpm build` green.

---

## E2 — L25: food semantic fallback

**E2.1 — Schema** (`src/db/schema.ts`): add `embedding vector(EMBEDDING_DIM)` to `food_items` (drizzle `vector`
column type, or a custom type). HNSW index via raw SQL migration: `USING hnsw (embedding vector_cosine_ops)`.

**E2.2 — Offline catalog embed** (`src/db/seed` or a `scripts/embed-catalog.ts`): for each food item embed a
canonical label (normalized `name` + `nameZh` + aliases), store the vector. **Idempotent** — only (re)embed items
whose text/model changed. Run at seed/build, not runtime.

**E2.3 — Matcher fallback branch** (`src/tools/food-matcher.ts`): extend `matchFood` so that when exact/alias/trigram
all fall below `LOW`, embed the user segment (E1.2) and run a pgvector nearest-neighbor query
(`ORDER BY embedding <=> $query LIMIT k`); return `{ food, score }` where `score` = cosine similarity of the top hit.

**E2.4 — Confidence gate:** feed that score into the existing gate — `≥ HIGH` accept; `LOW ≤ score < HIGH` →
`needsConfirmation` with top-k candidates; `< LOW` → unmatched. (Same gate L2 already uses; no new gate.)

**E2.5 — Tests** (mock client, deterministic): a zero-character-overlap case (`"tomato scrambled eggs"` and a
paraphrase like `"焖牛腩"`) resolves via the semantic branch to the right slug; a far/nonsense input still returns
`needsConfirmation` (gate fires); lexical hits never reach the embedding branch (fast path preserved). Extend the L2
eval set with EN↔ZH/paraphrase rows and show coverage up vs L2-lexical-only.

- *Done-when:* semantic branch resolves different-words/same-meaning cases lexical missed; gate still rejects weak
  matches; `pnpm typecheck && pnpm test && pnpm build` green.

---

## E3 — L36: memory semantic recall

**E3.1 — Schema:** add `embedding vector(EMBEDDING_DIM)` to `memory_records` + HNSW cosine index.

**E3.2 — Embed on write** (`upsertMemory`): embed `content` when a memory is created/updated; store the vector.

**E3.3 — Hybrid recall** (`recallMemories`): run **both** `pg_trgm` (existing) and vector nearest-neighbor, merge,
**dedup by `subject`**, recency-weight, keep small `k` (≤5), `status='active'` only. (Avoids the top-k
near-duplicate pitfall.)

**E3.4 — Backfill:** one-time embed of existing active `memory_records` (offline batch).

**E3.5 — Tests** (mock client): a query with no character overlap ("推荐个晚餐" → recalls a spice-preference memory
"不吃辣") is returned by the vector path but not by trgm alone; hybrid dedup keeps one row per subject; supersession/
recency from L3 still hold.

- *Done-when:* hybrid trgm∪vector recall returns meaning-related memories trgm misses; dedup + recency preserved;
  `pnpm` green.

---

## Testing strategy
- **Unit/CI:** always use the **mock embedding client** (fixed vectors) — deterministic, free, offline. No live API in the suite.
- **Live smoke (once, like the AOH phase scripts):** a single script that embeds a real query against the configured
  endpoint, asserts dim==`EMBEDDING_DIM`, and does one real food match — sanitized evidence only, no raw text/keys committed.

## Cost / operational
- Runtime cost is bounded: query embedding fires **only on lexical miss**; catalog/memory embedded offline once.
- Optional: cache recent query embeddings.
- Changing `EMBEDDING_MODEL`/`DIM` later ⇒ re-embed catalog+memories (cheap at ~1.5k items) and rebuild the index.

## Execution order & gating
1. **E1** (config + client + pgvector) — prerequisite for both.
2. **E2 (L25)** — the higher-value one (food matching is the real user pain).
3. **E3 (L36)** — memory recall.
- E2 and E3 are independent after E1; L25 first is recommended.
- On completion, **report to the CHA outbox** (`docs/status-report.jsonl`); the AOH instance syncs L25/L36 → ✅.

## Acceptance (per board node)
- **L25 ✅** when E1+E2 done-whens pass and the EN↔ZH semantic cases resolve through the gate.
- **L36 ✅** when E1+E3 done-whens pass and hybrid recall returns meaning-matched memories with dedup/recency intact.

## Out of scope (Build Gate)
GraphRAG, ontology, agentic/multi-step retrieval, re-ranking models, cross-encoder scoring — none needed for
closed-set entity resolution + small-store recall. Add only if a real workload proves the need.
