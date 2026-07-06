# CHA-MPV2-8 — swap_meal bounded to pre-vetted alternates — manifest

Assignment: CHA-MPV2-8-A1 (G2 APPROVED: HD-CHAMPV2-8-G2-SWAP-TOOL-SURFACE — alternates-only
substitution, repository-layer writes)
Completed: 2026-07-06 (session compass-health-agent; parallel with CHA-MPV2-10)

## A2 REPAIR (2026-07-06, after R6 FAIL on C1)

R6's finding: the A1 recomputed candidate set was a strict SUPERSET of the pre-vetted
alternates — it drew from the FULL dish catalog (`loadCandidateDishes`) instead of the
selected weekly pool, and never consulted `preferences.avoidedDishSlugs`. Both correct.

Repair (single-source-of-truth, no inline pool logic):

- `src/tools/generate-meal-plan.ts` — `buildPoolRequest` EXPORTED with a contract
  comment: the one place pool-request wiring lives; generation and swap both use it.
- `src/tools/handlers.ts` (`handleSwapMeal`) — derives the week's selected pool via
  `selectWeeklyPool(buildPoolRequest(...))` with the stored profile targets, the
  recovered staple, the swap-time preferences, and the same candidates/floors
  generation uses. Enforcement added:
  - POOL MEMBERSHIP: a target outside `pool.mains` is rejected ("outside this
    week's selected pool (…)"), with a distinct message when the reason is the
    skipped-≥2 exclusion ("skipped twice or more recently and is excluded from
    this week's pool" — node-6's `avoidedDishSlugs` exclusion arrives through
    `selectWeeklyPool` itself, not an inline reimplementation).
  - If the pool cannot be established (`cannotSatisfy`), the swap is refused with
    the pool's reason and a regenerate suggestion — never a fallback to catalog-wide
    sourcing.
  - `boundedCandidates` (min-use scan + refusal suggestions) now sources from
    `pool.mains` instead of the catalog.
  - ORDERING NOTE: the membership rejection fires after the lever refusal, so a
    swap that would break the day keeps its review-verified refusal copy
    ("would break the day", asserted by the untouched display-server suite);
    enforcement is unaffected — nothing outside the pool is ever persisted.
- `tests/handlers/swap-meal.test.ts` — two NEW zero-writes rejection tests:
  (a) `black_pepper_chicken_breast` — safe, collision-free, lever-valid on the
  light fixture day, but outside the lean-tilt weekly pool → rejected, no writes;
  (b) `chaoshan_beef_soup` with two skipped check-ins in the W2 lookback window →
  `avoidedDishSlugs` → excluded from the pool → rejected with the skip reason, no
  writes.
- `docs/pi-harness-pending-changes.md` — Change 3 candidate-sourcing description
  amended (pool membership + skip exclusion).

A1-passed behaviors verified unregressed: all A1 bounded-rejection tests, the
repository-layer round-trip + meal_checkin attachment, `resolveSwapDay` validity
assertions, and the out-of-scope display-server + agent + acceptance suites all pass
UNEDITED. A2 gates: literal `pnpm typecheck && pnpm test` exit 0 — 55 files /
368 tests. Raw log: `.evidence-local/CHA-MPV2-8/gates-a2.log`.

---

## A1 manifest (superseded on C1 by the A2 repair above; C2–C7 record stands)

## Context

swap_meal (handler + repository update + registry + profile registration) already existed from
V2-P5 with OPEN semantics: any safe candidate was accepted if the day re-levered valid. This node
BOUNDS it per the G2 decision: the target must be one of the entry's pre-vetted alternates.

Alternates are not persisted (`meal_plan_entries` has no alternates column; the schema file is
outside this node's write scope, consistent with the earlier no-migration decision), so the bound
is enforced by RECOMPUTING the alternate-defining rules from stored state at swap time — the same
rules the planner used to offer alternates (node 7): pool-drawn + safe (pre-existing checks),
collision-free with the day's and adjacent days' mains, lever-valid for the whole day through the
production re-lever path (`resolveSwapDay`, two-meal staple parity), and at the minimal weekly use
count available in the surrounding week ([date-3, date+3] window, skipped rows excluded, the
swapped-out row not counted).

## What changed

- `src/tools/handlers.ts` (`handleSwapMeal`)
  - New surrounding-week fetch (`listMealPlanEntriesRange`, date±3).
  - Collision rejection: target planned on the same day or an adjacent day →
    "not one of this entry's pre-vetted alternates" (before any write).
  - Minimal-use rejection: target already used nearby while a less-used,
    collision-free, lever-valid alternate exists → rejected naming the
    currently pre-vetted swaps. Zero-count fast path: no candidate scan on
    the common case.
  - Refusal suggestions (`currently valid swaps:`) now drawn from the BOUNDED
    set (collision-free, lever-valid, minimal use) instead of all candidates.
  - Handler doc updated to the bounded contract.
- `src/agent.ts` — tool description + prompt step 6b updated: swaps are
  limited to the entry's pre-vetted alternates; non-alternate targets are
  rejected with the currently-valid list.
- `docs/pi-harness-pending-changes.md` — Change 3 AMENDED for node 9:
  bounded semantics, updated description string + schema comment, write-scope
  declaration (meal_plan_entries via repository layer), and a bounded-
  rejection verification step. G:/pi-harness was NOT touched.
- `tests/handlers/swap-meal.test.ts` — extended (nothing weakened): adjacent-
  day rejection, same-day rejection, higher-use-count rejection (all assert
  no write occurred), and a full swap→meal_checkin round-trip (repository
  update captured, status update + diet log attach to the swapped entry with
  the swapped dish name).

## doneWhen mapping

1. Tool implemented with alternates-only semantics — handler bounded as
   above; repository update (`updateMealPlanEntryDish`), tool registry
   (`src/index.ts`) and profile registration (`src/agent.ts`) verified
   present and updated where semantics text changed.
2. Tests green — swap round-trip via the repository layer; swapped day
   re-levers VALID through the single production path (`resolveSwapDay`:
   kcal band + protein floor, staple lattice asserted in the pre-existing
   round-trip test); meal_checkin attaches to the swapped entry
   (status update + diet log + swapped dish name asserted).
3. Non-alternate targets REJECTED with clear errors — three rejection tests
   (same-day, adjacent-day, higher-use-count), each asserting zero writes.
4. Change 3 spec in docs/pi-harness-pending-changes.md — amended for node 9
   (tool name, schema, handler wiring, write scope, verification incl. the
   bounded rejection).
5. Node-3/5/6/7 behaviors unchanged, extend-only — full suite green
   including the untouched out-of-scope `tests/server/display-server.test.ts`
   (its swap fixtures satisfy the bounded semantics naturally) and
   `tests/agent.test.ts`; the node-10 acceptance suite also passes.
6. Gates — literal `pnpm typecheck && pnpm test` exit 0: 55 files / 366
   tests. Raw log: `.evidence-local/CHA-MPV2-8/gates.log` (CHA repo).
7. Outbox start/complete canonical; this manifest at evidence/CHA-MPV2-8/
   (CHA repo + AOH mirror).

## Files written (all inside allowed_write_paths)

- src/tools/handlers.ts
- src/agent.ts
- docs/pi-harness-pending-changes.md
- tests/handlers/swap-meal.test.ts
- evidence/CHA-MPV2-8/manifest.md (this file)

Changes uncommitted in the CHA working tree pending review + sync. When the
review lands, the alignment-branch contract applies (handler surface text
changed in `dist/tools/handlers.d.ts` only via doc comments; signatures are
unchanged, so no pi-harness rebuild is strictly required — node 9 handles the
description-string update).
