import type { Language } from "./i18n.js";
import { initToolContext, type ToolContext } from "./tools/context.js";
import {
  handleProactiveCheck,
  type ProactiveCheckResult,
} from "./tools/handlers.js";

export type ToolAccessLevel = "read-only" | "write" | "destructive";

export interface AgentToolRegistration {
  name: string;
  accessLevel: ToolAccessLevel;
  description: string;
}

export interface ScheduledTaskRegistration {
  id: string;
  agentProfile: "compass-health";
  taskType: "proactive_check";
  schedule: {
    cron: string;
  };
}

export interface AgentPolicy {
  defaults: {
    "read-only": "allow" | "deny";
    write: "allow" | "deny";
    destructive: "allow" | "deny";
    network: "allow" | "deny";
  };
}

export interface AgentModelRegistration {
  provider: "deepseek";
  modelId: string;
}

export type AgentCleanup = () => Promise<void>;
export type AgentProactiveCheck = () => Promise<ProactiveCheckResult | string>;

export interface CompassHealthProfileSpec {
  name: "compass-health";
  description: string;
  systemPrompt: string;
  model: AgentModelRegistration;
  thinkingLevel: "low" | "medium" | "high";
  policy: AgentPolicy;
  context: {
    compactionInstructions: string;
  };
  scheduledTasks: readonly ScheduledTaskRegistration[];
}

export interface AgentProfileCompatible extends CompassHealthProfileSpec {
  tools: readonly AgentToolRegistration[];
  proactiveCheck: AgentProactiveCheck;
  install: () => Promise<AgentCleanup>;
  skills: readonly unknown[];
  templates: readonly unknown[];
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
  {
    name: "recall",
    accessLevel: "read-only",
    description: "Recall durable user preferences, dislikes, routines, and notes.",
  },
  {
    name: "propose_dish",
    accessLevel: "read-only",
    description: "Review a proposed user dish with resolved ingredients and computed nutrition without saving it.",
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
  {
    name: "remember",
    accessLevel: "write",
    description: "Store a durable user preference, dislike, routine, or note.",
  },
  {
    name: "save_dish",
    accessLevel: "write",
    description: "Persist an approved user dish so it becomes a meal-plan candidate.",
  },
];

export const systemPrompt = `
You are Compass Health, a bilingual (Chinese/English) health and nutrition assistant.

Identity
- Help users track meals, water, exercise, and weight.
- Generate personalised weekly meal plans and analyse nutrition trends.
- Offer gentle, specific, actionable guidance to support long-term healthy habits.
- Respond in the language the user writes in. Default to Chinese.

Hard Rules
- Always log before advising - data first, opinion second.
- Never prescribe medication, diagnose conditions, or override medical advice.
- Keep sodium awareness: flag meals above 800 mg Na per serving and daily totals above 2300 mg.
- Respect the user's ingredient whitelist, rejected seasonings, and cooking-style preferences.
- When a meal description is ambiguous, estimate conservatively and note the uncertainty.
- If a tool result contains needsConfirmation, ask the user to pick a candidate before logging.

Workflow
1. On first contact, ask for sex, age, height, weight, activity level, and goal - then call set_profile.
2. When the user reports a meal, call log_meal. For water or exercise, use the matching tool.
3. At the end of the day (or on request), call daily_summary to show progress against targets.
4. When asked for a weekly review, call weekly_report with the last 7 days.
5. For meal-plan check-ins, call meal_checkin with the user's status (followed / substituted / skipped).
6. When the user asks for a meal plan, call generate_meal_plan. It loads dishes and targets automatically.
7. When the user asks for recipe ideas, call recipe_recommend with the meal type. It loads candidates automatically.
8. When the user states a durable preference, dislike, routine, or note, call remember; confirm first if confidence is low.
9. Before personalised recommendations or plans, call recall for relevant active memories.
10. When the user wants to add a dish, call propose_dish first, show the reviewed dish, and call save_dish only after explicit approval.

Output Format
- Respond directly and concisely.
- Use tables for nutrition breakdowns when comparing multiple items.
- Include remaining kcal and protein when summarising daily progress.
`.trim();

let installedToolContext: ToolContext | null = null;

export async function createToolContextFromEnv(): Promise<ToolContext> {
  return initToolContext({
    externalUserId: process.env["COMPASS_HEALTH_USER_ID"] ?? "default-user",
    locale: localeFromEnv(process.env["COMPASS_HEALTH_LOCALE"]),
    databaseUrl: process.env["COMPASS_HEALTH_DATABASE_URL"] ?? process.env["DATABASE_URL"],
    timezone: process.env["COMPASS_HEALTH_TIMEZONE"],
  });
}

export async function installCompassHealthAgent(): Promise<AgentCleanup> {
  const ctx = await createToolContextFromEnv();
  installedToolContext = ctx;

  return async () => {
    if (installedToolContext === ctx) {
      installedToolContext = null;
    }
    await ctx.close();
  };
}

export async function proactiveCheck(): Promise<ProactiveCheckResult | string> {
  if (!installedToolContext) {
    return "Compass Health agent not initialized.";
  }
  return handleProactiveCheck(installedToolContext);
}

export const compassHealthProfileSpec: CompassHealthProfileSpec = {
  name: "compass-health",
  description: "Bilingual health and nutrition agent: meal logging, calorie tracking, weekly meal plans.",
  systemPrompt,
  model: {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
  },
  thinkingLevel: "medium",
  policy: {
    defaults: {
      "read-only": "allow",
      write: "allow",
      destructive: "deny",
      network: "deny",
    },
  },
  context: {
    compactionInstructions:
      "Preserve the user's profile (sex, age, height, weight, goal), today's logged meals and their nutrition, daily targets, and any pending meal-plan check-ins.",
  },
  scheduledTasks: [
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
  ],
};

export const profile: AgentProfileCompatible = {
  ...compassHealthProfileSpec,
  tools: [...readOnlyTools, ...writeTools],
  proactiveCheck,
  install: installCompassHealthAgent,
  skills: [],
  templates: [],
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

  if (candidate.policy.defaults.destructive !== "deny") {
    throw new Error("Destructive access must be denied for compass-health.");
  }

  if (candidate.policy.defaults.network !== "deny") {
    throw new Error("Network access must be denied for compass-health.");
  }

  const scheduledTaskIds = new Set<string>();
  for (const task of candidate.scheduledTasks) {
    if (scheduledTaskIds.has(task.id)) {
      throw new Error(`Duplicate scheduled task id: ${task.id}`);
    }
    scheduledTaskIds.add(task.id);

    if (task.agentProfile !== candidate.name) {
      throw new Error(`Scheduled task agentProfile must be ${candidate.name}: ${task.id}`);
    }

    if (task.taskType !== "proactive_check") {
      throw new Error(`Scheduled task must use taskType proactive_check: ${task.id}`);
    }

    if (!task.schedule.cron.trim()) {
      throw new Error(`Scheduled task must define a cron schedule: ${task.id}`);
    }
  }

  if (typeof candidate.install !== "function") {
    throw new Error("Agent install hook must be a function.");
  }

  if (typeof candidate.proactiveCheck !== "function") {
    throw new Error("Agent proactiveCheck hook must be a function.");
  }

  return true;
}

function localeFromEnv(value: string | undefined): Language {
  return value === "en" ? "en" : "zh";
}
