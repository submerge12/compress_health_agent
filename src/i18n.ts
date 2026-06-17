export type Language = "zh" | "en";

export type TemplateKey =
  | "checkinPrompt"
  | "dailySummary"
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
