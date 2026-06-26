import { describe, expect, test } from "vitest";
import { renderTemplate } from "../src/i18n.js";

const chineseCharacters = /[\u3400-\u9fff]/;
const englishWords = /\b(the|your|plan|summary|recommend|error|onboarding)\b/i;

describe("i18n templates", () => {
  test("test_renderTemplate_checkinPrompt_knownLanguage_returnsSelectedLanguageOnly", () => {
    const zh = renderTemplate("zh", "checkinPrompt", {
      mealName: "午餐",
      dishName: "西兰花炒虾仁",
      kcal: 520,
    });
    const en = renderTemplate("en", "checkinPrompt", {
      mealName: "lunch",
      dishName: "shrimp with broccoli",
      kcal: 520,
    });

    expect(zh).toBe("午餐计划是西兰花炒虾仁（预计 520 千卡），你吃了吗？");
    expect(zh).not.toMatch(englishWords);
    expect(en).toBe("Your lunch plan is shrimp with broccoli, about 520 kcal. Did you eat it?");
    expect(en).not.toMatch(chineseCharacters);
  });

  test("test_renderTemplate_summaryWithZeroValues_returnsDeterministicBoundaryText", () => {
    const zh = renderTemplate("zh", "dailySummary", {
      kcal: 0,
      targetKcal: 1800,
      proteinGrams: 0,
      sodiumMg: 0,
    });
    const en = renderTemplate("en", "dailySummary", {
      kcal: 0,
      targetKcal: 1800,
      proteinGrams: 0,
      sodiumMg: 0,
    });

    expect(zh).toBe("今日摄入 0/1800 千卡，蛋白质 0 克，钠 0 毫克。");
    expect(en).toBe("Today you logged 0 of 1800 kcal, 0 g protein, and 0 mg sodium.");
  });

  test("test_renderTemplate_proactiveTemplates_returnLocalizedOutput", () => {
    const zh = renderTemplate("zh", "proactiveMealCheckin", {
      mealType: "午餐",
      dishName: "虾仁西兰花",
      kcal: 520,
      proteinGrams: 35,
    });
    const en = renderTemplate("en", "proactiveMealCheckin", {
      mealType: "lunch",
      dishName: "shrimp with broccoli",
      kcal: 520,
      proteinGrams: 35,
    });

    expect(zh).toMatch(chineseCharacters);
    expect(zh).not.toMatch(/\bMeal check-in\b/);
    expect(en).toBe("Meal check-in: your planned lunch is shrimp with broccoli (520 kcal, 35g protein). Did you follow the plan, substitute, or skip?");
    expect(en).not.toMatch(chineseCharacters);
  });

  test("test_renderTemplate_proactiveThawReminder_keepsIceEmojiInTemplate", () => {
    const zh = renderTemplate("zh", "proactiveThawReminder", {
      items: "明天虾仁",
    });
    const en = renderTemplate("en", "proactiveThawReminder", {
      items: "tomorrow shrimp",
    });

    expect(zh).toMatch(/^🧊 /u);
    expect(zh).toMatch(chineseCharacters);
    expect(en).toBe("🧊 Thaw reminder: tomorrow shrimp - take the meat out of the freezer to thaw in advance.");
  });

  test("test_renderTemplate_unknownTemplate_throwsHelpfulError", () => {
    expect(() =>
      renderTemplate("zh", "missingTemplate" as never, {}),
    ).toThrow("Unknown i18n template: missingTemplate");
  });
});
