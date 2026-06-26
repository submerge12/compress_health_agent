import { describe, expect, test } from "vitest";
import {
  compassHealthProfileSpec,
  createToolContextFromEnv,
  profile,
  type AgentProfileCompatible,
  validateAgentProfile,
} from "../src/agent.js";

describe("agent profile", () => {
  test("test_profile_basicMetadata_matchesCompassHealthAgentContract", () => {
    expect(profile.name).toBe("compass-health");
    expect(profile).toMatchObject(compassHealthProfileSpec);
    expect(profile.systemPrompt).toContain("bilingual (Chinese/English) health and nutrition assistant");
    expect(profile.systemPrompt).toContain("Hard Rules");
    expect(profile.systemPrompt).toContain("call set_profile");
    expect(profile.model).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
    });
    expect(profile).toMatchObject({
      thinkingLevel: "medium",
      policy: {
        defaults: {
          "read-only": "allow",
          write: "allow",
          destructive: "deny",
          network: "deny",
        },
      },
    });
    expect(typeof profile.install).toBe("function");
    expect(profile.install.length).toBe(0);
    expect(typeof profile.proactiveCheck).toBe("function");
    expect(profile.proactiveCheck.length).toBe(0);
    expect(profile.skills).toEqual([]);
    expect(profile.templates).toEqual([]);
    expect(typeof createToolContextFromEnv).toBe("function");
    expect(createToolContextFromEnv.length).toBe(0);
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
      "propose_dish",
      "recall",
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
      "remember",
      "save_dish",
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

  test("test_profile_scheduledTasks_useProactiveCheckCronTasks", () => {
    expect(profile.scheduledTasks).toBe(compassHealthProfileSpec.scheduledTasks);
    expect(compassHealthProfileSpec.scheduledTasks).toHaveLength(4);
    expect(profile.scheduledTasks).toEqual([
      {
        id: "compass-health:meal_checkin_breakfast",
        agentProfile: "compass-health",
        taskType: "proactive_check",
        schedule: { cron: "30 8 * * *" },
      },
      {
        id: "compass-health:meal_checkin_lunch",
        agentProfile: "compass-health",
        taskType: "proactive_check",
        schedule: { cron: "30 12 * * *" },
      },
      {
        id: "compass-health:meal_checkin_dinner",
        agentProfile: "compass-health",
        taskType: "proactive_check",
        schedule: { cron: "30 18 * * *" },
      },
      {
        id: "compass-health:midnight_daily_summary",
        agentProfile: "compass-health",
        taskType: "proactive_check",
        schedule: { cron: "0 0 * * *" },
      },
    ]);
  });

  test("test_validateAgentProfile_duplicateScheduledTaskIds_throwHelpfulError", () => {
    const firstTask = profile.scheduledTasks[0];
    if (!firstTask) {
      throw new Error("Expected profile to register at least one scheduled task.");
    }

    expect(() =>
      validateAgentProfile({
        ...profile,
        scheduledTasks: [...profile.scheduledTasks, firstTask],
      }),
    ).toThrow("Duplicate scheduled task id: compass-health:meal_checkin_breakfast");
  });

  test("test_validateAgentProfile_rejectsUnsupportedScheduledTaskTypes", () => {
    const firstTask = profile.scheduledTasks[0];
    if (!firstTask) {
      throw new Error("Expected profile to register at least one scheduled task.");
    }

    expect(() =>
      validateAgentProfile({
        ...profile,
        scheduledTasks: [
          {
            ...firstTask,
            id: "compass-health:unsupported",
            taskType: "meal_checkin",
          },
        ],
      } as unknown as AgentProfileCompatible),
    ).toThrow("Scheduled task must use taskType proactive_check: compass-health:unsupported");
  });
});
