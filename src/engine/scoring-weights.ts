/**
 * Shared planner constants (bands, floors, caps). The v1 weighted-sum
 * scoring weights that used to live here were deleted outright per the
 * CHA-MPV2-5 G2 decision — rotation fill plus the staple and protein-top-up
 * levers are the only planner path. The filename is kept for import
 * stability across engine/tool modules.
 */
export const ENERGY_TOLERANCE_RATIO = 0.12;
export const MAX_ENERGY_TOLERANCE_RATIO = 0.15;
export const PROTEIN_FLOOR_RATIO = 0.8;
export const SODIUM_CAP_MG = 2300;
export const MIN_DISTINCT_DISHES = 10;

// Weekly serving floors per classification bucket. Sourced from config (not the
// selected plan) so an entirely-absent bucket still incurs a deficit and gets
// pulled in. red_meat ≥2, deep_sea_fish ≥2, shellfish ≥1 per week.
export const WEEKLY_FLOORS: Readonly<Record<string, number>> = {
  red_meat: 2,
  deep_sea_fish: 2,
  shellfish: 1,
};
