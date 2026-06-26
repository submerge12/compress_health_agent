export type Language = "zh" | "en";

export type TemplateKey =
  | "checkinPrompt"
  | "dailySummary"
  | "proactiveDailySummary"
  | "proactiveMealCheckin"
  | "proactiveMissingPlan"
  | "proactiveThawReminder"
  | "weeklySummary"
  | "recommendation"
  | "errorGeneric"
  | "onboardingWelcome"
  | "onboardingQuestion";

export type TemplateParams = Readonly<Record<string, string | number | undefined>>;

type TemplateRenderer = (params: TemplateParams) => string;

type TemplateCatalog = Record<TemplateKey, Record<Language, TemplateRenderer>>;

const value = (params: TemplateParams, key: string): string => String(params[key] ?? "");

export const templates: TemplateCatalog = {
  checkinPrompt: {
    zh: (params) =>
      `${value(params, "mealName")}计划是${value(params, "dishName")}（预计 ${value(params, "kcal")} 千卡），你吃了吗？`,
    en: (params) =>
      `Your ${value(params, "mealName")} plan is ${value(params, "dishName")}, about ${value(params, "kcal")} kcal. Did you eat it?`,
  },
  dailySummary: {
    zh: (params) =>
      `今日摄入 ${value(params, "kcal")}/${value(params, "targetKcal")} 千卡，蛋白质 ${value(params, "proteinGrams")} 克，钠 ${value(params, "sodiumMg")} 毫克。`,
    en: (params) =>
      `Today you logged ${value(params, "kcal")} of ${value(params, "targetKcal")} kcal, ${value(params, "proteinGrams")} g protein, and ${value(params, "sodiumMg")} mg sodium.`,
  },
  proactiveDailySummary: {
    zh: (params) =>
      `每日总结（${value(params, "date")}）：已摄入 ${value(params, "kcal")} 千卡（目标 ${value(params, "targetKcal")}），剩余 ${value(params, "remainingKcal")} 千卡。饮水 ${value(params, "waterMl")}/${value(params, "targetWaterMl")} ml，运动 ${value(params, "exerciseMinutes")}/${value(params, "targetExerciseMinutes")} 分钟，消耗 ${value(params, "kcalBurned")} 千卡。`,
    en: (params) =>
      `Daily summary for ${value(params, "date")}: ${value(params, "kcal")} kcal eaten (target ${value(params, "targetKcal")}), ${value(params, "remainingKcal")} kcal remaining. Water: ${value(params, "waterMl")}/${value(params, "targetWaterMl")}ml. Exercise: ${value(params, "exerciseMinutes")}/${value(params, "targetExerciseMinutes")} min, ${value(params, "kcalBurned")} kcal burned.`,
  },
  proactiveMealCheckin: {
    zh: (params) =>
      `餐食确认：计划的${value(params, "mealType")}是${value(params, "dishName")}（${value(params, "kcal")} 千卡，蛋白质 ${value(params, "proteinGrams")}g）。你是按计划吃了、替换了，还是跳过了？`,
    en: (params) =>
      `Meal check-in: your planned ${value(params, "mealType")} is ${value(params, "dishName")} (${value(params, "kcal")} kcal, ${value(params, "proteinGrams")}g protein). Did you follow the plan, substitute, or skip?`,
  },
  proactiveMissingPlan: {
    zh: (params) => `没有找到 ${value(params, "date")} 的计划${value(params, "mealType")}。`,
    en: (params) => `No planned ${value(params, "mealType")} for ${value(params, "date")}.`,
  },
  proactiveThawReminder: {
    zh: (params) => `🧊 解冻提醒：${value(params, "items")}。请提前把冷冻食材取出解冻。`,
    en: (params) => `🧊 Thaw reminder: ${value(params, "items")} - take the meat out of the freezer to thaw in advance.`,
  },
  weeklySummary: {
    zh: (params) =>
      `本周平均 ${value(params, "averageKcal")} 千卡，达标率 ${value(params, "adherencePct")}%，钠超标 ${value(params, "sodiumOverLimitDays")} 天。`,
    en: (params) =>
      `This week averaged ${value(params, "averageKcal")} kcal, with ${value(params, "adherencePct")}% adherence and ${value(params, "sodiumOverLimitDays")} sodium over-limit days.`,
  },
  recommendation: {
    zh: (params) => `建议：${value(params, "message")}`,
    en: (params) => `Recommendation: ${value(params, "message")}`,
  },
  errorGeneric: {
    zh: (params) => `无法完成请求：${value(params, "reason")}`,
    en: (params) => `Unable to complete the request: ${value(params, "reason")}`,
  },
  onboardingWelcome: {
    zh: () => "欢迎使用 Compass Health。我们先建立你的基础健康档案。",
    en: () => "Welcome to Compass Health. Let's set up your basic health profile first.",
  },
  onboardingQuestion: {
    zh: (params) => `请告诉我你的${value(params, "field")}。`,
    en: (params) => `Please tell me your ${value(params, "field")}.`,
  },
};

export function renderTemplate(
  language: Language,
  key: TemplateKey,
  params: TemplateParams = {},
): string {
  if (language !== "zh" && language !== "en") {
    throw new Error(`Unsupported language: ${String(language)}`);
  }

  const entry = templates[key];
  if (!entry) {
    throw new Error(`Unknown i18n template: ${String(key)}`);
  }

  return entry[language](params);
}
