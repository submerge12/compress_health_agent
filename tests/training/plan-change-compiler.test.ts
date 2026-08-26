import { describe, expect, it } from "vitest";

import {
  compilePlanChanges,
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
  ["bench_press", { nameZh: "卧推", movementPattern: "horizontal_push" }],
  ["dumbbell_press", { nameZh: "哑铃卧推", movementPattern: "horizontal_push" }],
  ["machine_press", { nameZh: "器械推胸", movementPattern: "horizontal_push" }],
  ["cable_fly", { nameZh: "夹胸", movementPattern: "horizontal_adduction" }],
  ["row", { nameZh: "划船", movementPattern: "horizontal_pull" }],
  ["pulldown", { nameZh: "下拉", movementPattern: "vertical_pull" }],
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
    ], { exerciseCatalog });

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
});
