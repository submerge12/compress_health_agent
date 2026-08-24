/**
 * M06 / P4: The user's reference three-split program as versionable DATA
 * (plan §12.2) — seeded once per user via plan_versions + training_templates,
 * never hard-coded planner rules.
 */
export interface TemplateItem {
  order: number;
  exerciseSlug: string;
  nameZh: string;
  movementPattern: string;
  sets: number;
  repRangeLow?: number;
  repRangeHigh?: number;
  rirLow?: number;
  rirHigh?: number;
  note?: string;
  /** Same-purpose alternatives; substitution must not stack volume (§14.3). */
  alternates?: string[];
}

export interface SplitDayTemplate {
  dayRole: "A" | "B" | "C";
  name: string;
  items: TemplateItem[];
}

export const DEFAULT_EXERCISES: Array<{
  slug: string;
  nameZh: string;
  nameEn: string;
  movementPattern: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  equipment: string;
}> = [
  { slug: "barbell_bench_press", nameZh: "杠铃卧推", nameEn: "Barbell bench press", movementPattern: "horizontal_push", primaryMuscles: ["chest"], secondaryMuscles: ["front_delts", "triceps"], equipment: "barbell" },
  { slug: "incline_dumbbell_press", nameZh: "上斜哑铃卧推", nameEn: "Incline dumbbell press", movementPattern: "horizontal_push", primaryMuscles: ["upper_chest"], secondaryMuscles: ["front_delts"], equipment: "dumbbell" },
  { slug: "dip_assisted", nameZh: "双杠臂屈伸（辅助）", nameEn: "Assisted dip", movementPattern: "vertical_push", primaryMuscles: ["chest", "triceps"], secondaryMuscles: ["front_delts"], equipment: "machine" },
  { slug: "lying_triceps_extension", nameZh: "仰卧臂屈伸", nameEn: "Lying triceps extension", movementPattern: "elbow_extension", primaryMuscles: ["triceps"], secondaryMuscles: [], equipment: "barbell" },
  { slug: "y_raise_cable_lateral", nameZh: "Y字上举/绳索侧平举", nameEn: "Y raise / cable lateral raise", movementPattern: "lateral_raise", primaryMuscles: ["side_delts"], secondaryMuscles: [], equipment: "cable" },
  { slug: "single_cable_pulldown", nameZh: "单手绳索下拉", nameEn: "Single-arm cable pulldown", movementPattern: "vertical_pull", primaryMuscles: ["lats"], secondaryMuscles: ["biceps"], equipment: "cable" },
  { slug: "neutral_grip_pulldown", nameZh: "对握下拉", nameEn: "Neutral-grip pulldown", movementPattern: "vertical_pull", primaryMuscles: ["lats"], secondaryMuscles: ["biceps"], equipment: "cable" },
  { slug: "single_machine_row", nameZh: "单手机械划船", nameEn: "Single-arm machine row", movementPattern: "horizontal_pull", primaryMuscles: ["mid_back"], secondaryMuscles: ["biceps"], equipment: "machine" },
  { slug: "chest_supported_row", nameZh: "胸托划船/坐姿开肘划船", nameEn: "Chest-supported row", movementPattern: "horizontal_pull", primaryMuscles: ["rear_delts", "mid_back"], secondaryMuscles: [], equipment: "machine" },
  { slug: "cable_curl", nameZh: "绳索弯举", nameEn: "Cable curl", movementPattern: "elbow_flexion", primaryMuscles: ["biceps"], secondaryMuscles: [], equipment: "cable" },
  { slug: "single_leg_rdl", nameZh: "单腿硬拉", nameEn: "Single-leg RDL", movementPattern: "single_leg_hinge", primaryMuscles: ["hamstrings", "glutes"], secondaryMuscles: ["core"], equipment: "dumbbell" },
  { slug: "bulgarian_split_squat", nameZh: "保加利亚分腿蹲", nameEn: "Bulgarian split squat", movementPattern: "single_leg_squat", primaryMuscles: ["quads", "glutes"], secondaryMuscles: [], equipment: "dumbbell" },
  { slug: "goblet_squat", nameZh: "高脚杯深蹲", nameEn: "Goblet squat", movementPattern: "squat", primaryMuscles: ["quads"], secondaryMuscles: ["glutes", "core"], equipment: "dumbbell" },
  { slug: "romanian_deadlift", nameZh: "罗马尼亚硬拉", nameEn: "Romanian deadlift", movementPattern: "hinge", primaryMuscles: ["hamstrings", "glutes"], secondaryMuscles: [], equipment: "barbell" },
  { slug: "back_extension", nameZh: "山羊挺身", nameEn: "Back extension", movementPattern: "hinge", primaryMuscles: ["lower_back", "glutes"], secondaryMuscles: ["hamstrings"], equipment: "bench" },
  { slug: "calf_raise", nameZh: "提踵", nameEn: "Calf raise", movementPattern: "calf", primaryMuscles: ["calves"], secondaryMuscles: [], equipment: "machine" },
  { slug: "core_crunch", nameZh: "卷腹", nameEn: "Crunch", movementPattern: "core_flexion", primaryMuscles: ["abs"], secondaryMuscles: [], equipment: "bodyweight" },
  { slug: "hanging_knee_raise_regressed", nameZh: "退阶悬垂举腿", nameEn: "Regressed hanging knee raise", movementPattern: "core_flexion", primaryMuscles: ["abs"], secondaryMuscles: ["hip_flexors"], equipment: "pullup_bar" },
  { slug: "ab_wheel", nameZh: "腹轮", nameEn: "Ab wheel rollout", movementPattern: "core_anti_extension", primaryMuscles: ["abs"], secondaryMuscles: ["lats"], equipment: "ab_wheel" },
];

export const THREE_SPLIT_DAYS: SplitDayTemplate[] = [
  {
    dayRole: "A",
    name: "胸、肩中束、三头",
    items: [
      { order: 1, exerciseSlug: "barbell_bench_press", nameZh: "杠铃卧推", movementPattern: "horizontal_push", sets: 3, repRangeLow: 8, repRangeHigh: 10, rirLow: 2, rirHigh: 2, note: "主水平推" },
      { order: 2, exerciseSlug: "incline_dumbbell_press", nameZh: "上斜哑铃卧推", movementPattern: "horizontal_push", sets: 3, repRangeLow: 8, repRangeHigh: 12, rirLow: 2, rirHigh: 2, note: "上胸/稳定需求变化" },
      { order: 3, exerciseSlug: "dip_assisted", nameZh: "双杠臂屈伸（辅助）", movementPattern: "vertical_push", sets: 2, repRangeLow: 6, repRangeHigh: 12, rirLow: 1, rirHigh: 2, note: "可按肩/肘舒适度退阶" },
      { order: 4, exerciseSlug: "lying_triceps_extension", nameZh: "仰卧臂屈伸", movementPattern: "elbow_extension", sets: 2, repRangeLow: 10, repRangeHigh: 15, rirLow: 2, rirHigh: 2, note: "三头" },
      { order: 5, exerciseSlug: "y_raise_cable_lateral", nameZh: "Y字上举/绳索侧平举", movementPattern: "lateral_raise", sets: 3, repRangeLow: 12, repRangeHigh: 20, rirLow: 2, rirHigh: 2, note: "肩中束，二者为替代关系而非叠加" },
    ],
  },
  {
    dayRole: "B",
    name: "背、肩后束、二头",
    items: [
      { order: 1, exerciseSlug: "single_cable_pulldown", nameZh: "单手绳索下拉", movementPattern: "vertical_pull", sets: 3, repRangeLow: 10, repRangeHigh: 12, rirLow: 2, rirHigh: 2, note: "垂直拉" },
      { order: 2, exerciseSlug: "neutral_grip_pulldown", nameZh: "对握下拉", movementPattern: "vertical_pull", sets: 3, repRangeLow: 8, repRangeHigh: 12, rirLow: 2, rirHigh: 2, note: "垂直拉" },
      { order: 3, exerciseSlug: "single_machine_row", nameZh: "单手机械划船", movementPattern: "horizontal_pull", sets: 2, repRangeLow: 8, repRangeHigh: 12, rirLow: 2, rirHigh: 2, note: "水平拉" },
      { order: 4, exerciseSlug: "chest_supported_row", nameZh: "胸托划船/坐姿开肘划船", movementPattern: "horizontal_pull", sets: 2, repRangeLow: 10, repRangeHigh: 15, rirLow: 2, rirHigh: 2, note: "水平拉/后束，替代关系" },
      { order: 5, exerciseSlug: "cable_curl", nameZh: "绳索弯举", movementPattern: "elbow_flexion", sets: 3, repRangeLow: 10, repRangeHigh: 15, rirLow: 2, rirHigh: 2, note: "二头" },
    ],
  },
  {
    dayRole: "C",
    name: "腿部和后侧链",
    items: [
      { order: 1, exerciseSlug: "single_leg_rdl", nameZh: "单腿硬拉", movementPattern: "single_leg_hinge", sets: 2, repRangeLow: 8, repRangeHigh: 10, rirLow: 2, rirHigh: 3, note: "单腿稳定+髋铰链（每侧）" },
      { order: 2, exerciseSlug: "bulgarian_split_squat", nameZh: "保加利亚分腿蹲", movementPattern: "single_leg_squat", sets: 3, repRangeLow: 8, repRangeHigh: 10, rirLow: 2, rirHigh: 2, note: "单腿蹲（每侧）" },
      { order: 3, exerciseSlug: "goblet_squat", nameZh: "高脚杯深蹲", movementPattern: "squat", sets: 3, repRangeLow: 8, repRangeHigh: 12, rirLow: 2, rirHigh: 2, note: "蹲模式" },
      { order: 4, exerciseSlug: "romanian_deadlift", nameZh: "罗马尼亚硬拉", movementPattern: "hinge", sets: 2, repRangeLow: 8, repRangeHigh: 10, rirLow: 2, rirHigh: 2, note: "髋铰链" },
      { order: 5, exerciseSlug: "back_extension", nameZh: "山羊挺身", movementPattern: "hinge", sets: 2, repRangeLow: 10, repRangeHigh: 15, rirLow: 2, rirHigh: 2, note: "后侧链" },
      { order: 6, exerciseSlug: "calf_raise", nameZh: "提踵", movementPattern: "calf", sets: 3, repRangeLow: 10, repRangeHigh: 15, rirLow: 2, rirHigh: 2, note: "小腿，可选" },
      { order: 7, exerciseSlug: "core_crunch", nameZh: "核心（卷腹/退阶悬垂举腿/腹轮择一）", movementPattern: "core_flexion", sets: 3, rirLow: 2, rirHigh: 2, note: "按控制能力选一，不叠加", alternates: ["hanging_knee_raise_regressed", "ab_wheel"] },
    ],
  },
];

/** §12.3 default cycle; densification is a proposal, never permanent code. */
export const DEFAULT_CYCLE: string[] = ["A", "B", "REST", "C", "REST"];
