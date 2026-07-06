import assert from "node:assert/strict";

const root = await import("compass-health-agent");
const context = await import("compass-health-agent/tools/context");
const handlers = await import("compass-health-agent/tools/handlers");
const engineTypes = await import("compass-health-agent/engine/types");

const frameworkHandlerNames = [
  "handleSetProfile",
  "handleLogMeal",
  "handleLogWater",
  "handleLogExercise",
  "handleLogWeight",
  "handleMealCheckin",
  "handleUpdateCookingRecord",
  "handleSmartGenerateMealPlan",
  "handleNutritionEstimate",
  "handleDailySummary",
  "handleSmartRecipeRecommend",
  "handleWeeklyReport",
  "handleRemember",
  "handleRecall",
  "handleProposeDish",
  "handleSaveDish",
];

assert.equal(typeof root.main, "function");
assert.equal(typeof root.profile, "object");
assert.equal(typeof root.compassHealthProfileSpec, "object");
assert.equal(typeof root.createToolContextFromEnv, "function");
assert.equal(root.createToolContextFromEnv.length, 0);
assert.equal(root.compassHealthProfileSpec.model.provider, "deepseek");
assert.equal(root.compassHealthProfileSpec.thinkingLevel, "medium");
assert.equal(root.compassHealthProfileSpec.policy.defaults.destructive, "deny");
assert.equal(root.compassHealthProfileSpec.policy.defaults.network, "deny");
assert.equal(root.compassHealthProfileSpec.scheduledTasks.length, 4);
assert.equal(root.profile.model.provider, "deepseek");
assert.equal(root.profile.model.modelId, "deepseek-v4-pro");
assert.equal(root.profile.thinkingLevel, "medium");
assert.equal(typeof root.profile.install, "function");
assert.equal(root.profile.install.length, 0);
assert.equal(typeof root.profile.proactiveCheck, "function");
assert.equal(root.profile.proactiveCheck.length, 0);
assert.deepEqual(root.profile.skills, []);
assert.deepEqual(root.profile.templates, []);
assert.equal(typeof root.getToolHandler, "function");
assert.equal(typeof root.invokeTool, "function");

assert.equal(typeof context.initToolContext, "function");
assert.equal(context.initToolContext.length, 1);

for (const name of frameworkHandlerNames) {
  assert.equal(typeof handlers[name], "function", `${name} should be exported`);
  assert.equal(handlers[name].length, 2, `${name} should accept ctx and input`);
}

assert.equal(typeof handlers.handleProactiveCheck, "function", "handleProactiveCheck should be exported");
assert.equal(handlers.handleProactiveCheck.length, 1, "handleProactiveCheck should require ctx");

assert.deepEqual(Object.keys(engineTypes), [], "./engine/types is a type-only runtime export");
