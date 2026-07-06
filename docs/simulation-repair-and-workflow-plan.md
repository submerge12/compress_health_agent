# Repair plan: simulation findings + workflow optimization

Source: a full-journey simulation (2026-07-03) driving the real engine/tool functions with the
seed catalog and preset dishes — profile → preference interview → logging → recommendation →
7-day plan. Four product problems surfaced (Part A). Part B reviews the user-facing workflow for
ease of use, data collection, and better daily meal arrangement.

Priority: **R2 (safety) → R1 (blocks headline flow) → R3 (default-locale UX) → R4 (tuning)**,
then W-items (W1/W4/W6 are prompt-only and can ship immediately).

---

## Part A — Repairs

### R1 — [High] Seafood allergy alone makes meal plans impossible

**Observed.** Default fat-loss profile (1771 kcal / 140g protein → 112g floor) + `allergens:
["seafood"]` → `cannotSatisfy: protein_floor` every day (106.8g max). Without the allergy the plan
generates. Root cause: the two highest-protein mains are both seafood
(`chicken_shrimp_salad_soup` P48.6, `pan_seared_bream_rice` P40.3); best non-seafood day tops out
~103–107g. **There is no chicken-breast main at all.**

**Repair.**
1. Add 2–3 high-protein non-seafood mains to `src/data/preset-dishes.ts`, calibrated like existing
   presets (e.g. 黑椒鸡胸饭 ~P45, 番茄炖鸡胸 ~P42, 卤牛腱饭 ~P40). Classification picks them up
   automatically; no schema change.
2. (Phase 2, optional) protein top-up lever in `meal-composition` (egg/tofu add-on) mirroring the
   staple kcal-lever, so feasibility doesn't depend solely on pool composition.

**Test.** Planner test mirroring the simulation: seafood allergen + 140g target → plan generates,
protein floor met, zero seafood leaks.
**Acceptance.** A seafood-allergic default fat-loss user gets a plan on day one.

### R2 — [High, SAFETY] The 2302-food library seeds with zero allergen tags

**Observed.** `allergenTagsForFood` (`src/engine/food-taxonomy.ts:30`) only recognizes English
slugs/categories (`"seafood"`, `"dairy"`, `FISH_SLUGS`…). Library rows have slugs `xlsx_*` and
Chinese categories (鱼/虾/乳类) → all 2302 rows get empty `allergen_tags`. A user dish built from a
library fish/shrimp ingredient carries no tag → **dish-level allergen filtering leaks** for exactly
the long-tail foods the library exists to cover.

**Repair.**
1. Extend `allergenTagsForFood` to recognize the library's Chinese `category_zh`/`category_code`
   and name keywords: 鱼/带鱼/鲳/鳕… → `seafood`+`fish`; 虾/蟹/贝/牡蛎/蛤/鱿/章鱼/软体 →
   `seafood`+`shellfish`; 奶/乳/芝士 → `dairy`; 大豆/豆腐/豆浆/腐竹 → `soy` (NOT bare 豆 — 绿豆/红豆
   are pulses, not soy allergens); 坚果/果仁/杏仁/腰果/核桃 → `nuts`. Ingredient names only (safer
   than dish names — no 鱼香肉丝 false positives).
2. `run-seed.ts` library insert uses `onConflictDoNothing` → existing rows never receive new tags.
   Change to `onConflictDoUpdate` for `allergen_tags` (mirror `seed.ts:430`'s excluded-column
   pattern) so a re-seed refreshes tags.
3. Interim guard (optional hardening): in `propose_dish`, when the user has allergen memories and
   an ingredient has empty `allergen_tags` AND an `xlsx_*` slug, flag it as *unverified for
   allergens* in the review output.

**Test.** Unit: Chinese categories/names map to groups; pulses don't map to soy. Integration: a
dish built from a library shrimp row is excluded for a seafood-allergic user.
**Ops.** Requires re-seed in every environment (pi-harness side: operational only — `pnpm db:seed`
+ rebuild; no `tools.ts` change).
**Acceptance.** No allergen-tagged-empty seafood row in `food_items` after re-seed; the leak test
passes.

### R3 — [Medium] Chinese food matching fails in the default locale

**Observed.** `matchFood("鸡胸肉")`, `"鸡胸"`, `"蘑菇"`, `"香菇"` → no match against the curated
seed (alias only 鸡胸脯肉); the library adds 蘑菇 rows but also a duplicate 鸡胸脯肉 → exact-tie →
`needsConfirmation` for the most common food. Impact: the Chinese version of an ordinary meal log
is rejected while the English version works; interview likes/dislikes silently fail to resolve.

**Repair.**
1. Short-term aliases: add an `aliases` column to `seed/ingredients.csv` (鸡胸肉/鸡胸,
   蘑菇→mushroom family, 西红柿/番茄, …) and seed it into the existing `food_aliases` table
   (`loadMealCatalog` already reads it; nothing populates it today).
2. Dedupe: when inserting library rows, skip (or record as alias of the curated slug) any row whose
   `name_zh` exactly matches a curated food's name/alias — kills the 鸡胸脯肉 ambiguity.
3. Systematic fix: **finish the in-flight embedding fallback** (`src/embeddings/`,
   `embed-catalog`, `food-semantic-fallback`, migrations 0003/0004 — currently uncommitted). That
   is the durable answer to CJK near-miss matching.

**Test.** `matchFood("鸡胸肉")` resolves to `chicken_breast`; `"鸡胸脯肉"` is not ambiguous; the
simulated Chinese meal log (`鸡胸肉200克 + 糙米80克`) succeeds.

### R4 — [Medium] Plan tuning: fat always over, kcal always under

**Observed** (feasible no-prefs plan, target 1771 kcal / 42g fat): every day breaches the fat
ceiling (52.8–66.9g) and every day undershoots kcal (1577–1683, −5% to −11%, never over). The fat
advisory is permanent noise; the staple lever is biased low.

**Repair.**
1. Diagnose the staple-lever bias in `meal-planner.ts` combo selection (why totals settle 5–11%
   under target); let the lever top up toward the target midpoint. This also dilutes fat as % of
   energy.
2. Add lean variants (steamed/less-oil) of the fattiest presets, or trim oil seasoning grams.
3. Give the fat advisory a tolerance (fire only above `target × 1.15`) so it is signal, not noise.

**Test.** Default-profile no-prefs plan: mean |kcal − target| ≤ 5%; fat advisory fires on ≤ 2 days.

### Related contradiction to resolve alongside R3

The prompt's Hard Rule says "estimate conservatively and note the uncertainty" for ambiguous
meals, but the tool **hard-rejects** unmatched foods (`外卖麻辣烫一份` → RangeError). Reconcile via
W3 below (fallback estimate with uncertainty flag) once the embedding fallback lands.

---

## Part B — Workflow optimization

### The flow today (from `src/agent.ts` systemPrompt + scheduled tasks)

get_profile/recall → (new users) physical profile + allergy-first interview + default basket →
free-text `log_meal` → `daily_summary` → `weekly_report` on request → `generate_meal_plan` on
request → `meal_checkin` at 8:30/12:30/18:30 crons + midnight summary.

### What the data says

- **`meal_checkin` "followed" already auto-logs a complete meal** (nutrition copied from the plan
  entry) — the single lowest-friction logging path in the system, and the prompt doesn't exploit
  it.
- **Check-in outcomes are collected but never used.** Nothing reads skipped/substituted history
  back into planning; `recentDishSlugs` exists in the engine but the smart wrappers never populate
  it. The behavior loop is open: the best signal for "what should tomorrow's meals be" is thrown
  away.
- Free-text logging is the highest-friction, highest-failure surface (R3), yet the workflow leans
  on it even when a plan exists.

### W1 — Check-in-first logging (prompt-only, ship now)

Once a plan exists, drive all meal logging through the three scheduled check-ins: "跟计划吃的吗?" →
one word (`followed`) = full log; `substituted` asks only *what changed*; `skipped` is one word.
Prompt change: instruct the agent never to ask a user to re-describe a planned meal, and to treat
check-in answers as the primary log. Free-text `log_meal` remains for off-plan meals only.

### W2 — Close the behavior loop (the highest-value change)

Mine check-in history into planning signals, inside `loadUserPreferences` / the smart wrappers (no
new tool → no pi-harness change):

- Dish **skipped ≥2 times** → soft-avoid (score penalty; optionally auto-`remember` a
  low-confidence dislike and ask the user to confirm once).
- **Substitutions**: resolve `actualDescription` foods → add to `preferredIngredients` (revealed
  preference beats stated preference).
- Populate `recentDishSlugs` from the last 7 days of plan entries + diet logs so the existing
  recency penalty actually fires across plan generations.

Result: every check-in makes next week's plan measurably better — the flywheel the product needs.

### W3 — Never lose a log (rides the embedding work)

Unmatched food → conservative fallback estimate + `uncertain: true` flag instead of hard reject
(resolves the Hard-Rule contradiction). The agent notes the uncertainty and offers to refine when
the user has time. Every meal becomes data; none bounce.

### W4 — Slim the onboarding (prompt-only, ship now)

Required up front: physical profile + **allergies only**. Everything else defaults; likes/dislikes
are *learned* via W2 within the first week instead of interviewed. Keep the full interview available
as an optional "调整偏好" flow. Rationale: the interview's stated preferences are lower-quality than
one week of revealed behavior, and the long first session is the likeliest drop-off point.

### W5 — Weekly report feeds forward (prompt + existing data)

`weekly_report` already computes adherence and gaps. Add prompt guidance: after presenting it, ask
at most **one** forward-looking question ("蛋白质连续三天没达标，下周多排鸡胸/豆腐可以吗?") and store
the answer via `remember` so the next `generate_meal_plan` consumes it. Review → adjustment becomes
a single tap instead of a conversation.

### W6 — One-question proactive checks (prompt-only, ship now)

Each scheduled check asks exactly one thing (the check-in for that meal). Midnight: auto
`daily_summary`; piggyback a weight prompt at most weekly. Never stack questions in a proactive
message — proactive friction is how users start ignoring the agent.

### Sequencing & boundary

| Item | Where | pi-harness |
|---|---|---|
| W1, W4, W6 | `src/agent.ts` prompt | none (ships via `pnpm build`) |
| W2 | `candidate-loader.ts` + smart wrappers + repo query | none (internal) |
| W3 | `nutrition-estimate` + embeddings work | none |
| W5 | prompt (+ optionally richer weekly_report return) | none |

Recommended order: **W1+W6 (immediate) → R2 → R1 → W2 → R3 (+W3) → R4 → W4/W5.**
