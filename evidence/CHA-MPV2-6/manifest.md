# CHA-MPV2-6 — preference-frequency pools (V2-P4a) — manifest

Assignment: CHA-MPV2-6-A1 (G0, parallel with CHA-MPV2-5, disjoint write scopes)
Completed: 2026-07-06 (session compass-health-agent)

## What changed

- `src/engine/pool-selection.ts`
  - New exported `WeeklyPoolPreferences extends RecipePreferences` carrying
    `likedDishSlugs` — declared pool-side so the W2 signal flows from
    candidate-loader through untouched call sites via structural typing
    (node-5-owned `generate-meal-plan.ts` and shared `recipe-engine.ts` were
    NOT edited).
  - Skipped>=2 (`avoidedDishSlugs`) mains are now EXCLUDED from the pool
    outright (previously 0–1 last-resort slots): exclusion notice emitted,
    adaptive minimums shrink to the usable set, all-excluded => cannotSatisfy
    with "re-enable" suggestion.
  - Weekly floors starved only by the skip exclusion are WAIVED with the
    honest reason (safety-filter waivers unchanged, exact reason strings
    preserved).
  - Liked mains are seated before general fill; pool membership at <=7 mains
    guarantees >=2 rotation slots in the 14-slot week. Precedence fixed and
    noticed: safety > skipped>=2 > liked.
- `src/tools/candidate-loader.ts`
  - `loadUserPreferences` returns `WeeklyPoolPreferences`; mines
    `likedDishSlugs` from (a) preference memories naming a preset dish
    (checked before ingredient/seasoning resolution) and (b) followed>=2
    plan check-ins in the lookback window (mirror of skipped>=2).

## doneWhen mapping

1. Liked mains >=2 slots/week — `tests/engine/preference-pools.test.ts`
   ("seated ahead of better-ranked filler" + ">=2 slots in the generated week").
2. Skipped>=2 excluded — same file ("excluded from the pool outright"); the
   pre-existing out-of-scope suite `plan-alternates-and-frequency.test.ts`
   still passes unedited (its `<=1` assertion holds at 0).
3. Safety beats preference — "liked allergen-tagged main never enters the
   pool" (+ notice); liked∩skipped => skip wins (extra fixture).
4. W2 fixtures green — 6 new pool fixtures + 2 loader mining tests.
5. Node-3 behaviors unchanged — `tests/engine/pool-selection.test.ts`
   (allergen filters, weekly-floor waivers, lever-aware feasibility) passes
   without modification.
6. Gates — literal `pnpm typecheck && pnpm test` exit 0: 55 files / 364 tests.
   Raw log: `.evidence-local/CHA-MPV2-6/gates.log` (CHA repo).
7. Outbox start/complete — canonical schema, atomic single-line appends.

## Files written (all inside allowed_write_paths)

- src/engine/pool-selection.ts
- src/tools/candidate-loader.ts
- tests/engine/preference-pools.test.ts (new)
- tests/tools/candidate-loader.test.ts
- evidence/CHA-MPV2-6/manifest.md (this file)

Changes are uncommitted in the CHA working tree pending review + sync.
