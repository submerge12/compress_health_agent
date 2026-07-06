import { describe, expect, test } from "vitest";

import type { BmrProfileRow, DietLogRow } from "../../src/db/repository.js";
import type { ToolContext } from "../../src/tools/context.js";
import { handleWeeklyReport } from "../../src/tools/handlers.js";

const profile: BmrProfileRow = {
  id: "profile-id",
  userId: "user-id",
  sex: "female",
  ageYears: 31,
  heightCm: 165,
  weightKg: 60,
  activityLevel: "lightly_active",
  goal: "maintain",
  bmrKcal: 1380,
  tdeeKcal: 1900,
  targetKcal: 1800,
  proteinTargetGrams: 110,
  carbsTargetGrams: 200,
  fatTargetGrams: 45,
};

describe("handleWeeklyReport", () => {
  test("passes stored fat and carbs targets into the weekly budget line", async () => {
    const ctx = makeContext(
      Array.from({ length: 7 }, (_, index) =>
        dietLog(`2026-06-${10 + index}`, {
          fatGrams: 50,
          carbsGrams: 190,
          sodiumMg: 2100,
        }),
      ),
      profile,
    );

    const report = await handleWeeklyReport(ctx, {
      endDate: "2026-06-16",
      sodiumLimitMg: 2000,
    });

    expect(report.weeklyBudgetLine).toContain("fat 350g / 315g, 11.1% over");
    expect(report.weeklyBudgetLine).toContain("carbs 1330g / 1400g, 5% under");
    expect(report.weeklyBudgetLine).not.toContain("fat 350g logged, no weekly target");
    expect(report.weeklyBudgetLine).not.toContain("carbs 1330g logged, no weekly target");
  });
});

function makeContext(dietLogs: readonly DietLogRow[], latestProfile: BmrProfileRow | undefined): ToolContext {
  return {
    userId: "user-id",
    locale: "zh",
    catalog: { foods: [], naturalUnits: [] },
    seasoningRecords: [],
    repo: {
      listDietLogsRange: async (userId: string, startDate: string, endDate: string) => {
        expect(userId).toBe("user-id");
        expect(startDate).toBe("2026-06-10");
        expect(endDate).toBe("2026-06-16");
        return dietLogs;
      },
      getLatestBmrProfile: async (userId: string) => {
        expect(userId).toBe("user-id");
        return latestProfile;
      },
    } as unknown as ToolContext["repo"],
    close: async () => undefined,
  };
}

function dietLog(logDate: string, overrides: Partial<DietLogRow> = {}): DietLogRow {
  return {
    id: `log-${logDate}`,
    userId: "user-id",
    logDate,
    mealType: "lunch",
    description: "logged lunch",
    source: "agent",
    ingredientsJson: [],
    seasoningsJson: [],
    caloriesKcal: 1800,
    proteinGrams: 100,
    carbsGrams: 200,
    fatGrams: 45,
    sodiumMg: 1800,
    ...overrides,
  };
}
