# Reference menu evaluation set (v2 contract)

**Date:** 2026-07-05 (rewritten after design discussion with the user; supersedes the 1800-kcal draft)
**Status:** Agreed in discussion. Reference structure + worked example authored; scoring harness not yet built.
**Role:** Evaluation reference set for `generate_meal_plan` against the
[rotation-planner v2 design](rotation-planner-v2-design.md), extended by the decisions below. The
reference material is a **calibration anchor, not an answer key**: the agent is never diffed
against a fixed menu. It is (1) a *feasibility witness* — every threshold is proven reachable with
the user's actual foods; (2) a *quality anchor* for graded dimensions; (3) the *source of the
rubric*.

## Decisions from the design discussion (2026-07-05)

1. **Dishes are templates, not fixed servings.** Each dish has two scalable axes — primary protein
   and staple — solved arithmetically against daily targets. Vegetables/garnish fixed; seasonings
   never scale by optimization.
2. **Portions are expressed in natural units** (`seed/natural_units.csv`): 碗, 块, 个, 把, 杯, 片.
   Strict gram quantization rejected as unrealistic. Solving happens on the unit lattice
   (half-units allowed: 半碗, 半块).
3. **Asymmetric rounding policy (fat-loss direction):** protein rounds **up** (floor), staple
   rounds to **nearest** within the energy band, fat top-ups round **down** (ceiling).
4. **Breakfast = enumerated variants** (protein option × staple option, ~8 solid combos), not an
   in-engine slot composer. Substitutions ride v2's alternates: 换蛋白 (same staple, other
   protein), 换主食 (same protein, other staple). Structurally-light combos are dropped, not
   bumped.
5. **Nuts are the fat lever:** a baseline 把 (10–15 g) is part of yogurt-variant breakfasts
   (macro-neutralizing the egg→yogurt swap); an additional conditional top-up serves the weekly
   fat budget. Lever order: mains → nut top-up → protein scaling → staple last (kcal re-trued).
6. **潮汕牛肉汤 added as the lean beef option** (clear broth, no 沙茶 dip — user confirmed). It
   alone reconciles the red-meat weekly floor with the fat budget.
7. **No pork** — persona-level forbidden category (fat-loss preference), not a data gap.
8. **红烧/braise class is a budget-absorbed exception**, ≤1×/week in the default pool, not a
   routine member.
9. **Personal labels override seed values** (user's Greek yogurt: 11 g protein/100 g vs seed 3.2;
   Deya milk: 1.5 g fat/100 ml vs seed 3.6). Variants regenerate when labels change.

## Primary persona (the user)

23 y male, 173 cm, 70 kg. Revised Harris-Benedict BMR ≈ 1726 × 1.2 activity = 2071 TDEE,
−300 slow-loss deficit. This reproduces the profile already at
`tests/tools/generate-meal-plan-pool.test.ts:163` except fat, adjusted 0.6 → 0.7 g/kg by agreement.

| Parameter | Value | Derivation |
| --- | --- | --- |
| Daily kcal target | 1771 | HB × 1.2 − 300 |
| Energy band | 1559–1983 | ±12% (`ENERGY_TOLERANCE_RATIO`) |
| Weekly avg kcal | 1771 ± 3% | lattice rounding must cancel, not drift |
| Protein target / floor | 140 g / 112 g | 2 g/kg; floor = 0.8 × target (`PROTEIN_FLOOR_RATIO`) |
| Fat ceiling | 49 g/day → **343 g/week** | 0.7 g/kg (user-accepted adjustment from 42) |
| Carbs | ~192 g/day → ~1348 g/week | remainder |
| Sodium | ≤2300 mg/day, 16 100 mg/week | `SODIUM_CAP_MG` |
| Forbidden | pork | preference (fat-loss phase) |
| Weekly floor | red_meat ≥ 2 main-slots | served by 潮汕牛肉汤 |

Secondary persona for generic regression: the 1800 kcal / 100 g suite default (fixed-portion
presets). Regression scenario retained: seafood allergy (R1) — must surface as pool-time
relaxation dialog, never an infeasible plan.

## Breakfast: enumerated variants (user labels)

Protein options: **2 eggs** (139 kcal / 13.1 P / 8.6 F) or **150 g unsweetened Greek yogurt**
(95 / 16.5 / 0). Staples iso-carb ≈ 40 g: oats P1 71 g · 馒头 85 g · quinoa ciabatta 1 个 (90 g) ·
sweet potato 1 个中 (160–200 g) · fresh corn ~1 根. Egg variants carry 200 ml Deya milk; yogurt
variants carry baseline nuts 1 把. Representative macros:

- 2 eggs + ciabatta + milk: 436 kcal / 27.8 P / 12.2 F
- yogurt + oats(P1) + 10 g walnut: 422 kcal / 28.0 P / 10.7 F

Egg-free feasibility: five yogurt variants exist at 26–28 g protein — the former egg-allergy
infeasibility was an artifact of the wrong seed yogurt value.

## Lunch & dinner: protein × method matrix, lean-tilted pool

Substitution axes: **换蛋白** (fixed method — protein ~invariant, moves fat ≤12 g; always safe for
the protein floor) and **换做法** (fixed protein — the fat/sodium axis; how the weekly budget
rebalances: "昨天红烧,今天清蒸").

**Default (lean) pool** — fat per main-slot, values at standard portions incl. rice where preset:
潮汕牛肉汤 ~7 · 紫菜豆腐汤 12.3 · 西兰花炒虾仁 15.3 · 家常豆腐西兰花 15.3 · 清蒸鲷鱼 16.7 ·
粉丝娃娃菜虾 17.5 · 黑椒鸡胸 18.2 · 香煎柠檬鲷鱼 19.1 · 胡萝卜炒鸡丁 21.
**Exception class (≤1×/week, budget-absorbed):** 红烧豆腐 18.9 · 红烧带鱼 22.8 · 葱爆牛肉 24.5 ·
洋葱炒牛肉 26.9 · 酱鸡腿 27.1 (thigh-with-skin: the fat is the cut, not the wok).
**Protein-rescue plates** (45–50 P, ~10 C): 黑椒鸡胸 · 蒜香鸡蛋盘 · 牛肉蛋盘 — preferred over
additive top-ups when a day runs protein-short and carbs have headroom.

### New dish spec: 潮汕牛肉汤 (chaoshan_beef_soup)

- Ingredients: beef_tenderloin **scalable 100–200 g** (半块–1块), clear broth (~20 kcal, est.
  600–700 mg Na — verify against actual preparation), scallion 10 g. Staple separate. No 沙茶.
- At 1 块 (200 g): ≈ 234 kcal / 45 P / ~3 F (excl. rice). Leanest main in the pool.
- Method: boiling → fills the empty beef × 汤 cell; red-meat floor carrier.

### Feasibility witness (fat)

Leanest realistic week: breakfasts avg ~12 F, 14 main-slots from the lean pool avg ~15 F/slot,
sides ~1 F/day → **≈ 43 g/day = 301 g/week = 88% of the 343 g budget** — headroom for one 红烧
exception (+~10 g) and nut top-ups. At the previous 42 g/day ceiling the same week ran 102% —
the 0.7 g/kg adjustment converts "knife-edge" to "comfortable with one treat."

## Worked example day (natural units, primary persona)

| Meal | Composition | kcal | P | F | C |
| --- | --- | --- | --- | --- | --- |
| Breakfast | 2 个鸡蛋 + 燕麦 60 g + Deya 奶 200 ml + 核桃 1 把 (15 g) | 552 | 30.7 | 24.5 | 48.8 |
| Lunch | 潮汕牛肉汤 (牛肉 1 块 200 g) + 糙米饭 1.5 碗 + 上海青 1 棵 | ~580 | 51.2 | ~5.4 | 74 |
| Dinner | 清蒸鲷鱼 (1 片 150 g, 香油 5 g) + 糙米饭 1.5 碗 + 菠菜汤 | ~534 | 35.4 | 11.5 | 74 |
| Snack | 无糖希腊酸奶 1 杯 (100 g) | 63 | 11.0 | 0 | 4.5 |
| **Day** | | **~1729** | **128.3** | **~42.4** | **~201** |

Verdict: kcal −2.4% (in band; weekly average corrects via 半碗 adjustments), protein 128 g
(floor 112 ✓; the 140 target is aspirational — reaching it exactly costs either a larger dinner
protein or a carb trade), fat 42.4 ≤ 49 ✓, every quantity on the unit lattice ✓.

## Scoring rubric (recalibrated)

### Tier 0 — hard gates (binary; any violation fails the plan)
- G1. No forbidden item anywhere (pork; per-persona allergens).
- G2. Every day within the ±12% energy band (1559–1983).
- G3. Every day ≥ 112 g protein floor, achieved via scaling/top-ups.
- G4. Rotation: no main two days running; each main ≤2×/week.
- G5. Structural completeness (B/L/D each day).
- G6. **All portions expressible on the natural-unit lattice** ("牛肉 163 g" fails even if macros
  are perfect).

### Tier 1 — weekly budgets (graded)
- B1. Fat ≤ 343 g/week (ceiling; ≤105% scores partial).
- B2. Sodium ≤ 16 100 mg/week.
- B3. Carbs 1348 g ± 15%.
- B4. Weekly avg kcal within ±3% of 1771 (rounding must cancel — persistent same-direction drift
  is a solver bug).
- B5. No per-day fat/sodium/carb advisories (v2 noise-deletion claim).
- B6. If a 红烧-class dish appears, the surrounding days compensate (running budget stays on
  track) — the "昨天红烧,今天清蒸" bias, observable in assignment.

### Tier 2 — portion & structure quality (graded)
- S1. Pool shape 3–4 / 5–7 / 3–4; red-meat quota via lean carrier when fat budget is tight.
- S2. Scaled amounts within per-dish culinary bounds (beef 100–200 g etc.); rounding directions
  follow the asymmetric policy.
- S3. Protein distributed sensibly across meals (no 250 g lunch / token dinner).
- S4. Every alternate spans a real axis (one 换蛋白 + one 换做法 where the matrix allows) and
  keeps the day valid after re-levering.
- S5. Grocery list ≡ pool ingredients.
- S6. **No unattributed fat**: daily fat traceable to explicit ingredients incl. cooking oil
  (blocked on the oil-grams data fix, below).
- S7. Variant/dish macros match current personal labels (label-drift check).

### Tier 3 — legibility (judged)
- L1. Every pool inclusion/exclusion and portion change explainable in one sentence
  ("蛋白差 12 g,牛肉从半块加到一块").
- L2. Budget status reported once weekly as % over/under.
- L3. Infeasibility surfaces at pool time with a relaxation dialog naming the fix
  ("要到 45 g/天脂肪,需再加两个清蒸/汆汤主菜"), never as a dead plan.

## Month-scale: scripted 4-week trajectory (unchanged in shape)

Events + expected property changes, not 30 authored days:
W1 baseline pass → W2 inject skips (a lean main ×2) + likes → W3 regenerate: skipped dish ≤1 slot,
liked dish ≥2×/week, tiers still pass → W4 swap request (must stay lever-valid) + one 红烧
exception day (weekly fat still ≤ ceiling; B6 observable).

## Known blockers / data fixes required before the harness is meaningful

1. **Seasoning grams** — cooking oil must become an explicit gram-bearing ingredient (5 g steps).
   At a 49 g ceiling, ~20 g/dish of invisible oil is ~40% of the daily budget unaccounted. Blocks
   S6 and honest 换做法 arithmetic.
2. **Nutrition recomputation from ingredients** — stored per-dish nutrition blocks are precomputed
   at default portions; template scaling requires catalog-based recompute (the staple lever and
   protein top-up already do this; dishes must follow).
3. **Personal-label ingestion** — yogurt/milk/oats/ciabatta label values enter as user foods and
   take precedence over seed representatives; 潮汕牛肉汤 broth sodium needs a real measurement.
4. **`chaoshan_beef_soup` preset** does not exist yet — spec above.

## Findings log

- F1. The staple lever is load-bearing daily (every composed day needs it) — check lever output,
  not just totals.
- F2. At the primary persona's 112 g floor, protein scaling/top-up fires **every day** (at the old
  100 g default it never fired — the mechanism is only tested by this persona).
- F3. Dish fat is method+oil, not protein choice: raw cuts are 0.9–5 g/100 g; 葱爆牛肉 carries
  ~23 g of wok fat on 1.35 g of beef fat. The fat lever is the matrix column, not the row.
- F4. Pool composition sets the feasible fat floor: ~51 g/day pre-discussion → ~35 g/day (leanest
  day) after adding 潮汕牛肉汤 + real-yogurt breakfasts. Infeasibility answers are pool answers.
- F5. Seed representative values can be materially wrong vs labels (yogurt protein 3.4×) —
  personal labels are authoritative; S7 guards the drift.
- F6. Sodium does not discriminate on the current pool (~67% of cap) — do not tune on it until
  saltier user dishes exist; broth sodium of the new soup is the one watch-item.
