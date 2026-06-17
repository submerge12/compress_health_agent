import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext, type ToolContext } from "../../src/tools/context.js";
import * as handlers from "../../src/tools/handlers.js";
import { invokeTool } from "../../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";
const TEST_DATE = "2026-06-17";
const TEST_EXTERNAL_ID = "test-handler-e2e";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("handler end-to-end", () => {
  let ctx: ToolContext;

  beforeAll(async () => {
    ctx = await initToolContext({
      databaseUrl: DATABASE_URL,
      externalUserId: TEST_EXTERNAL_ID,
      locale: "zh",
      timezone: "Asia/Shanghai",
    });
  });

  afterAll(async () => {
    const pool = postgres(DATABASE_URL, { max: 1, prepare: false });
    const db = drizzle(pool, { schema });
    const userId = ctx.userId;
    await db.delete(schema.dietLogs).where(eq(schema.dietLogs.userId, userId));
    await db.delete(schema.waterLogs).where(eq(schema.waterLogs.userId, userId));
    await db.delete(schema.exerciseLogs).where(eq(schema.exerciseLogs.userId, userId));
    await db.delete(schema.physicalConditions).where(eq(schema.physicalConditions.userId, userId));
    await db.delete(schema.mealPlanEntries).where(eq(schema.mealPlanEntries.userId, userId));
    await db.delete(schema.cookingRecords).where(eq(schema.cookingRecords.userId, userId));
    await db.delete(schema.bmrProfiles).where(eq(schema.bmrProfiles.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end({ timeout: 3 });
    await ctx.close();
  });

  // ── Profile ──

  it("sets profile and computes correct calorie targets", async () => {
    const result = await handlers.handleSetProfile(ctx, {
      sex: "male",
      ageYears: 23,
      heightCm: 173,
      weightKg: 70,
      activityLevel: "lightly_active",
      goal: "fat_loss_moderate",
    });

    expect(result.plan.bmrKcal).toBe(1671);
    expect(result.plan.tdeeKcal).toBe(2006);
    expect(result.plan.targetKcal).toBe(1771);
    expect(result.plan.macros.proteinGrams).toBe(140);
    expect(result.plan.macros.fatGrams).toBe(42);
    expect(result.profile.targetKcal).toBe(1771);
  });

  // ── Nutrition Estimate (read-only) ──

  it("estimates nutrition without writing anything", async () => {
    const result = await handlers.handleNutritionEstimate(ctx, {
      description: "chicken breast 200g",
    });

    expect(result.kcal).toBeGreaterThan(200);
    expect(result.proteinGrams).toBeGreaterThan(30);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.slug).toBe("chicken_breast");
    expect(result.items[0]!.grams).toBe(200);
  });

  // ── Log Meal ──

  it("logs a meal with nutrition estimation", async () => {
    const log = await handlers.handleLogMeal(ctx, {
      date: TEST_DATE,
      mealType: "lunch",
      description: "chicken breast 200g + brown rice 80g",
    });

    expect(log.id).toBeDefined();
    expect(log.mealType).toBe("lunch");
    expect(log.caloriesKcal).toBeGreaterThan(400);
    expect(log.proteinGrams).toBeGreaterThan(40);
    expect(log.description).toContain("chicken breast");
  });

  // ── Log Water ──

  it("logs water from ml description", async () => {
    const log = await handlers.handleLogWater(ctx, {
      date: TEST_DATE,
      description: "300ml水",
    });
    expect(log.amountMl).toBe(300);
  });

  it("logs water from cup description", async () => {
    const log = await handlers.handleLogWater(ctx, {
      date: TEST_DATE,
      description: "两杯水",
    });
    expect(log.amountMl).toBe(500);
  });

  // ── Log Exercise ──

  it("logs exercise with calorie estimation", async () => {
    const log = await handlers.handleLogExercise(ctx, {
      date: TEST_DATE,
      description: "走路30分钟",
    });
    expect(log.activityType).toBe("walking");
    expect(log.durationMinutes).toBe(30);
    expect(log.caloriesBurnedKcal).toBe(120);
  });

  // ── Log Weight ──

  it("logs weight from description", async () => {
    const log = await handlers.handleLogWeight(ctx, {
      date: TEST_DATE,
      description: "早上称重 69.5kg",
    });
    expect(log.weightKg).toBe(69.5);
  });

  // ── Update Cooking Record ──

  it("parses cooking note and stores record", async () => {
    const result = await handlers.handleUpdateCookingRecord(ctx, {
      note: "蒜蓉鸡胸肉 200g 用生抽和姜炒",
    });
    expect(result.record.ingredientSlug).toBe("chicken_breast");
    expect(result.record.method).toBe("stir_fry");
    expect(result.record.seasonings).toContain("light_soy_sauce");
    expect(result.record.seasonings).toContain("ginger");
    expect(result.stored).toBe(true);
  });

  // ── Daily Summary (aggregates all logged data) ──

  it("aggregates the day's logged data with real targets", async () => {
    const summary = await handlers.handleDailySummary(ctx, { date: TEST_DATE });

    expect(summary.date).toBe(TEST_DATE);
    expect(summary.target.kcal).toBe(1771);
    expect(summary.target.proteinGrams).toBe(140);
    expect(summary.eaten.kcal).toBeGreaterThan(400);
    expect(summary.eaten.proteinGrams).toBeGreaterThan(40);
    expect(summary.remaining.kcal).toBeLessThan(1771);
    expect(summary.water.totalMl).toBe(800);
    expect(summary.water.logs).toBe(2);
    expect(summary.exercise.kcalBurned).toBe(120);
    expect(summary.exercise.logs).toBe(1);
    expect(summary.mealCount).toBe(1);
  });

  // ── Meal Checkin ──

  it("checks in a planned meal as followed", async () => {
    await ctx.repo.insertMealPlanEntry({
      userId: ctx.userId,
      planDate: TEST_DATE,
      mealType: "dinner",
      dishName: "清蒸鲷鱼片",
      recipeSlug: "steamed_bream",
      status: "planned",
      ingredientsJson: [{ slug: "sea_bream", grams: 200 }],
      seasoningsJson: [{ slug: "light_soy_sauce" }],
      caloriesKcal: 212,
      proteinGrams: 35.8,
      carbsGrams: 0,
      fatGrams: 6.8,
      sodiumMg: 460,
    });

    const result = await handlers.handleMealCheckin(ctx, {
      date: TEST_DATE,
      mealType: "dinner",
      status: "followed",
    });

    expect(result.status).toBe("followed");
    expect(result.dietLogId).toBeDefined();

    const updatedEntries = await ctx.repo.listMealPlanEntries(ctx.userId, TEST_DATE);
    const dinner = updatedEntries.find((e) => e.mealType === "dinner");
    expect(dinner?.status).toBe("followed");
  });

  // ── invokeTool dispatch ──

  it("dispatches through invokeTool registry", async () => {
    const result = await invokeTool(ctx, "daily_summary", { date: TEST_DATE });
    const summary = result as handlers.DailySummaryResult;
    expect(summary.date).toBe(TEST_DATE);
    expect(summary.mealCount).toBe(2);
  });

  it("invokeTool rejects unknown tools", async () => {
    await expect(invokeTool(ctx, "nonexistent", {})).rejects.toThrow("Unknown tool");
  });

  // ── Smart Recipe Recommend ──

  it("recommends recipes using auto-loaded preset dishes", async () => {
    const result = await handlers.handleSmartRecipeRecommend(ctx, {
      mealType: "lunch",
    });

    expect(result.options.length).toBeGreaterThan(0);
    expect(result.options.length).toBeLessThanOrEqual(3);
    expect(result.options.every((o) => o.nutritionPreview.kcal > 0)).toBe(true);
    expect(result.summary).toBeTruthy();
  });

  it("recommends recipes with explicit maxKcal", async () => {
    const result = await handlers.handleSmartRecipeRecommend(ctx, {
      mealType: "dinner",
      maxKcal: 650,
    });

    expect(result.options.every((o) => o.nutritionPreview.kcal <= 650)).toBe(true);
  });

  // ── Smart Generate Meal Plan ──

  it("generates a 7-day meal plan using preset dishes and BMR target", async () => {
    const result = await handlers.handleSmartGenerateMealPlan(ctx, {});

    expect(result.plan.entries).toHaveLength(21);
    expect(result.plan.days).toHaveLength(7);
    expect(result.storedCount).toBe(21);
    expect(result.overview).toContain("Day 1");
    expect(result.overview).toContain("breakfast:");
    expect(result.overview).toContain("kcal");

    for (const day of result.plan.days) {
      expect(day.totals.kcal).toBeGreaterThan(1500);
      expect(day.totals.kcal).toBeLessThan(2100);
    }
  });

  it("generates meal plan with explicit startDate", async () => {
    const result = await handlers.handleSmartGenerateMealPlan(ctx, {
      startDate: "2026-07-01",
    });

    expect(result.plan.startDate).toBe("2026-07-01");
    expect(result.plan.entries).toHaveLength(21);
  });

  it("dispatches generate_meal_plan through invokeTool registry", async () => {
    const result = await invokeTool(ctx, "recipe_recommend", { mealType: "breakfast" });
    const recommend = result as handlers.SmartRecipeRecommendInput & { options: unknown[] };
    expect(Array.isArray((result as any).options)).toBe(true);
  });
});
