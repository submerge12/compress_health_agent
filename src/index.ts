import { pathToFileURL } from "node:url";
import { profile } from "./agent.js";
import { initToolContext, type ToolContext } from "./tools/context.js";
import * as handlers from "./tools/handlers.js";

export { profile } from "./agent.js";
export { initToolContext, type ToolContext } from "./tools/context.js";
export * as handlers from "./tools/handlers.js";

export type ToolName = (typeof profile.tools)[number]["name"];

export type ToolHandler = (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;

function cast<T>(input: Record<string, unknown>): T {
  return input as unknown as T;
}

const toolRegistry: Record<string, ToolHandler> = {
  set_profile: (ctx, input) =>
    handlers.handleSetProfile(ctx, cast(input)),
  nutrition_estimate: (ctx, input) =>
    handlers.handleNutritionEstimate(ctx, cast(input)),
  log_meal: (ctx, input) =>
    handlers.handleLogMeal(ctx, cast(input)),
  log_water: (ctx, input) =>
    handlers.handleLogWater(ctx, cast(input)),
  log_exercise: (ctx, input) =>
    handlers.handleLogExercise(ctx, cast(input)),
  log_weight: (ctx, input) =>
    handlers.handleLogWeight(ctx, cast(input)),
  daily_summary: (ctx, input) =>
    handlers.handleDailySummary(ctx, cast(input)),
  weekly_report: (ctx, input) =>
    handlers.handleWeeklyReport(ctx, cast(input)),
  recipe_recommend: (ctx, input) =>
    handlers.handleSmartRecipeRecommend(ctx, cast(input)),
  generate_meal_plan: (ctx, input) =>
    handlers.handleSmartGenerateMealPlan(ctx, cast(input)),
  meal_checkin: (ctx, input) =>
    handlers.handleMealCheckin(ctx, cast(input)),
  update_cooking_record: (ctx, input) =>
    handlers.handleUpdateCookingRecord(ctx, cast(input)),
};

export function getToolHandler(name: string): ToolHandler | undefined {
  return toolRegistry[name];
}

export async function invokeTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const handler = toolRegistry[name];
  if (!handler) throw new RangeError(`Unknown tool: ${name}`);
  return handler(ctx, input);
}

// ── CLI entry point ──

export type OutputWriter = (message: string) => void;

export function main(write?: OutputWriter): string {
  const message = `compass-health agent ready — ${profile.tools.length} tools registered`;
  write?.(message);
  return message;
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectRun()) {
  main((message: string) => console.log(message));
}
