import { describe, expect, test } from "vitest";
import { detectPatterns, type PatternDay } from "../../src/engine/pattern-detector.js";

const makeDay = (date: string, overrides: Partial<PatternDay> = {}): PatternDay => ({
  date,
  meals: [
    { type: "breakfast", skipped: false, kcal: 420, time: "08:10" },
    { type: "lunch", skipped: false, kcal: 650, time: "12:20" },
    { type: "dinner", skipped: false, kcal: 700, time: "18:45" },
  ],
  nutrientSources: {
    ironMg: {
      beef: 0.5,
      spinach: 0.5,
    },
  },
  ...overrides,
});

describe("pattern detector", () => {
  test("test_detectPatterns_mondayBreakfastAlwaysSkipped_returnsRequiredSkipPattern", () => {
    const days = Array.from({ length: 14 }, (_, index) => {
      const day = makeDay(`2026-06-${String(1 + index).padStart(2, "0")}`);
      if (day.date === "2026-06-01" || day.date === "2026-06-08") {
        return {
          ...day,
          meals: day.meals.map((meal) =>
            meal.type === "breakfast" ? { ...meal, skipped: true, kcal: 0 } : meal,
          ),
        };
      }
      return day;
    });

    expect(detectPatterns(days)).toContainEqual({
      pattern: "skip_breakfast",
      days: ["monday"],
      confidence: 1,
    });
  });

  test("test_detectPatterns_fourteenOrdinaryDays_returnsNoPatternsBoundary", () => {
    const days = Array.from({ length: 14 }, (_, index) =>
      makeDay(`2026-06-${String(1 + index).padStart(2, "0")}`),
    );

    expect(detectPatterns(days)).toEqual([]);
  });

  test("test_detectPatterns_invalidDate_throwsHelpfulError", () => {
    const days = Array.from({ length: 14 }, (_, index) =>
      makeDay(index === 0 ? "not-a-date" : `2026-06-${String(1 + index).padStart(2, "0")}`),
    );

    expect(() => detectPatterns(days)).toThrow("Invalid pattern day date: not-a-date");
  });

  test("test_detectPatterns_impossibleCalendarDate_throwsHelpfulError", () => {
    const days = Array.from({ length: 14 }, (_, index) =>
      makeDay(index === 0 ? "2026-06-31" : `2026-06-${String(1 + index).padStart(2, "0")}`),
    );

    expect(() => detectPatterns(days)).toThrow("Invalid pattern day date: 2026-06-31");
  });
});
