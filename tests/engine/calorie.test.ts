import { describe, expect, it } from "vitest";
import {
  calculateBmr,
  calculateCaloriePlan,
  calculateCalorieTarget,
  calculateMacros,
  getActivityMultiplier,
  goalFamily,
  isExerciser,
  proteinBand,
} from "../../src/engine/calorie.js";
import type { ActivityLevel, CalorieProfile } from "../../src/engine/types.js";

describe("calorie engine", () => {
  describe("BMR", () => {
    it("male 23y 173cm 70kg matches Mifflin-St Jeor", () => {
      const bmr = calculateBmr({ sex: "male", ageYears: 23, heightCm: 173, weightKg: 70 });
      expect(bmr).toBeCloseTo(1671.25, 1);
    });

    it("female 40y 165cm 60kg", () => {
      const bmr = calculateBmr({ sex: "female", ageYears: 40, heightCm: 165, weightKg: 60 });
      expect(bmr).toBeCloseTo(1270.25, 1);
    });

    it("throws on zero age", () => {
      expect(() => calculateBmr({ sex: "male", ageYears: 0, heightCm: 175, weightKg: 75 })).toThrow(RangeError);
    });
  });

  describe("activity multipliers", () => {
    it("lightly_active = 1.20", () => {
      expect(getActivityMultiplier("lightly_active")).toBe(1.20);
    });

    it("strength_training = 1.50", () => {
      expect(getActivityMultiplier("strength_training")).toBe(1.50);
    });

    it("unknown throws", () => {
      expect(() => getActivityMultiplier("marathon" as ActivityLevel)).toThrow(RangeError);
    });
  });

  describe("exerciser classification", () => {
    it("lightly_active is NOT exerciser", () => {
      expect(isExerciser("lightly_active")).toBe(false);
    });

    it("moderately_active IS exerciser", () => {
      expect(isExerciser("moderately_active")).toBe(true);
    });
  });

  describe("calorie target with bounds", () => {
    it("fat_loss_moderate lower_overrides_upper when TDEE is low", () => {
      // BMR=1671.25, TDEE=2005.5, lower=1771.25, upper=1505.5 → lower wins
      const { target, status } = calculateCalorieTarget("fat_loss_moderate", 2005.5, 1671.25);
      expect(target).toBeCloseTo(1771.25, 1);
      expect(status).toBe("lower_overrides_upper");
    });

    it("improve_health has no bounds", () => {
      const { target, status } = calculateCalorieTarget("improve_health", 2500, 1700);
      expect(target).toBe(2500);
      expect(status).toBe("on_target");
    });

    it("muscle_gain_slow applies lower bound", () => {
      const { target, status } = calculateCalorieTarget("muscle_gain_slow", 2000, 1500);
      // raw = 2000 * 1.10 = 2200, lower = 2200, upper = 2300 → on_target
      expect(target).toBe(2200);
      expect(status).toBe("on_target");
    });
  });

  describe("protein bands", () => {
    it("fat_loss non-exerciser: 1.4/2.0/2.4", () => {
      expect(proteinBand("fat_loss_moderate", false)).toEqual([1.4, 2.0, 2.4]);
    });

    it("fat_loss exerciser: 1.8/2.4/2.8", () => {
      expect(proteinBand("fat_loss_slow", true)).toEqual([1.8, 2.4, 2.8]);
    });
  });

  describe("goal family", () => {
    it("fat_loss_moderate → fat_loss", () => {
      expect(goalFamily("fat_loss_moderate")).toBe("fat_loss");
    });

    it("muscle_gain_fast → muscle_gain", () => {
      expect(goalFamily("muscle_gain_fast")).toBe("muscle_gain");
    });

    it("body_recomp → body_recomp", () => {
      expect(goalFamily("body_recomp")).toBe("body_recomp");
    });
  });

  describe("full macro distribution", () => {
    it("Holly's profile: 1771 kcal, 70kg, male, 23y, fat_loss_moderate, non-exerciser", () => {
      const { macros, statuses } = calculateMacros(1771, 70, "male", 23, "fat_loss_moderate", false);
      expect(macros.proteinGrams).toBe(140);
      expect(macros.fatGrams).toBe(42);
      expect(macros.carbsGrams).toBeCloseTo(208.3, 0);
      expect(statuses.protein).toBe("appropriate");
      expect(statuses.fat).toBe("appropriate");
      expect(statuses.carbs).toBe("appropriate");
    });
  });

  describe("full calorie plan", () => {
    it("Holly's profile produces correct targets", () => {
      const profile: CalorieProfile = {
        sex: "male",
        ageYears: 23,
        heightCm: 173,
        weightKg: 70,
        activityLevel: "lightly_active",
        goal: "fat_loss_moderate",
      };

      const plan = calculateCaloriePlan(profile);

      expect(plan.bmrKcal).toBe(1671);
      expect(plan.tdeeKcal).toBe(2006);
      expect(plan.targetKcal).toBe(1771);
      expect(plan.calorieStatus).toBe("lower_overrides_upper");
      expect(plan.isExerciser).toBe(false);
      expect(plan.macros.proteinGrams).toBe(140);
      expect(plan.macros.fatGrams).toBe(42);
      expect(plan.warnings.length).toBeGreaterThan(0);
    });

    it("zero age throws", () => {
      const profile: CalorieProfile = {
        sex: "male",
        ageYears: 0,
        heightCm: 175,
        weightKg: 75,
        activityLevel: "lightly_active",
        goal: "improve_health",
      };
      expect(() => calculateCaloriePlan(profile)).toThrow(RangeError);
    });
  });
});
