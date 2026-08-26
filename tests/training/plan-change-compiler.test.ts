import { describe, expect, it } from "vitest";

import {
  compilePlanChanges,
  type PlanCompileContext,
  PlanChangeValidationError,
} from "../../src/training/plan-change-compiler.js";

const parent = {
  days: {
    A: [
      {
        order: 1,
        exerciseSlug: "bench_press",
        nameZh: "卧推",
        movementPattern: "horizontal_push",
        sets: 3,
        repRangeLow: 8,
        repRangeHigh: 10,
        rirLow: 2,
        rirHigh: 2,
        alternates: ["dumbbell_press"],
        cueRefs: ["segment-old"],
        videoRefs: ["video-old"],
      },
      {
        order: 2,
        exerciseSlug: "cable_fly",
        nameZh: "夹胸",
        movementPattern: "horizontal_adduction",
        sets: 2,
      },
    ],
    B: [{ order: 1, exerciseSlug: "row", sets: 3, movementPattern: "horizontal_pull" }],
  },
  cyclePattern: ["A", "B", "REST"],
};

const exerciseCatalog = new Map([
  ["bench_press", {
    nameZh: "卧推", movementPattern: "horizontal_push", trainingPurpose: "hypertrophy",
    primaryMuscles: ["chest"], stabilityDemand: "medium", equipment: "barbell", rangeOfMotion: "full",
  }],
  ["dumbbell_press", {
    nameZh: "哑铃卧推", movementPattern: "horizontal_push", trainingPurpose: "hypertrophy",
    primaryMuscles: ["chest"], stabilityDemand: "high", equipment: "dumbbell", rangeOfMotion: "full",
  }],
  ["machine_press", {
    nameZh: "器械推胸", movementPattern: "horizontal_push", trainingPurpose: "hypertrophy",
    primaryMuscles: ["chest"], stabilityDemand: "low", equipment: "machine", rangeOfMotion: "full",
  }],
  ["cable_fly", {
    nameZh: "夹胸", movementPattern: "horizontal_adduction", trainingPurpose: "hypertrophy",
    primaryMuscles: ["chest"], stabilityDemand: "medium", equipment: "cable", rangeOfMotion: "full",
  }],
  ["row", {
    nameZh: "划船", movementPattern: "horizontal_pull", trainingPurpose: "hypertrophy",
    primaryMuscles: ["mid_back"], stabilityDemand: "medium", equipment: "cable", rangeOfMotion: "full",
  }],
  ["pulldown", {
    nameZh: "下拉", movementPattern: "vertical_pull", trainingPurpose: "hypertrophy",
    primaryMuscles: ["lats"], stabilityDemand: "medium", equipment: "cable", rangeOfMotion: "full",
  }],
]);

const cueReferences = new Map([
  ["segment-new", {
    valid: true,
    exerciseSlug: "bench_press",
    movementPattern: "horizontal_push",
    bodyPart: "chest",
  }],
  ["segment-technique", {
    valid: true,
    exerciseSlug: "bench_press",
    movementPattern: "horizontal_push",
    bodyPart: "chest",
  }],
]);

describe("typed plan change compiler", () => {
  it("compiles prescription, swap, cycle, alternative, cue, add/remove and reorder changes with a full diff", () => {
    const original = structuredClone(parent);
    const compiled = compilePlanChanges(parent, [
      { kind: "update_sets", dayRole: "A", exerciseSlug: "bench_press", sets: 4 },
      {
        kind: "update_rep_range",
        dayRole: "A",
        exerciseSlug: "bench_press",
        repRangeLow: 6,
        repRangeHigh: 8,
      },
      {
        kind: "update_rir",
        dayRole: "A",
        exerciseSlug: "bench_press",
        rirLow: 1,
        rirHigh: 2,
      },
      {
        kind: "update_alternatives",
        dayRole: "A",
        exerciseSlug: "bench_press",
        alternatives: ["dumbbell_press", "machine_press"],
      },
      {
        kind: "update_cue_refs",
        dayRole: "A",
        exerciseSlug: "bench_press",
        cueRefs: ["segment-new", "segment-technique"],
      },
      {
        kind: "replace_exercise",
        dayRole: "A",
        exerciseSlug: "cable_fly",
        replacementExerciseSlug: "machine_press",
      },
      {
        kind: "add_exercise",
        dayRole: "B",
        exerciseSlug: "pulldown",
        sets: 2,
        repRangeLow: 8,
        repRangeHigh: 12,
        rirLow: 2,
        rirHigh: 3,
      },
      { kind: "remove_exercise", dayRole: "B", exerciseSlug: "row" },
      { kind: "reorder_exercises", dayRole: "A", order: ["machine_press", "bench_press"] },
      { kind: "update_cycle_pattern", cyclePattern: ["A", "REST", "B", "REST"] },
    ], { exerciseCatalog, cueReferences });

    expect(parent).toEqual(original);
    expect(compiled.content.days.A!.map((item) => item.exerciseSlug)).toEqual([
      "machine_press",
      "bench_press",
    ]);
    expect(compiled.content.days.A![1]).toMatchObject({
      sets: 4,
      repRangeLow: 6,
      repRangeHigh: 8,
      rirLow: 1,
      rirHigh: 2,
      alternates: ["dumbbell_press", "machine_press"],
      cueRefs: ["segment-new", "segment-technique"],
    });
    expect(compiled.content.days.B).toEqual([
      expect.objectContaining({ exerciseSlug: "pulldown", order: 1, sets: 2 }),
    ]);
    expect(compiled.content.cyclePattern).toEqual(["A", "REST", "B", "REST"]);
    expect(compiled.diff.changes).toHaveLength(10);
    expect(compiled.diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "update_sets",
        before: { sets: 3 },
        after: { sets: 4 },
      }),
      expect.objectContaining({
        kind: "replace_exercise",
        before: expect.objectContaining({ exerciseSlug: "cable_fly" }),
        after: expect.objectContaining({ exerciseSlug: "machine_press" }),
      }),
      expect.objectContaining({
        kind: "update_cycle_pattern",
        before: ["A", "B", "REST"],
        after: ["A", "REST", "B", "REST"],
      }),
    ]));
    expect(compiled.diff.changedDays.map((day) => day.dayRole)).toEqual(["A", "B"]);
  });

  it("rejects an unknown target and volume beyond the per-day bound", () => {
    expect(() => compilePlanChanges(parent, [{
      kind: "update_sets",
      dayRole: "A",
      exerciseSlug: "missing",
      sets: 4,
    }], { exerciseCatalog })).toThrow(PlanChangeValidationError);

    expect(() => compilePlanChanges(parent, [{
      kind: "update_sets",
      dayRole: "A",
      exerciseSlug: "bench_press",
      sets: 40,
    }], { exerciseCatalog })).toThrow(/sets/);
  });

  it("rejects invalid alternatives when adding an exercise", () => {
    expect(() => compilePlanChanges(parent, [{
      kind: "add_exercise",
      dayRole: "B",
      exerciseSlug: "pulldown",
      sets: 2,
      alternatives: ["pulldown"],
    }], { exerciseCatalog })).toThrow(/own alternative/);

    expect(() => compilePlanChanges(parent, [{
      kind: "add_exercise",
      dayRole: "B",
      exerciseSlug: "pulldown",
      sets: 2,
      alternatives: ["unknown_pull"],
    }], { exerciseCatalog })).toThrow(/not in the exercise catalog/);
  });

  it("replaces only the prescription and never inherits old cue, alternate, or video references", () => {
    const compiled = compilePlanChanges(parent, [{
      kind: "replace_exercise",
      dayRole: "A",
      exerciseSlug: "bench_press",
      replacementExerciseSlug: "dumbbell_press",
    }], { exerciseCatalog });

    const replacement = compiled.content.days.A![0]!;
    expect(replacement).toMatchObject({
      exerciseSlug: "dumbbell_press",
      sets: 3,
      repRangeLow: 8,
      repRangeHigh: 10,
      rirLow: 2,
      rirHigh: 2,
    });
    expect(replacement).not.toHaveProperty("cueRefs");
    expect(replacement).not.toHaveProperty("alternates");
    expect(replacement).not.toHaveProperty("videoRefs");
    expect(compiled.diff.changes[0]).toMatchObject({
      assessment: {
        preserved: expect.arrayContaining([expect.stringContaining("training purpose")]),
        volume: { beforeSets: 3, afterSets: 3, changed: false },
        allowedBecause: expect.any(Array),
        nextValidation: expect.any(Array),
      },
    });
  });

  it("rejects an unrelated primary-muscle replacement", () => {
    expect(() => compilePlanChanges(parent, [{
      kind: "replace_exercise",
      dayRole: "A",
      exerciseSlug: "bench_press",
      replacementExerciseSlug: "row",
    }], { exerciseCatalog })).toThrow(/primary muscle/i);
  });

  it("enforces purpose, stability, equipment, range-of-motion, and joint safety profiles", () => {
    const replacement = exerciseCatalog.get("dumbbell_press")!;
    const original = exerciseCatalog.get("bench_press")!;
    const cases: Array<{
      label: string;
      originalPatch?: Record<string, unknown>;
      replacementPatch?: Record<string, unknown>;
      context?: Omit<PlanCompileContext, "exerciseCatalog">;
      expected: RegExp;
    }> = [
      { label: "purpose", replacementPatch: { trainingPurpose: "strength" }, expected: /training purpose mismatch/i },
      {
        label: "stability",
        originalPatch: { stabilityDemand: "low" },
        replacementPatch: { stabilityDemand: "high" },
        expected: /stability demand increases/i,
      },
      { label: "equipment", context: { unavailableEquipment: new Set(["dumbbell"]) }, expected: /equipment.*unavailable/i },
      {
        label: "range of motion",
        originalPatch: { rangeOfMotion: "reduced" },
        replacementPatch: { rangeOfMotion: "full" },
        expected: /range of motion increases/i,
      },
      {
        label: "joint",
        replacementPatch: { contraindicationTags: ["shoulder"] },
        context: { activeJointConstraints: new Set(["shoulder"]) },
        expected: /joint constraints/i,
      },
    ];

    for (const testCase of cases) {
      const catalog = new Map(exerciseCatalog);
      catalog.set("bench_press", { ...original, ...testCase.originalPatch });
      catalog.set("dumbbell_press", { ...replacement, ...testCase.replacementPatch });
      expect(() => compilePlanChanges(parent, [{
        kind: "replace_exercise",
        dayRole: "A",
        exerciseSlug: "bench_press",
        replacementExerciseSlug: "dumbbell_press",
      }], { exerciseCatalog: catalog, ...testCase.context }), testCase.label).toThrow(testCase.expected);
    }
  });

  it("rejects excessive consecutive training and repeated body-part days", () => {
    expect(() => compilePlanChanges(parent, [{
      kind: "update_cycle_pattern",
      cyclePattern: ["A", "B", "A", "B", "A", "REST"],
    }], { exerciseCatalog })).toThrow(/three consecutive training days/i);
    expect(() => compilePlanChanges(parent, [{
      kind: "update_cycle_pattern",
      cyclePattern: ["A", "A", "REST", "B"],
    }], { exerciseCatalog })).toThrow(/repeats body-part day/i);
  });
});
