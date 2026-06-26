export interface DailyThresholdTarget {
  kcal: number;
  proteinGrams: number;
}

export interface DailyThresholdActual {
  kcal: number;
  proteinGrams: number;
  sodiumMg?: number;
}

export function dailyThresholdWarnings(
  eaten: DailyThresholdActual,
  target: DailyThresholdTarget,
): string[] {
  const warnings: string[] = [];

  if (eaten.kcal > target.kcal * 1.15) warnings.push("kcal_over_115pct");
  else if (eaten.kcal < target.kcal * 0.8) warnings.push("kcal_under_80pct");

  if (eaten.proteinGrams > target.proteinGrams * 1.3) warnings.push("protein_over_130pct");
  else if (eaten.proteinGrams < target.proteinGrams * 0.8) warnings.push("protein_under_80pct");

  if ((eaten.sodiumMg ?? 0) > 2300) warnings.push("sodium_over_2300mg");

  return warnings;
}
