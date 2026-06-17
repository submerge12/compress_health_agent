export type ToolAccessLevel = "read-only" | "write" | "destructive";

export interface AgentToolRegistration {
  name: string;
  accessLevel: ToolAccessLevel;
  description: string;
}

export interface ScheduledTaskRegistration {
  name: string;
  toolName: string;
  schedule: string;
  description: string;
}

export interface AgentProfileCompatible {
  name: "compass-health";
  systemPrompt: {
    zh: string;
    en: string;
  };
  model: {
    provider: string;
    model: string;
    temperature: number;
  };
  tools: readonly AgentToolRegistration[];
  scheduledTasks: readonly ScheduledTaskRegistration[];
}

const readOnlyTools: readonly AgentToolRegistration[] = [
  {
    name: "nutrition_estimate",
    accessLevel: "read-only",
    description: "Estimate nutrition for foods without writing logs.",
  },
  {
    name: "daily_summary",
    accessLevel: "read-only",
    description: "Summarize one day of logged nutrition and activity.",
  },
  {
    name: "recipe_recommend",
    accessLevel: "read-only",
    description: "Recommend recipes from available preferences and records.",
  },
  {
    name: "weekly_report",
    accessLevel: "read-only",
    description: "Aggregate the last 7 days into a weekly nutrition report.",
  },
];

const writeTools: readonly AgentToolRegistration[] = [
  {
    name: "set_profile",
    accessLevel: "write",
    description: "Set or update the user's physical profile and compute calorie/macro targets.",
  },
  {
    name: "log_meal",
    accessLevel: "write",
    description: "Log a meal and its estimated nutrition.",
  },
  {
    name: "log_water",
    accessLevel: "write",
    description: "Log water intake.",
  },
  {
    name: "log_exercise",
    accessLevel: "write",
    description: "Log exercise activity.",
  },
  {
    name: "log_weight",
    accessLevel: "write",
    description: "Log body weight.",
  },
  {
    name: "update_cooking_record",
    accessLevel: "write",
    description: "Save or update a user's cooking record.",
  },
  {
    name: "generate_meal_plan",
    accessLevel: "write",
    description: "Generate and store a 7-day meal plan.",
  },
  {
    name: "meal_checkin",
    accessLevel: "write",
    description: "Record whether a planned meal was followed, substituted, or skipped.",
  },
];

export const profile: AgentProfileCompatible = {
  name: "compass-health",
  systemPrompt: {
    zh: "你是 Compass Health，一个双语健康饮食助手。你帮助用户记录饮食、饮水、运动和体重，生成一周餐单，分析营养趋势，并用温和、具体、可执行的建议支持长期改变。",
    en: "You are Compass Health, a bilingual health and nutrition assistant. Help users log meals, water, exercise, and weight, generate weekly meal plans, analyze nutrition trends, and offer gentle, specific, actionable guidance.",
  },
  model: {
    provider: "openai",
    model: "default-health-agent",
    temperature: 0.2,
  },
  tools: [...readOnlyTools, ...writeTools],
  scheduledTasks: [
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
  ],
};

export function validateAgentProfile(candidate: AgentProfileCompatible): true {
  const seen = new Set<string>();
  for (const tool of candidate.tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    seen.add(tool.name);
  }

  if (candidate.tools.some((tool) => tool.accessLevel === "destructive")) {
    throw new Error("Destructive tools are not allowed for compass-health.");
  }

  for (const task of candidate.scheduledTasks) {
    if (!seen.has(task.toolName)) {
      throw new Error(`Scheduled task references unknown tool: ${task.toolName}`);
    }
  }

  if (candidate.model.temperature < 0 || candidate.model.temperature > 1) {
    throw new Error("Model temperature must be between 0 and 1.");
  }

  return true;
}
