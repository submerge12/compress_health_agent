import { describe, expect, test } from "vitest";

import type { BmrProfileRow } from "../../src/db/repository.js";
import type { ToolContext } from "../../src/tools/context.js";
import { handleGetProfile } from "../../src/tools/handlers.js";

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
  targetKcal: 1850,
  proteinTargetGrams: 110,
  carbsTargetGrams: 200,
  fatTargetGrams: 60,
};

function makeContext(latest: BmrProfileRow | undefined): ToolContext {
  return {
    userId: "user-id",
    locale: "zh",
    catalog: { foods: [], naturalUnits: [] },
    seasoningRecords: [],
    repo: {
      getLatestBmrProfile: async (userId: string) => {
        expect(userId).toBe("user-id");
        return latest;
      },
    } as unknown as ToolContext["repo"],
    close: async () => undefined,
  };
}

describe("handleGetProfile", () => {
  test("returns the saved profile for a returning user", async () => {
    const result = await handleGetProfile(makeContext(profile), {});
    expect(result.profile).toMatchObject({ sex: "female", targetKcal: 1850 });
  });

  test("returns null when no profile exists yet", async () => {
    const result = await handleGetProfile(makeContext(undefined), {});
    expect(result.profile).toBeNull();
  });
});
