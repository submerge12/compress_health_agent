import type {
  ActivityLevel,
  BmrProfile,
  CaloriePlan,
  CalorieProfile,
  CalorieStatus,
  Goal,
  GoalFamily,
  MacroRanges,
  MacroStatuses,
  MacroStatus,
  MacroTargets,
} from "./types.js";

const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.10,
  lightly_active: 1.20,
  moderately_active: 1.35,
  strength_training: 1.50,
};

const EXERCISER_LEVELS: ReadonlySet<ActivityLevel> = new Set(["moderately_active", "strength_training"]);

const GOAL_CALORIE_FACTOR: Record<Goal, number> = {
  improve_health: 1.00,
  body_recomp: 0.90,
  fat_loss_slow: 0.90,
  fat_loss_moderate: 0.85,
  fat_loss_fast: 0.80,
  muscle_gain_slow: 1.10,
  muscle_gain_moderate: 1.15,
  muscle_gain_fast: 1.20,
};

type ProteinBand = [lower: number, target: number, upper: number];

const PROTEIN_BANDS: Record<string, ProteinBand> = {
  "improve_health:false": [0.8, 1.2, 1.5],
  "improve_health:true": [1.2, 1.6, 1.9],
  "muscle_gain:false": [1.4, 2.0, 2.3],
  "muscle_gain:true": [1.4, 2.0, 2.3],
  "body_recomp:false": [1.2, 1.8, 2.1],
  "body_recomp:true": [1.6, 2.2, 2.5],
  "fat_loss:false": [1.4, 2.0, 2.4],
  "fat_loss:true": [1.8, 2.4, 2.8],
};

const CARB_BANDS: Record<Goal, [min: number, max: number]> = {
  improve_health: [3.0, 5.0],
  body_recomp: [2.5, 3.5],
  fat_loss_slow: [2.5, 3.5],
  fat_loss_moderate: [2.0, 3.0],
  fat_loss_fast: [1.5, 2.5],
  muscle_gain_slow: [4.0, 6.0],
  muscle_gain_moderate: [4.5, 6.5],
  muscle_gain_fast: [5.0, 7.0],
};

const FEMALE_CARB_FLOOR_G = 120.0;
const PROTEIN_EXCESSIVE_MARGIN_PER_KG = 0.2;

export function goalFamily(goal: Goal): GoalFamily {
  if (goal.startsWith("fat_loss")) return "fat_loss";
  if (goal.startsWith("muscle_gain")) return "muscle_gain";
  return goal as GoalFamily;
}

export function getActivityMultiplier(activityLevel: ActivityLevel): number {
  const multiplier = ACTIVITY_MULTIPLIERS[activityLevel];
  if (multiplier === undefined) {
    throw new RangeError(`Unknown activity level: ${String(activityLevel)}`);
  }
  return multiplier;
}

export function isExerciser(activityLevel: ActivityLevel): boolean {
  return EXERCISER_LEVELS.has(activityLevel);
}

// Step 1: BMR (Mifflin-St Jeor)
export function calculateBmr(profile: BmrProfile): number {
  validateBmrProfile(profile);
  const sexOffset = profile.sex === "male" ? 5 : -161;
  return 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * profile.ageYears + sexOffset;
}

export function calculateTdee(bmr: number, activityLevel: ActivityLevel): number {
  assertPositiveFinite(bmr, "bmr");
  return bmr * getActivityMultiplier(activityLevel);
}

// Step 2: Calorie target with bounds
function calorieBounds(goal: Goal, tdee: number, bmr: number): [lower: number | null, upper: number | null] {
  switch (goal) {
    case "improve_health": return [null, null];
    case "body_recomp": return [bmr + 100, tdee - 300];
    case "fat_loss_slow": return [bmr + 100, null];
    case "fat_loss_moderate": return [bmr + 100, tdee - 500];
    case "fat_loss_fast": return [bmr + 100, tdee - 700];
    case "muscle_gain_slow": return [tdee + 200, tdee + 300];
    case "muscle_gain_moderate": return [tdee + 300, tdee + 500];
    case "muscle_gain_fast": return [tdee + 400, tdee + 700];
  }
}

export function calculateCalorieTarget(goal: Goal, tdee: number, bmr: number): { target: number; status: CalorieStatus } {
  const raw = tdee * GOAL_CALORIE_FACTOR[goal];
  const [lower, upper] = calorieBounds(goal, tdee, bmr);

  if (lower !== null && upper !== null && lower > upper) {
    return { target: lower, status: "lower_overrides_upper" };
  }

  let target = raw;
  if (upper !== null) target = Math.min(target, upper);
  if (lower !== null) target = Math.max(target, lower);

  if (lower !== null && target === lower && raw < lower) {
    return { target, status: "lower_bound_applied" };
  }
  if (upper !== null && target === upper && raw > upper) {
    return { target, status: "upper_bound_applied" };
  }
  return { target, status: "on_target" };
}

// Step 3: Protein band lookup
export function proteinBand(goal: Goal, exerciser: boolean): ProteinBand {
  const family = goalFamily(goal);
  const key = `${family}:${exerciser}`;
  const band = PROTEIN_BANDS[key];
  if (band === undefined) {
    throw new RangeError(`Unknown protein band for ${key}`);
  }
  return band;
}

function proteinAgeAdj(age: number): number {
  if (age >= 50) return 0.2;
  if (age >= 35) return 0.1;
  return 0.0;
}

// Steps 3-8: Full macro distribution
export function calculateMacros(
  calories: number,
  weightKg: number,
  sex: "male" | "female",
  age: number,
  goal: Goal,
  exerciser: boolean,
): { macros: MacroTargets; ranges: MacroRanges; statuses: MacroStatuses } {
  if (calories <= 0 || weightKg <= 0) {
    return emptyMacroResult(calories);
  }

  // Step 3 — protein
  const [lowerP, targetP, upperP] = proteinBand(goal, exerciser);
  const targetPerKg = Math.max(lowerP, Math.min(upperP, targetP + proteinAgeAdj(age)));
  let proteinG = weightKg * targetPerKg;
  const proteinLowerG = weightKg * lowerP;
  const proteinUpperG = weightKg * upperP;

  // Step 4 — fat
  const fatMinG = (sex === "male" ? 0.6 : 0.8) * weightKg;
  let fatG = Math.max(fatMinG, (calories * 0.20) / 9);
  const fatSoftMaxG = (calories * 0.40) / 9;

  // Step 5 — initial carbs (remainder)
  let carbsG = Math.max(0.0, (calories - proteinG * 4 - fatG * 9) / 4);

  // Step 6 — carb range
  const [carbsMinPerKg, carbsMaxPerKg] = CARB_BANDS[goal];
  let carbsMinG = carbsMinPerKg * weightKg;
  const carbsMaxG = carbsMaxPerKg * weightKg;
  if (sex === "female") {
    carbsMinG = Math.max(carbsMinG, FEMALE_CARB_FLOOR_G);
  }

  // Step 7 — backtrack
  let carbBelowUnavoidable = false;
  if (carbsG > carbsMaxG) {
    const excessKcal = (carbsG - carbsMaxG) * 4;
    carbsG = carbsMaxG;
    fatG += excessKcal / 9;
  } else if (carbsG < carbsMinG) {
    let gapKcal = (carbsMinG - carbsG) * 4;

    const fatReducible = Math.max(0.0, (fatG - fatMinG) * 9);
    const takeFat = Math.min(gapKcal, fatReducible);
    fatG -= takeFat / 9;
    carbsG += takeFat / 4;
    gapKcal -= takeFat;

    if (gapKcal > 0) {
      const protReducible = Math.max(0.0, (proteinG - proteinLowerG) * 4);
      const takeProt = Math.min(gapKcal, protReducible);
      proteinG -= takeProt / 4;
      carbsG += takeProt / 4;
      gapKcal -= takeProt;
    }

    if (gapKcal > 0) {
      carbBelowUnavoidable = true;
    }
  }

  // Step 8 — status labels
  const proteinStatus = classifyProteinPerKg(proteinG / weightKg, lowerP, upperP);
  const fatStatus = classifyFat(fatG, fatMinG, fatSoftMaxG);
  const carbStatus = classifyCarb(carbsG, carbsMinG, carbsMaxG, carbBelowUnavoidable);

  return {
    macros: {
      proteinGrams: roundTo(proteinG, 1),
      carbsGrams: roundTo(carbsG, 1),
      fatGrams: roundTo(fatG, 1),
    },
    ranges: {
      proteinBand: [lowerP, targetP, upperP],
      proteinRangeGrams: [roundTo(proteinLowerG, 1), roundTo(proteinUpperG, 1)],
      carbsRangeGrams: [roundTo(carbsMinG, 1), roundTo(carbsMaxG, 1)],
      fatMinGrams: roundTo(fatMinG, 1),
      fatSoftMaxGrams: roundTo(fatSoftMaxG, 1),
    },
    statuses: {
      protein: proteinStatus,
      fat: fatStatus,
      carbs: carbStatus,
    },
  };
}

// Step 9: Full daily plan assembly
export function calculateCaloriePlan(profile: CalorieProfile): CaloriePlan {
  const bmr = calculateBmr(profile);
  const tdee = calculateTdee(bmr, profile.activityLevel);
  const { target, status } = calculateCalorieTarget(profile.goal, tdee, bmr);
  const exerciser = isExerciser(profile.activityLevel);
  const { macros, ranges, statuses } = calculateMacros(
    target, profile.weightKg, profile.sex, profile.ageYears, profile.goal, exerciser,
  );

  const warnings: string[] = [];
  if (status === "lower_bound_applied") {
    warnings.push("Calorie target was raised to the safety lower bound.");
  }
  if (status === "lower_overrides_upper") {
    warnings.push("Calorie lower bound exceeds the goal cap — consider switching to body_recomp or fat_loss_slow, or raising activity level.");
  }
  if (statuses.carbs === "below_range_unavoidable") {
    warnings.push("Minimum carbohydrate cannot be met under the current calorie target.");
  }

  return {
    bmrKcal: Math.round(bmr),
    tdeeKcal: Math.round(tdee),
    targetKcal: Math.round(target),
    calorieStatus: status,
    isExerciser: exerciser,
    macros,
    ranges,
    statuses,
    warnings,
  };
}

export function classifyProtein(
  proteinG: number, weightKg: number, goal: Goal, exerciser: boolean,
): MacroStatus {
  if (weightKg <= 0) return "appropriate";
  const perKg = proteinG / weightKg;
  const [lower, , upper] = proteinBand(goal, exerciser);
  return classifyProteinPerKg(perKg, lower, upper);
}

function classifyProteinPerKg(perKg: number, lower: number, upper: number): MacroStatus {
  if (perKg < lower) return "insufficient";
  if (perKg <= upper) return "appropriate";
  if (perKg <= upper + PROTEIN_EXCESSIVE_MARGIN_PER_KG) return "slightly_high";
  return "excessive";
}

function classifyFat(fatG: number, fatMinG: number, fatSoftMaxG: number): MacroStatus {
  if (fatG < fatMinG) return "below_min";
  if (fatG > fatSoftMaxG) return "high";
  return "appropriate";
}

function classifyCarb(carbsG: number, carbMinG: number, carbMaxG: number, unavoidable: boolean): MacroStatus {
  if (carbsG < carbMinG) return unavoidable ? "below_range_unavoidable" : "below_range";
  if (carbsG > carbMaxG) return "above_range";
  return "appropriate";
}

function emptyMacroResult(calories: number): {
  macros: MacroTargets;
  ranges: MacroRanges;
  statuses: MacroStatuses;
} {
  return {
    macros: { proteinGrams: 0, carbsGrams: 0, fatGrams: 0 },
    ranges: {
      proteinBand: [0, 0, 0],
      proteinRangeGrams: [0, 0],
      carbsRangeGrams: [0, 0],
      fatMinGrams: 0,
      fatSoftMaxGrams: 0,
    },
    statuses: {
      protein: "insufficient",
      fat: "below_min",
      carbs: "below_range",
    },
  };
}

function validateBmrProfile(profile: BmrProfile): void {
  if (profile.sex !== "male" && profile.sex !== "female") {
    throw new RangeError(`Unknown sex: ${String(profile.sex)}`);
  }
  assertPositiveFinite(profile.ageYears, "ageYears");
  assertPositiveFinite(profile.heightCm, "heightCm");
  assertPositiveFinite(profile.weightKg, "weightKg");
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
