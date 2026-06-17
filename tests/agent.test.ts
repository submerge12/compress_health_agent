import { describe, expect, test } from "vitest";
import { profile, validateAgentProfile } from "../src/agent.js";

const chineseCharacters = /[\u3400-\u9fff]/;

describe("agent profile", () => {
  test("test_profile_basicMetadata_matchesCompassHealthAgentContract", () => {
    expect(profile.name).toBe("compass-health");
    expect(profile.systemPrompt.zh).toMatch(chineseCharacters);
    expect(profile.systemPrompt.en).not.toMatch(chineseCharacters);
    expect(profile.model.temperature).toBeGreaterThanOrEqual(0);
    expect(profile.model.temperature).toBeLessThanOrEqual(1);
    expect(validateAgentProfile(profile)).toBe(true);
  });

  test("test_profile_toolAccessLevels_arePartitionedWithoutDestructiveTools", () => {
    const readOnly = profile.tools
      .filter((tool) => tool.accessLevel === "read-only")
      .map((tool) => tool.name)
      .sort();
    const write = profile.tools
      .filter((tool) => tool.accessLevel === "write")
      .map((tool) => tool.name)
      .sort();
    const destructive = profile.tools.filter((tool) => tool.accessLevel === "destructive");

    expect(readOnly).toEqual([
      "daily_summary",
      "nutrition_estimate",
      "recipe_recommend",
      "weekly_report",
    ]);
    expect(write).toEqual([
      "generate_meal_plan",
      "log_exercise",
      "log_meal",
      "log_water",
      "log_weight",
      "meal_checkin",
      "set_profile",
      "update_cooking_record",
    ]);
    expect(destructive).toEqual([]);
  });

  test("test_validateAgentProfile_duplicateToolNames_throwHelpfulError", () => {
    const firstTool = profile.tools[0];
    if (!firstTool) {
      throw new Error("Expected profile to register at least one tool.");
    }

    expect(() =>
      validateAgentProfile({
        ...profile,
        tools: [...profile.tools, firstTool],
      }),
    ).toThrow("Duplicate tool registration: nutrition_estimate");
  });

  test("test_profile_scheduledTasks_includeMealCheckinsAndMidnightSummary", () => {
    expect(profile.scheduledTasks).toEqual([
      {
        name: "meal_checkin_breakfast",
        toolName: "meal_checkin",
        schedule: "30 8 * * *",
        description: "Prompt the user to confirm breakfast against the meal plan.",
      },
      {
        name: "meal_checkin_lunch",
        toolName: "meal_checkin",
        schedule: "30 12 * * *",
        description: "Prompt the user to confirm lunch against the meal plan.",
      },
      {
        name: "meal_checkin_dinner",
        toolName: "meal_checkin",
        schedule: "30 18 * * *",
        description: "Prompt the user to confirm dinner against the meal plan.",
      },
      {
        name: "midnight_daily_summary",
        toolName: "daily_summary",
        schedule: "0 0 * * *",
        description: "Send the previous day's nutrition summary at local midnight.",
      },
    ]);
  });
});
