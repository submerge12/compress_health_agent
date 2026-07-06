# CHA-MPV2-10 — board acceptance simulation — manifest

Assignment: CHA-MPV2-10-A1 (G0; acceptance node, ZERO production-source edits)
Completed: 2026-07-06 (session compass-health-agent; parallel with CHA-MPV2-8)

## What was added

- `tests/acceptance/board-acceptance.test.ts` — a persistent acceptance suite
  (runs under `pnpm test` via the standard vitest include) driving the v2
  planner through its PUBLIC API (`generateMealPlan`). No file under `src/**`
  was touched. READING NOTE: doneWhen's "COMMITTED acceptance script or test
  suite" is implemented as a persistent, versioned suite in `tests/acceptance/`;
  the change-set remains git-uncommitted pending review + sync, the same flow
  every prior board node used.
- Scenario evidence (synthetic profile only — 1800 kcal / 130 P / 50 F /
  200 C; no real user data):
  - `scenario-1-seafood-fatloss.json` — full generated week: day totals,
    weekly budgets, waived floors, per-entry dishes + alternates.
  - `scenario-2-preferences.json` — liked/avoided fixture slugs (picked
    dynamically from a control run), per-main use counts, pool notices.

## doneWhen mapping — ALL CRITERIA PASS (no findings)

1. Seafood-allergic fat-loss profile GENERATES — status `planned`, 21
   entries, zero seafood in any dish/side, deep-sea-fish + shellfish floors
   waived (not blocking).
2. Mean |day kcal − target| = **1.87%** ≤ 5% — computed across the 7 generated
   days and asserted (`meanAbsKcalDeviationRatio: 0.0187` in evidence).
3. Zero per-day advisories — `hardViolations` empty; every coverage `unmet`
   item is weekly-scoped (weekly_floor / protein_average / weekly_budget /
   diversity — the per-day advisory channel does not exist in v2 output);
   overview carries the "Weekly budgets:" fat/sodium/carbs report and the
   result exposes `plan.weeklyBudgets` with status fields.
4. Alternates lever-valid + rotation rules — all 14 main entries carry 1-2
   pool-drawn alternates; each alternate re-levered through the exported
   production `buildDayEntries` (kcal within MAX band, protein ≥ floor);
   plan-level rotation asserted (no main on consecutive days, ≤2×/week).
5. Preference behaviors in-journey — liked main appears exactly 2× in the
   generated week; the skipped-≥2 dish is absent from all 21 entries.
6. Evidence at `evidence/CHA-MPV2-10/` — this manifest + the two scenario
   outputs (synthetic fixtures only).
7. Gates — literal `pnpm typecheck && pnpm test` exit 0: 55 files / 362
   tests. Raw log: `.evidence-local/CHA-MPV2-10/gates.log` (CHA repo).
   Outbox start/complete canonical.

NOTE per assignment: swap_meal (nodes 8/9) is intentionally outside this
acceptance scope.

## Files written (all inside allowed_write_paths)

- tests/acceptance/board-acceptance.test.ts (new)
- evidence/CHA-MPV2-10/manifest.md, scenario-1-seafood-fatloss.json,
  scenario-2-preferences.json

Zero `src/**` edits (constraint verified: acceptance is read-only over
production source). Changes uncommitted pending review + sync.
