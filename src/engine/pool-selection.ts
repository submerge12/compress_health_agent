import {
  hasRejectedIngredient,
  hasRejectedSeasoning,
  type RecipeDish,
  type RecipeNutrition,
  type RecipePreferences,
} from "./recipe-engine.js";
import { MAX_ENERGY_TOLERANCE_RATIO, PROTEIN_FLOOR_RATIO } from "./scoring-weights.js";
import {
  DEFAULT_STAPLE,
  dishNutrition,
  solveProteinTopUps,
  stapleNutrition,
  type Staple,
} from "./meal-composition.js";
import { sortMainsByProteinDesc } from "./meal-planner.js";
import type { MealCatalog } from "../tools/nutrition-estimate.js";

export interface WeeklyPoolMinimumCounts {
  breakfasts?: number;
  mains?: number;
  sides?: number;
}

export interface SelectWeeklyPoolRequest {
  candidates: readonly RecipeDish[];
  preferences?: RecipePreferences;
  minimumCounts?: WeeklyPoolMinimumCounts;
  weeklyFloors?: Readonly<Record<string, number>>;
  proteinFloor?: {
    dailyTargetGrams: number;
    /**
     * Lever credits for the feasibility screen. The pool check must not block
     * what day generation can actually achieve: the staple lever adds staple
     * protein and the protein top-up lever (meal-composition) adds add-ons.
     */
    catalog?: MealCatalog;
    stapleProteinHeadroomGrams?: number;
  };
  /**
   * Lean tilt: with a fat budget, floor carriers and fill slots prefer the
   * leanest dishes (preferences still rank first for fill). Fat budgets are
   * weekly REPORTING, never a hard gate (V2-P1), so an unreachable budget
   * yields a pool notice with the relaxation dialog instead of a block.
   * Fat is ingredient-computed when a catalog is given so explicit
   * cooking-oil grams — not stale stored blocks — drive the tilt.
   */
  fatBudget?: {
    dailyTargetGrams: number;
    catalog?: MealCatalog;
  };
  /**
   * Pool-time kcal viability: mains that cannot reach the hard energy band
   * even with the best pool partners and the staple lever are dropped (with a
   * notice) instead of poisoning rotation days.
   */
  kcalScreen?: {
    dailyKcalTarget: number;
    catalog?: MealCatalog;
    /** The staple generation will actually lever with; defaults to DEFAULT_STAPLE. */
    staple?: Staple;
  };
}

export interface WaivedWeeklyFloor {
  bucket: string;
  floor: number;
  reason: string;
}

export interface WeeklyPool {
  breakfasts: readonly RecipeDish[];
  mains: readonly RecipeDish[];
  sides: readonly RecipeDish[];
  all: readonly RecipeDish[];
  /** Floors skipped because their entire bucket is excluded by safety filters. */
  waivedFloors?: readonly WaivedWeeklyFloor[];
  /** Set when even the leanest week the pool allows exceeds the weekly fat budget. */
  fatBudgetNotice?: string;
  /** Non-blocking pool-quality notices: below-recommended size, kcal-screened drops. */
  poolNotices?: readonly string[];
}

export interface PoolCannotSatisfy {
  reason: string;
  suggestions: readonly string[];
}

export type SelectWeeklyPoolResult =
  | { ok: true; pool: WeeklyPool }
  | { ok: false; cannotSatisfy: PoolCannotSatisfy };

const RECOMMENDED_COUNTS = { breakfasts: 3, mains: 5, sides: 3 } as const;

export function selectWeeklyPool(request: SelectWeeklyPoolRequest): SelectWeeklyPoolResult {
  const safeCandidates = request.candidates.filter((dish) => isSafeDish(dish, request.preferences));
  const breakfastCandidates = safeCandidates.filter(matchesBreakfast);
  const mainCandidates = safeCandidates.filter(matchesMain);
  const sideCandidates = safeCandidates.filter(matchesSide);

  // Explicit minimumCounts are a caller contract and stay strict. The default
  // minimums are RECOMMENDATIONS: a small-but-workable library relaxes to
  // what exists (>=1 breakfast, >=1 main; sides optional) with a notice,
  // instead of refusing candidate sets the planner can serve.
  const strict = request.minimumCounts !== undefined;
  const minimums = request.minimumCounts ?? {};

  // kcal-viability first: minimums and floors must be computed over the
  // mains that generation can actually use, or screen drops would turn a
  // should-be-notice into a block with a fabricated reason.
  const poolNotices: string[] = [];
  const kcalScreenResult = kcalViabilityScreen(breakfastCandidates, mainCandidates, request.kcalScreen);
  if (kcalScreenResult.droppedSlugs.length > 0) {
    poolNotices.push(
      `Dropped ${kcalScreenResult.droppedSlugs.length} kcal-infeasible main(s) at pool time: ` +
      `${kcalScreenResult.droppedSlugs.join(", ")} (cannot reach the daily energy band with this pool).`,
    );
  }
  const viableMains = kcalScreenResult.viable;
  if (viableMains.length === 0) {
    return {
      ok: false,
      cannotSatisfy: {
        reason: "Cannot compose in-band days: every main candidate is kcal-infeasible for the daily target",
        suggestions: [
          "add mains sized for a full meal (not snacks or thin soups)",
          "adjust the daily kcal target",
        ],
      },
    };
  }

  // Adaptive mode counts what the fill can actually deliver: avoided
  // (skipped>=2) dishes contribute at most one last-resort slot.
  const avoidedSlugs = new Set((request.preferences?.avoidedDishSlugs ?? []).map(normalize));
  const preferredMainCount = viableMains.filter((dish) => !avoidedSlugs.has(normalize(dish.slug))).length;
  const achievableMains = preferredMainCount + Math.min(1, viableMains.length - preferredMainCount);
  const minimumCounts = strict
    ? {
      breakfasts: minimums.breakfasts ?? RECOMMENDED_COUNTS.breakfasts,
      mains: minimums.mains ?? RECOMMENDED_COUNTS.mains,
      sides: minimums.sides ?? RECOMMENDED_COUNTS.sides,
    }
    : {
      breakfasts: Math.max(1, Math.min(RECOMMENDED_COUNTS.breakfasts, breakfastCandidates.length)),
      mains: Math.max(1, Math.min(RECOMMENDED_COUNTS.mains, achievableMains)),
      sides: Math.min(RECOMMENDED_COUNTS.sides, sideCandidates.length),
    };
  const minimumFailure = minimumCountFailure(
    breakfastCandidates,
    viableMains,
    sideCandidates,
    minimumCounts,
  );
  if (minimumFailure !== undefined) {
    return { ok: false, cannotSatisfy: minimumFailure };
  }

  const allMainCandidates = request.candidates.filter(matchesMain);
  const floorCheck = weeklyFloorCheck(viableMains, allMainCandidates, request.weeklyFloors ?? {}, strict);
  if (floorCheck.failure !== undefined) {
    return { ok: false, cannotSatisfy: floorCheck.failure };
  }

  const fatOf = request.fatBudget === undefined ? undefined : makeFatLookup(request.fatBudget);
  const mains = selectMainPool(
    viableMains,
    minimumCounts.mains,
    request.weeklyFloors ?? {},
    request.preferences,
    fatOf,
  );
  if (mains.length < minimumCounts.mains) {
    // Only reachable for strict callers: the adaptive minimum is derived from
    // the achievable fill, while an explicit minimum can exceed what the
    // avoided-dish (skipped>=2) cap lets the fill deliver.
    return {
      ok: false,
      cannotSatisfy: {
        reason: `Cannot fill the weekly main pool: ${mains.length}/${minimumCounts.mains} usable mains` +
          (avoidedSlugs.size > 0 ? " after limiting dishes skipped twice or more to one slot" : ""),
        suggestions: [
          "re-enable one of the recently skipped dishes for this week",
          "add new main dishes to the library",
        ],
      },
    };
  }

  // A dish already selected as a main must not also rotate as a breakfast
  // (mealTypes-undefined dishes match both role filters).
  const mainSlugs = new Set(mains.map((dish) => dish.slug));
  const availableBreakfasts = breakfastCandidates.filter((dish) => !mainSlugs.has(dish.slug));
  const breakfasts = (fatOf === undefined
    ? availableBreakfasts
    : [...availableBreakfasts].sort((left, right) => fatOf(left) - fatOf(right))
  ).slice(0, Math.max(minimumCounts.breakfasts, Math.min(RECOMMENDED_COUNTS.breakfasts, availableBreakfasts.length)));
  if (breakfasts.length === 0) {
    return {
      ok: false,
      cannotSatisfy: {
        reason: "Cannot satisfy pool minimum counts after safety filters: breakfast 0/1",
        suggestions: ["add a safe breakfast candidate"],
      },
    };
  }
  const sides = sideCandidates.slice(0, Math.max(minimumCounts.sides, Math.min(RECOMMENDED_COUNTS.sides, sideCandidates.length)));

  if (!strict && (
    breakfasts.length < RECOMMENDED_COUNTS.breakfasts ||
    mains.length < RECOMMENDED_COUNTS.mains ||
    sides.length < RECOMMENDED_COUNTS.sides
  )) {
    poolNotices.push(
      `Pool below recommended size (breakfasts ${breakfasts.length}/${RECOMMENDED_COUNTS.breakfasts}, ` +
      `mains ${mains.length}/${RECOMMENDED_COUNTS.mains}, sides ${sides.length}/${RECOMMENDED_COUNTS.sides}): ` +
      `variety and rotation will be limited; add more dishes to improve the week.`,
    );
  }

  const proteinCannotSatisfy = proteinFeasibilityFailure(
    breakfasts,
    mains,
    request.proteinFloor,
    request.preferences,
  );
  if (proteinCannotSatisfy !== undefined) {
    return { ok: false, cannotSatisfy: proteinCannotSatisfy };
  }
  const fatNotice = fatBudgetNotice(breakfasts, mains, sides, request.fatBudget);

  return {
    ok: true,
    pool: {
      breakfasts,
      mains,
      sides,
      all: uniqueDishes([...breakfasts, ...mains, ...sides]),
      ...(floorCheck.waived.length > 0 ? { waivedFloors: floorCheck.waived } : {}),
      ...(fatNotice === undefined ? {} : { fatBudgetNotice: fatNotice }),
      ...(poolNotices.length > 0 ? { poolNotices } : {}),
    },
  };
}

/**
 * A main is kcal-viable when at least one (breakfast, partner-main) pairing
 * plus the staple lever's range can land the day inside the hard energy band.
 * Non-viable mains (a 200-kcal thin soup in a no-catalog setup, an enormous
 * feast dish) are dropped rather than rotated into guaranteed-failing days.
 */
function kcalViabilityScreen(
  breakfasts: readonly RecipeDish[],
  mains: readonly RecipeDish[],
  screen: SelectWeeklyPoolRequest["kcalScreen"],
): { viable: readonly RecipeDish[]; droppedSlugs: readonly string[] } {
  if (screen === undefined || screen.dailyKcalTarget <= 0 || breakfasts.length === 0 || mains.length === 0) {
    return { viable: mains, droppedSlugs: [] };
  }
  const kcalOf = (dish: RecipeDish): number => {
    if (screen.catalog !== undefined) {
      try {
        return dishNutrition(dish, screen.catalog).kcal;
      } catch {
        // uncataloged ingredients fall back to the stored block
      }
    }
    return dish.nutrition.kcal;
  };
  let stapleDayMinKcal = 0;
  let stapleDayMaxKcal = 0;
  if (screen.catalog !== undefined) {
    // Screen with the staple generation will actually lever with, or the
    // bounds certify pools the real lever cannot serve.
    const staple = screen.staple ?? DEFAULT_STAPLE;
    try {
      stapleDayMinKcal = stapleNutrition(
        { slug: staple.slug, grams: staple.minGrams * 2 }, screen.catalog).kcal;
      stapleDayMaxKcal = stapleNutrition(
        { slug: staple.slug, grams: staple.maxGrams * 2 }, screen.catalog).kcal;
    } catch {
      // no staple in the catalog: screen without the lever
    }
  }
  const lowBand = screen.dailyKcalTarget * (1 - MAX_ENERGY_TOLERANCE_RATIO);
  const highBand = screen.dailyKcalTarget * (1 + MAX_ENERGY_TOLERANCE_RATIO);
  const breakfastKcals = breakfasts.map(kcalOf);
  const bMin = Math.min(...breakfastKcals);
  const bMax = Math.max(...breakfastKcals);
  const mainKcals = mains.map(kcalOf);

  const viable: RecipeDish[] = [];
  const droppedSlugs: string[] = [];
  mains.forEach((main, index) => {
    const partners = mainKcals.filter((_, partnerIndex) => partnerIndex !== index);
    const partnerMin = partners.length === 0 ? mainKcals[index] ?? 0 : Math.min(...partners);
    const partnerMax = partners.length === 0 ? mainKcals[index] ?? 0 : Math.max(...partners);
    const bestCaseDay = bMax + (mainKcals[index] ?? 0) + partnerMax + stapleDayMaxKcal;
    const leanestDay = bMin + (mainKcals[index] ?? 0) + partnerMin + stapleDayMinKcal;
    if (bestCaseDay >= lowBand && leanestDay <= highBand) {
      viable.push(main);
    } else {
      droppedSlugs.push(main.slug);
    }
  });

  // Per-main viability uses best-case partners; the fill pairs mains by a
  // FIXED rotation. Simulate that exact rotation and drop the main most
  // responsible for any day no lever setting can bring into band.
  let rotationPool = viable;
  for (let attempt = 0; attempt < 3 && rotationPool.length > 1; attempt += 1) {
    const offender = rotationOffender(rotationPool, screen, kcalOf, bMin, bMax, stapleDayMinKcal, stapleDayMaxKcal, lowBand, highBand);
    if (offender === undefined) break;
    rotationPool = rotationPool.filter((dish) => dish.slug !== offender);
    droppedSlugs.push(offender);
  }
  return { viable: rotationPool, droppedSlugs };
}

/**
 * Replays the planner's deterministic rotation (protein-sorted pool, dinner
 * half a cycle ahead) and returns the slug of the main whose kcal sits
 * farthest from the pool mean within the first infeasible day, or undefined
 * when every rotation day can reach the band.
 */
function rotationOffender(
  pool: readonly RecipeDish[],
  screen: NonNullable<SelectWeeklyPoolRequest["kcalScreen"]>,
  kcalOf: (dish: RecipeDish) => number,
  bMin: number,
  bMax: number,
  stapleDayMinKcal: number,
  stapleDayMaxKcal: number,
  lowBand: number,
  highBand: number,
): string | undefined {
  const sorted = sortMainsByProteinDesc(pool, screen.catalog);
  const offset = Math.max(1, Math.ceil(sorted.length / 2));
  const meanKcal = sorted.reduce((sum, dish) => sum + kcalOf(dish), 0) / sorted.length;
  for (let day = 0; day < 7; day += 1) {
    const lunch = sorted[day % sorted.length] as RecipeDish;
    const dinner = sorted[(day + offset) % sorted.length] as RecipeDish;
    const pairKcal = kcalOf(lunch) + kcalOf(dinner);
    const dayMax = bMax + pairKcal + stapleDayMaxKcal;
    const dayMin = bMin + pairKcal + stapleDayMinKcal;
    if (dayMax >= lowBand && dayMin <= highBand) continue;
    return Math.abs(kcalOf(lunch) - meanKcal) >= Math.abs(kcalOf(dinner) - meanKcal)
      ? lunch.slug
      : dinner.slug;
  }
  return undefined;
}

function minimumCountFailure(
  breakfasts: readonly RecipeDish[],
  mains: readonly RecipeDish[],
  sides: readonly RecipeDish[],
  minimums: Required<WeeklyPoolMinimumCounts>,
): PoolCannotSatisfy | undefined {
  const deficits = [
    roleDeficit("breakfast", breakfasts.length, minimums.breakfasts),
    roleDeficit("main", mains.length, minimums.mains),
    roleDeficit("side", sides.length, minimums.sides),
  ].filter((item): item is string => item !== undefined);

  if (deficits.length === 0) return undefined;
  return {
    reason: `Cannot satisfy pool minimum counts after safety filters: ${deficits.join(", ")}`,
    suggestions: [
      "add more safe candidates for the missing meal roles",
      "lower the weekly pool minimum counts",
      "keep allergy filters strict; do not relax allergies without medical guidance",
    ],
  };
}

function roleDeficit(role: string, actual: number, target: number): string | undefined {
  return actual >= target ? undefined : `${role} ${actual}/${target}`;
}

interface WeeklyFloorCheckResult {
  failure?: PoolCannotSatisfy;
  waived: readonly WaivedWeeklyFloor[];
}

function weeklyFloorCheck(
  safeMains: readonly RecipeDish[],
  allMains: readonly RecipeDish[],
  weeklyFloors: Readonly<Record<string, number>>,
  strict: boolean,
): WeeklyFloorCheckResult {
  const deficits: { bucket: string; floor: number; actual: number }[] = [];
  const waived: WaivedWeeklyFloor[] = [];

  for (const [bucket, floor] of Object.entries(weeklyFloors)) {
    if (floor <= 0) continue;
    const safeCount = countBucket(safeMains, bucket);
    if (safeCount >= floor) continue;
    const preSafetyCount = countBucket(allMains, bucket);
    if (preSafetyCount === 0 && !strict) {
      // Adaptive flow: the library simply has no carrier for this bucket
      // (e.g. a vegetarian dish set and a red-meat floor). That is a notice
      // conversation, not a refusal. Strict callers keep the hard block.
      waived.push({
        bucket,
        floor,
        reason: `no candidates carry ${bucket}`,
      });
      continue;
    }
    if (safeCount === 0 && preSafetyCount > 0) {
      // The bucket exists in the candidate set but every carrier was removed
      // by safety filters (allergens / strict exclusions). A safety-excluded
      // floor must never block the user; waive it and note the waiver.
      waived.push({
        bucket,
        floor,
        reason: `all ${preSafetyCount} candidates carrying ${bucket} were excluded by safety filters`,
      });
      continue;
    }
    deficits.push({ bucket, floor, actual: safeCount });
  }

  if (deficits.length === 0) return { waived };
  return {
    waived,
    failure: {
      reason: `Cannot satisfy weekly floor quotas after safety filters: ${
        deficits.map((item) => `${item.bucket} ${item.actual}/${item.floor}`).join(", ")
      }`,
      suggestions: [
        "add safe candidates for the missing weekly-floor buckets",
        "lower the requested weekly-floor quotas",
        "keep allergy filters strict; do not relax allergies without medical guidance",
      ],
    },
  };
}

function proteinFeasibilityFailure(
  breakfasts: readonly RecipeDish[],
  mains: readonly RecipeDish[],
  proteinFloor: SelectWeeklyPoolRequest["proteinFloor"],
  preferences: RecipePreferences | undefined,
): PoolCannotSatisfy | undefined {
  const dailyProteinTarget = proteinFloor?.dailyTargetGrams;
  if (proteinFloor === undefined || dailyProteinTarget === undefined || dailyProteinTarget <= 0) {
    return undefined;
  }
  const requiredFloor = Math.round(dailyProteinTarget * PROTEIN_FLOOR_RATIO);
  const strongestBreakfast = maxProtein(breakfasts);
  const strongestMains = [...mains]
    .sort((left, right) => right.nutrition.proteinGrams - left.nutrition.proteinGrams)
    .slice(0, 2);
  const strongestDayDishes = [
    ...(strongestBreakfast === undefined ? [] : [strongestBreakfast]),
    ...strongestMains,
  ];
  const strongestDayProtein = strongestDayDishes.reduce(
    (sum, dish) => sum + dish.nutrition.proteinGrams,
    0,
  );

  // Lever credits: the feasibility screen must not block what generation can
  // achieve. Credit the staple lever's protein headroom, then the protein
  // top-up menu (menu-bounded; kcal is not the limiting factor at screen time
  // because generation can trade staple grams down to fund add-ons).
  const stapleCredit = Math.max(0, proteinFloor.stapleProteinHeadroomGrams ?? 0);
  if (strongestDayProtein + stapleCredit >= requiredFloor) return undefined;

  if (proteinFloor.catalog !== undefined && strongestDayDishes.length > 0) {
    const topUp = solveProteinTopUps({
      proteinFloorGrams: requiredFloor - stapleCredit,
      fixedNutrition: sumNutrition(strongestDayDishes),
      remainingKcalBudget: Number.POSITIVE_INFINITY,
      catalog: proteinFloor.catalog,
      ...(preferences === undefined ? {} : { preferences }),
    });
    if (topUp.meetsProteinFloor) return undefined;
  }

  return {
    reason:
      `Cannot satisfy protein floor at pool time: strongest safe day is ${round1(strongestDayProtein)}g ` +
      `vs ${requiredFloor}g floor (after staple and top-up lever credits)`,
    suggestions: [
      "add a lean protein dish to the candidate pool",
      "allow a protein top-up such as egg, tofu, soy milk, or chicken breast",
      "lower the daily protein target",
    ],
  };
}

function sumNutrition(dishes: readonly RecipeDish[]): RecipeNutrition {
  return dishes.reduce(
    (total, dish) => ({
      kcal: total.kcal + dish.nutrition.kcal,
      proteinGrams: total.proteinGrams + dish.nutrition.proteinGrams,
      carbsGrams: total.carbsGrams + dish.nutrition.carbsGrams,
      fatGrams: total.fatGrams + dish.nutrition.fatGrams,
      sodiumMg: total.sodiumMg + dish.nutrition.sodiumMg,
    }),
    { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, sodiumMg: 0 },
  );
}

function maxProtein(dishes: readonly RecipeDish[]): RecipeDish | undefined {
  return dishes.reduce<RecipeDish | undefined>(
    (best, dish) =>
      best === undefined || dish.nutrition.proteinGrams > best.nutrition.proteinGrams ? dish : best,
    undefined,
  );
}

/**
 * Rotation needs 7 mains: 14 lunch/dinner slots at <=2 uses per main. The
 * pool fills toward this target when candidates allow; `minimumCount` alone
 * decides blocking.
 */
const MAIN_ROTATION_TARGET = 7;

function selectMainPool(
  candidates: readonly RecipeDish[],
  minimumCount: number,
  weeklyFloors: Readonly<Record<string, number>>,
  preferences: RecipePreferences | undefined,
  fatOf: FatLookup | undefined,
): readonly RecipeDish[] {
  const fillTarget = Math.max(minimumCount, MAIN_ROTATION_TARGET);
  const selected: RecipeDish[] = [];
  // W2 preference frequency: skipped->=2 dishes (avoidedDishSlugs) get 0-1
  // slots — excluded from normal fill, usable only as a last resort to reach
  // the pool minimum. Weekly floors override the soft signal: when a floor's
  // only carriers are avoided dishes, the floor still gets its carrier
  // (explicit quotas outrank a soft skip signal).
  const avoided = new Set((preferences?.avoidedDishSlugs ?? []).map(normalize));
  const isAvoided = (dish: RecipeDish): boolean => avoided.has(normalize(dish.slug));
  const preferred = candidates.filter((dish) => !isAvoided(dish));
  const byFat = (dishes: readonly RecipeDish[]): readonly RecipeDish[] => fatOf === undefined
    ? dishes
    : [...dishes].sort((left, right) => fatOf(left) - fatOf(right));
  const floorCandidates = [
    ...byFat(preferred),
    ...byFat(candidates.filter(isAvoided)),
  ];
  for (const [bucket, floor] of Object.entries(weeklyFloors)) {
    if (floor <= 0) continue;
    for (const candidate of floorCandidates.filter((dish) => hasBucket(dish, bucket))) {
      if (countBucket(selected, bucket) >= floor) break;
      addUnique(selected, candidate);
    }
  }

  for (const candidate of rankByPreferences(preferred, preferences, fatOf)) {
    if (selected.length >= fillTarget) break;
    addUnique(selected, candidate);
  }

  if (selected.length < minimumCount) {
    for (const candidate of rankByPreferences(candidates.filter(isAvoided), preferences, fatOf)) {
      if (selected.length >= minimumCount) break;
      addUnique(selected, candidate);
      break; // at most one avoided dish re-enters
    }
  }

  return selected;
}

function rankByPreferences(
  candidates: readonly RecipeDish[],
  preferences: RecipePreferences | undefined,
  fatOf?: FatLookup,
): readonly RecipeDish[] {
  return [...candidates].sort((left, right) =>
    preferenceScore(right, preferences) - preferenceScore(left, preferences) ||
    (fatOf === undefined ? 0 : fatOf(left) - fatOf(right))
  );
}

type FatLookup = (dish: RecipeDish) => number;

function makeFatLookup(fatBudget: NonNullable<SelectWeeklyPoolRequest["fatBudget"]>): FatLookup {
  const catalog = fatBudget.catalog;
  return (dish) => {
    if (catalog !== undefined) {
      try {
        return dishNutrition(dish, catalog).fatGrams;
      } catch {
        // dishes with uncataloged ingredients fall back to the stored block
      }
    }
    return dish.nutrition.fatGrams;
  };
}

function fatBudgetNotice(
  breakfasts: readonly RecipeDish[],
  mains: readonly RecipeDish[],
  sides: readonly RecipeDish[],
  fatBudget: SelectWeeklyPoolRequest["fatBudget"],
): string | undefined {
  if (fatBudget === undefined || fatBudget.dailyTargetGrams <= 0 || breakfasts.length === 0 || mains.length === 0) {
    return undefined;
  }
  const fatOf = makeFatLookup(fatBudget);
  const weeklyBudgetGrams = fatBudget.dailyTargetGrams * 7;

  // Leanest week the pool allows: leanest breakfast daily, 14 main slots
  // filled leanest-first at <=2 uses each (overflow repeats the leanest, as
  // the fill does with a small pool), leanest side with lunch and dinner.
  const mainFats = mains.map(fatOf).sort((left, right) => left - right);
  let openSlots = 14;
  let mainsFatGrams = 0;
  for (const fat of mainFats) {
    const uses = Math.min(2, openSlots);
    mainsFatGrams += fat * uses;
    openSlots -= uses;
  }
  mainsFatGrams += (mainFats[0] ?? 0) * openSlots;
  const leanestWeekFatGrams =
    Math.min(...breakfasts.map(fatOf)) * 7 +
    mainsFatGrams +
    (sides.length === 0 ? 0 : Math.min(...sides.map(fatOf)) * 14);

  if (leanestWeekFatGrams <= weeklyBudgetGrams) return undefined;
  return (
    `Weekly fat budget notice: even the leanest week this pool allows is ~${round1(leanestWeekFatGrams)}g ` +
    `vs the ${weeklyBudgetGrams}g budget. To close the gap: add lean steamed or boiled mains (清蒸/汆汤), ` +
    `reduce cooking-oil grams on stir-fried and braised dishes, or raise the daily fat target.`
  );
}

function preferenceScore(dish: RecipeDish, preferences: RecipePreferences | undefined): number {
  const preferredIngredients = new Set((preferences?.preferredIngredients ?? []).map(normalize));
  const preferredSeasonings = new Set((preferences?.preferredSeasonings ?? []).map(normalize));
  const preferredMethods = new Set((preferences?.preferredMethods ?? []).map(normalize));
  const ingredientScore =
    dish.ingredients.filter((ingredient) => preferredIngredients.has(normalize(ingredient.slug))).length * 2;
  const seasoningScore =
    dish.seasonings.filter((seasoning) => preferredSeasonings.has(normalize(seasoning))).length * 2;
  const methodScore = dish.method !== undefined && preferredMethods.has(normalize(dish.method)) ? 2 : 0;
  return ingredientScore + seasoningScore + methodScore;
}

function addUnique(selected: RecipeDish[], candidate: RecipeDish): void {
  if (selected.some((dish) => dish.slug === candidate.slug)) return;
  selected.push(candidate);
}

function countBucket(dishes: readonly RecipeDish[], bucket: string): number {
  return dishes.filter((dish) => hasBucket(dish, bucket)).length;
}

function hasBucket(dish: RecipeDish, bucket: string): boolean {
  return (dish.buckets ?? []).some((candidate) => normalize(candidate) === normalize(bucket));
}

function isSafeDish(dish: RecipeDish, preferences: RecipePreferences | undefined): boolean {
  if (hasRejectedSeasoning(dish, preferences?.rejectedSeasonings ?? [])) return false;
  return !hasRejectedIngredient(dish, preferences?.rejectedIngredients ?? [], preferences?.allergens ?? []);
}

function matchesBreakfast(dish: RecipeDish): boolean {
  return dish.role !== "side" && (dish.mealTypes === undefined || dish.mealTypes.includes("breakfast"));
}

function matchesMain(dish: RecipeDish): boolean {
  return dish.role !== "side" &&
    (dish.mealTypes === undefined || dish.mealTypes.includes("lunch") || dish.mealTypes.includes("dinner"));
}

function matchesSide(dish: RecipeDish): boolean {
  return dish.role === "side" &&
    (dish.mealTypes === undefined || dish.mealTypes.includes("lunch") || dish.mealTypes.includes("dinner"));
}

function uniqueDishes(dishes: readonly RecipeDish[]): readonly RecipeDish[] {
  const seen = new Set<string>();
  return dishes.filter((dish) => {
    if (seen.has(dish.slug)) return false;
    seen.add(dish.slug);
    return true;
  });
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
