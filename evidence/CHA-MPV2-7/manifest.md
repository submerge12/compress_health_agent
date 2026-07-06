# CHA-MPV2-7 — alternates + grocery summary (V2-P4b) — manifest

Assignment: CHA-MPV2-7-A1 (G0; solo node, tests/** owned with extend-never-weaken constraint)
Completed: 2026-07-06 (session compass-health-agent)

## What changed

- `src/engine/meal-planner.ts`
  - `buildDayEntries` EXPORTED with a contract comment: it is the single
    lever path (protein top-up, then staple kcal) shared by primary rotation
    days, alternates vetting, and the re-lever tests. No second validation
    implementation exists (constraint honored — the tests call the same
    function production uses).
  - Alternates picker strengthened: candidates are ranked by weekly rotation
    use count ascending (`rotationUseCounts`), and once an alternate is
    accepted, higher-use candidates are not offered — so every offered
    alternate sits at the minimal substitution cost the pool allows.
    Behavior for exact-cover 7-main pools is unchanged (all counts equal).
- `src/tools/generate-meal-plan.ts` — NO change needed: the result already
  carries `procurement` (buildProcurementList), which IS the pool grocery
  summary — the week's ingredients aggregated across dishes, sides, staple
  portions, and protein top-ups, with buffered purchase amounts. This node
  adds the asserting tests.
- `tests/engine/plan-alternates-and-frequency.test.ts` — extended (nothing
  removed or weakened): new "CHA-MPV2-7 alternates re-lever + rotation rules"
  suite with a catalog-driven fixture so the levers actually engage.
- `tests/tools/generate-meal-plan-pool.test.ts` — extended: real-preset
  default profile now also asserts alternates-from-pool per entry and the
  grocery summary (presence, cross-dish aggregation, buffer >= total, and
  exact brown_rice aggregation math vs. the plan's staples/dishes/top-ups).

## doneWhen mapping

1. 1-2 alternates from the selected pool — engine test (7-main pool,
   membership asserted per alternate) AND tool test on the real preset
   library (all 14 main entries carry 1-2 alternates, all inside
   result.pool.mains). READING NOTE: "every plan entry" = every main-meal
   (lunch/dinner) entry; breakfasts carry no alternates by design, per the
   pre-existing review-verified assertion "breakfast entries carry no
   alternates", which this node must not weaken.
2. Re-run BOTH levers per alternate — the new engine test substitutes each
   alternate and calls the exported `buildDayEntries` (the production lever
   path): day kcal within the MAX energy band, protein >= floor, staple on
   the 30g lattice; 14+ alternates vetted per run.
3. Rotation rules — asserted on the substituted week's main matrix: (a) no
   main on two consecutive days, anywhere, strictly; (b) <=2 uses/week.
   SEMANTICS NOTE: strict post-substitution <=2 is mathematically
   unsatisfiable for an exact-cover 7-main rotation (all 7 mains already
   hold two slots; any substitution creates a third use). Implementation +
   test therefore enforce the strongest satisfiable form: alternates are
   drawn at the minimal weekly use count available, so substitution stays
   <=2 whenever the pool offers an under-used main — asserted strictly on an
   8-main fixture (under-used mains exist on 4 of 7 days); on days where no
   under-used candidate is reachable, only the substituted dish may reach
   the unavoidable third use (capped and asserted). This matches the swap
   handler's production semantics (day-gates + safety, weekly budgets
   reporting-only) and the design acceptance "alternates present and
   lever-valid".
4. Grocery summary in result — `result.procurement` asserted: aggregated
   across the week (item with dishCount >= 2), staples/top-ups included
   (brown_rice total equals the sum over plan entries), buffered >= total.
5. Node-3/5/6 behaviors unchanged — seafood-allergy scenario still PLANS,
   property/rotation test green, preference-pools tests green; zero existing
   assertions modified or deleted (extend-only).
6. Gates — literal `pnpm typecheck && pnpm test` exit 0: 54 files / 360
   tests. Raw log: `.evidence-local/CHA-MPV2-7/gates.log` (CHA repo).
7. Outbox start/complete — canonical schema; this manifest at
   evidence/CHA-MPV2-7/ (CHA repo + AOH mirror).

## Files written (all inside allowed_write_paths)

- src/engine/meal-planner.ts
- tests/engine/plan-alternates-and-frequency.test.ts
- tests/tools/generate-meal-plan-pool.test.ts
- evidence/CHA-MPV2-7/manifest.md (this file)

`src/tools/generate-meal-plan.ts` unchanged (grocery summary already present
in the result; verified by the new assertions). Changes are uncommitted in
the CHA working tree pending review + sync.
