# Execution Plan — simulation repairs + workflow optimization

**Date:** 2026-07-03
**Detail source:** `docs/simulation-repair-and-workflow-plan.md` (R1–R4 findings + W1–W6 workflow
items). This doc is the *processing plan*: sequencing, verification, and **which component owns
what** (CHA / pi-harness / AOH).
**Related in-flight work:** L25/L36 embedding fallbacks (`docs/l25-l36-embedding-fallback-plan.md`,
uncommitted in the tree) — R3/W3 build on it.
**Still-pending pi-harness edits:** `docs/pi-harness-pending-changes.md` Changes 1–2.

---

## Component responsibilities (the short answer)

| Component | Role in this plan |
|---|---|
| **CHA** (compass-health-agent) | **Implements everything in R1–R4 and W1–W6.** No item adds a tool or changes tool params, so no new framework surface is created. |
| **pi-harness** | **(a) Two already-pending `tools.ts` code edits** (Change 1: add-dish role fields; Change 2: register `get_profile`) — Change 2 is required for the returning-user/W-flow to function through the framework. **(b) Environment ops**: apply migrations, re-seed, set embedding env vars, rebuild. No *new* code edits arise from R/W items. |
| **AOH** (agent-orchestration-harness) | **Governance only — no implementation.** Register these items as nodes on the EXECUTION-DAG board; CHA reports `start`/`complete` per node via `docs/status-report.jsonl` (outbox convention, one JSON per event, evidence required on complete); AOH reviews/gates and syncs the board. |

Rule of thumb (unchanged): pi-harness code changes only when a tool is added/removed or its params
change. Everything here ships to the runtime via `pnpm build` + DB ops.

---

## Phase sequence

Order: **P0 → P1 → P2 → P3 → P4 → P5**. P0 and P1 are independent and can run in parallel.

### P0 — Prompt-only workflow wins (W1 + W6) — CHA

- **W1 Check-in-first logging:** once a plan exists, the three scheduled check-ins are the primary
  logging path ("followed" already auto-logs the full planned meal); never ask the user to
  re-describe a planned meal; free-text `log_meal` only for off-plan meals.
- **W6 One-question proactive checks:** each cron message asks exactly one thing; midnight = auto
  daily summary; weight prompt at most weekly; never stack questions.
- **Files:** `src/agent.ts` (systemPrompt) + `tests/agent.test.ts` prompt assertions.
- **Verify:** typecheck + tests; manual read of the two new prompt sections.
- **pi-harness:** none (ships via `pnpm build`).

### P1 — R2 allergen-tag safety — CHA code + pi-harness ops

- Extend `allergenTagsForFood` (`src/engine/food-taxonomy.ts`) to recognize Chinese
  `category_zh`/`category_code` and ingredient-name keywords (鱼/虾/蟹/贝/牡蛎/蛤/鱿/章鱼 →
  seafood groups; 奶/乳/芝士 → dairy; 大豆/豆腐/豆浆/腐竹 → soy, **not** bare 豆; 坚果/果仁/杏仁/
  腰果/核桃 → nuts).
- `src/db/run-seed.ts`: library insert `onConflictDoNothing` → `onConflictDoUpdate` for
  `allergen_tags` so re-seed refreshes existing rows.
- Optional hardening: `propose_dish` flags `xlsx_*` ingredients with empty tags as *unverified for
  allergens* when the user has allergen memories.
- **Tests:** taxonomy unit tests (Chinese categories; pulses ≠ soy); integration: library-shrimp
  dish excluded for seafood allergy.
- **pi-harness ops:** `pnpm db:seed` against the shared DB + `pnpm build` (no `tools.ts` edit).
- **Acceptance:** no seafood row with empty `allergen_tags` after re-seed; leak test green.

### P2 — R1 protein-feasible pool — CHA

- Add 2–3 high-protein non-seafood mains to `src/data/preset-dishes.ts` (e.g. 黑椒鸡胸饭 ~P45,
  番茄炖鸡胸 ~P42, 卤牛腱饭 ~P40), calibrated like existing presets.
- Phase 2 (optional, separate node): protein top-up lever (egg/tofu add-on) in `meal-composition`.
- **Tests:** planner test — seafood allergen + 140g protein target → plan generates, floor met,
  zero seafood leaks (mirrors the simulation).
- **pi-harness:** `pnpm build` pickup only (presets are code, no re-seed).

### P3 — W2 behavior loop (the flywheel) — CHA

- In `loadUserPreferences` / smart wrappers (`src/tools/candidate-loader.ts`, `handlers.ts`):
  - dish skipped ≥2 times in plan-entry history → soft-avoid (score penalty; optionally auto-
    `remember` low-confidence dislike, confirm once);
  - substitution `actualDescription` foods → `preferredIngredients` (revealed preference);
  - populate `recentDishSlugs` from last-7-day plan entries + diet logs so the existing recency
    penalty fires across generations.
- Needs one repo query over `meal_plan_entries` statuses (internal; no tool change).
- **Tests:** loader unit tests with mocked history; planner test that a twice-skipped dish is
  demoted.
- **pi-harness:** none.

### P4 — R3 + W3 matching & never-lose-a-log — CHA (+ L25/L36 in-flight)

- **R3 short-term:** `aliases` column in `seed/ingredients.csv` (鸡胸肉/鸡胸, 蘑菇…) seeded into the
  existing `food_aliases` table (read by `loadMealCatalog`, currently never populated); library
  dedupe — rows whose `name_zh` matches a curated food's name/alias become aliases of the curated
  slug instead of duplicate `food_items` (kills the 鸡胸脯肉 ambiguity).
- **R3 systematic:** finish + commit the in-flight **L25/L36 embedding fallback** (own plan doc;
  already partially in the tree with migrations 0003/0004).
- **W3:** unmatched food → conservative fallback estimate + `uncertain: true` flag instead of hard
  reject (resolves the "estimate conservatively" Hard-Rule vs tool-throw contradiction); agent
  offers to refine later.
- **Tests:** `matchFood("鸡胸肉")` → `chicken_breast`; `鸡胸脯肉` unambiguous; Chinese meal log
  succeeds end-to-end; unmatched food logs with uncertainty instead of bouncing.
- **pi-harness ops:** `pnpm db:push` (0003/0004) + re-seed + set `EMBEDDING_BASE_URL` /
  `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` in the runtime `.env` + `pnpm build`.

### P5 — R4 plan tuning + W4/W5 polish — CHA

- **R4:** diagnose staple-lever low bias (all days −5–11% kcal); lever tops up toward target;
  lean preset variants / trim oil grams; fat advisory tolerance (fire only > target × 1.15).
  Acceptance: default no-prefs plan mean |kcal−target| ≤ 5%, fat advisory ≤ 2 days.
- **W4 slim onboarding:** required = physical profile + allergies only; preferences learned via
  P3's loop; full interview becomes optional "调整偏好".
- **W5 weekly report feeds forward:** after `weekly_report`, at most one forward-looking question;
  answer stored via `remember`, consumed by next `generate_meal_plan`.
- **pi-harness:** none.

### Parallel (pi-harness session, any time) — pending Changes 1–2

From `docs/pi-harness-pending-changes.md` (the only pi-harness *code* work):
1. `tools.ts`: add optional `role`/`sideKind`/`selfContained` to `propose_dish`/`save_dish`.
2. `tools.ts`: register `get_profile` (read-only, `Type.Object({})`).
Then `npm run typecheck && npm test && npm run build` in pi-harness. Change 2 gates the
returning-user flow (and P0/P5 prompt steps that reference `get_profile`) working through the
framework.

---

## Dependency notes

- P1 (R2) before P4's dedupe/alias re-seed is convenient (single re-seed covers both) but not
  required.
- P3 (W2) is independent of P1/P2; it multiplies in value after P0 (check-ins become the primary
  data source).
- W4 (slim onboarding) intentionally **after** P3 — don't remove the interview until the behavior
  loop replaces it as the preference source.
- The embeddings work (P4) is already mid-flight on the AOH board as L25/L36 — finish under those
  nodes rather than re-registering.

## AOH governance hooks

- Register R1, R2, R3(short-term), R4, W1+W6, W2, W3, W4, W5 as board nodes (AOH assigns IDs; CHA
  must not edit the board directly).
- CHA appends `start`/`complete` events to `docs/status-report.jsonl` per node, with evidence
  strings (typecheck/test/build results, key test names) matching the existing L2/L3 entries.
- Suggested review gates for AOH: P1 (safety — leak test), P3 (behavior-loop correctness), P4
  (embedding cost/PII posture already decided under D1).

## Dependency DAG

Hard edge (`──▶`): the downstream task cannot be implemented/verified before the upstream one.
Soft edge (`┈┈▶`): implementable independently, but loses most of its value without the upstream.
Everything with no incoming hard edge is a **root** and can start immediately, in parallel.

```
ROOTS:  W1   W6   R1   R2   R3s   R4   L25/L36(in-flight)   C1   C2

W1 ┈┈▶ W2                    (more check-in data to mine)
R3s ┈┈▶ W2                   (Chinese substitution descriptions resolve)
W1 ┈┈▶ W5                    (adherence data makes the report question meaningful)

W2 ──▶ W4                    (locked: interview removed only after behavior loop replaces it)
C2 ──▶ W4(e2e)               (get_profile must be registered for returning-user flow via pi-harness)

L25 ──▶ W3                   (fallback estimate rides the embedding client)

R2 ──▶ OPS-seed              (re-seed applies refreshed allergen tags)
R3s ──▶ OPS-seed             (same re-seed loads aliases + dedupe — batch them)
L25/L36 ──▶ OPS-env          (db:push 0003/0004 + EMBEDDING_* env vars)
```

Isolated tasks (no edges at all): **W6, R1, R4, C1** — schedule anywhere.

## Task table

| Task | Doc § | Owner |
|---|---|---|
| W1 check-in-first logging | `simulation-repair-and-workflow-plan.md` §W1; here §P0 | CHA |
| W6 one-question proactive checks | same §W6; here §P0 | CHA |
| R2 allergen tags (taxonomy + seed upsert) | same §R2; here §P1 | CHA (code) |
| R1 high-protein non-seafood presets | same §R1; here §P2 | CHA |
| W2 behavior loop (check-in mining) | same §W2; here §P3 | CHA |
| R3s Chinese aliases + library dedupe | same §R3 items 1–2; here §P4 | CHA (code) |
| L25/L36 embedding fallbacks | `l25-l36-embedding-fallback-plan.md` §E1/L25/L36 | CHA (code) |
| W3 never-lose-a-log fallback estimate | `simulation-repair-and-workflow-plan.md` §W3; here §P4 | CHA |
| R4 plan tuning (lever/lean/tolerance) | same §R4; here §P5 | CHA |
| W4 slim onboarding | same §W4; here §P5 | CHA |
| W5 weekly report feeds forward | same §W5; here §P5 | CHA |
| C1 add-dish role fields in `tools.ts` | `pi-harness-pending-changes.md` §Change 1 | pi-harness |
| C2 register `get_profile` in `tools.ts` | `pi-harness-pending-changes.md` §Change 2 | pi-harness |
| OPS-seed re-seed shared DB (after R2+R3s) | here §Ops runbook | pi-harness |
| OPS-env db:push 0003/0004 + `EMBEDDING_*` (after L25/L36) | here §Ops runbook | pi-harness |

## Ops runbook (pi-harness environment, once P1/P4 land)

```bash
cd G:/compass-health-agent
pnpm build                 # publish dist for the file: link
pnpm db:push               # migrations 0002 (already), 0003, 0004
pnpm db:seed               # refreshed allergen tags + aliases + dedupe
# runtime env (.env in pi-harness): EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL / EMBEDDING_DIM
cd G:/pi-harness && npm run typecheck && npm test && npm run build
```
