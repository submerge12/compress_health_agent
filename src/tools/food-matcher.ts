import type { MealCatalog, FoodCatalogRecord } from "./nutrition-estimate.js";

export type FoodMatchType = "exact" | "alias" | "fuzzy";

export interface FoodMatchCandidate {
  food: FoodCatalogRecord;
  label: string;
  score: number;
  matchType: FoodMatchType;
}

interface LabelCandidate {
  label: string;
  normalized: string;
  isAlias: boolean;
}

type FoodSource = MealCatalog | readonly FoodCatalogRecord[];

const LEADING_PORTION_PATTERN =
  /^\s*\d+(?:\.\d+)?\s*(?:g|grams?|servings?|serving|pieces?|piece|bowls?|bowl|cups?|cup|份|个|只|碗|克)?\s*/i;

const TRADITIONAL_TO_SIMPLIFIED: Readonly<Record<string, string>> = {
  雞: "鸡",
  鷄: "鸡",
  鴨: "鸭",
  魚: "鱼",
  蝦: "虾",
  蛋: "蛋",
  飯: "饭",
  麵: "面",
  麪: "面",
  豬: "猪",
  牛: "牛",
  羊: "羊",
  蔥: "葱",
  薑: "姜",
  蒜: "蒜",
  蘭: "兰",
  菜: "菜",
  體: "体",
  臺: "台",
  台: "台",
  蕃: "番",
  茄: "茄",
  炒: "炒",
  紅: "红",
  綠: "绿",
  鹽: "盐",
  醬: "酱",
  湯: "汤",
  餅: "饼",
  糰: "团",
  粥: "粥",
  鮮: "鲜",
  雜: "杂",
  糙: "糙",
};

export function normalize(value: string): string {
  const mapped = Array.from(value.normalize("NFKC").toLocaleLowerCase())
    .map((char) => TRADITIONAL_TO_SIMPLIFIED[char] ?? char)
    .join("")
    .replace(/[\p{P}\p{S}\s_]+/gu, "");

  return mapped
    .replace(/西红柿/g, "番茄")
    .replace(/鸡蛋/g, "蛋");
}

export function matchFood(segment: string, source: FoodSource): FoodMatchCandidate | undefined {
  return rankFoodCandidates(segment, source, 1)[0];
}

export function rankFoodCandidates(
  segment: string,
  source: FoodSource,
  limit = 5,
): FoodMatchCandidate[] {
  const segmentForms = normalizedSegmentForms(segment);
  if (segmentForms.length === 0) return [];

  const bySlug = new Map<string, FoodMatchCandidate>();
  for (const food of foodsFrom(source)) {
    for (const label of labelsFor(food)) {
      const scored = scoreLabel(segmentForms, label);
      if (scored.score <= 0) continue;

      const candidate: FoodMatchCandidate = {
        food,
        label: label.label,
        score: roundScore(scored.score),
        matchType: scored.matchType,
      };
      const existing = bySlug.get(food.slug);
      if (existing === undefined || compareCandidates(candidate, existing) < 0) {
        bySlug.set(food.slug, candidate);
      }
    }
  }

  return [...bySlug.values()]
    .sort(compareCandidates)
    .slice(0, Math.max(0, limit));
}

function foodsFrom(source: FoodSource): readonly FoodCatalogRecord[] {
  return "foods" in source ? source.foods : source;
}

function labelsFor(food: FoodCatalogRecord): LabelCandidate[] {
  const labels: LabelCandidate[] = [];
  addLabel(labels, food.name, false);
  addLabel(labels, food.nameZh, false);
  addLabel(labels, food.slug.replace(/_/g, " "), false);
  addLabel(labels, food.slug, false);
  for (const alias of food.aliases ?? []) {
    addLabel(labels, alias, true);
  }
  return labels.sort((left, right) => right.normalized.length - left.normalized.length);
}

function addLabel(labels: LabelCandidate[], value: string | null | undefined, isAlias: boolean): void {
  const label = value?.trim();
  if (!label) return;
  const normalized = normalize(label);
  if (!normalized) return;
  if (labels.some((existing) => existing.normalized === normalized)) return;
  labels.push({ label, normalized, isAlias });
}

function normalizedSegmentForms(segment: string): string[] {
  const forms = [
    normalize(segment),
    normalize(segment.replace(LEADING_PORTION_PATTERN, "")),
  ];
  return [...new Set(forms.filter(Boolean))];
}

function scoreLabel(
  segmentForms: readonly string[],
  label: LabelCandidate,
): Pick<FoodMatchCandidate, "score" | "matchType"> {
  let bestScore = 0;
  let bestType: FoodMatchType = "fuzzy";

  for (const form of segmentForms) {
    if (form.includes(label.normalized)) {
      const exactScore = label.isAlias ? 0.95 : 1;
      if (exactScore > bestScore) {
        bestScore = exactScore;
        bestType = label.isAlias ? "alias" : "exact";
      }
      continue;
    }

    const fuzzyScore = trigramJaccard(form, label.normalized);
    if (fuzzyScore > bestScore) {
      bestScore = fuzzyScore;
      bestType = "fuzzy";
    }
  }

  return { score: bestScore, matchType: bestType };
}

function trigramJaccard(left: string, right: string): number {
  const leftSet = ngrams(left);
  const rightSet = ngrams(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;

  let intersection = 0;
  for (const gram of leftSet) {
    if (rightSet.has(gram)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function ngrams(value: string): Set<string> {
  if (value.length === 0) return new Set();
  if (value.length <= 3) return new Set([value]);

  const grams = new Set<string>();
  for (let index = 0; index <= value.length - 3; index += 1) {
    grams.add(value.slice(index, index + 3));
  }
  return grams;
}

function compareCandidates(left: FoodMatchCandidate, right: FoodMatchCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  const typeOrder = typeRank(right.matchType) - typeRank(left.matchType);
  if (typeOrder !== 0) return typeOrder;
  return left.food.slug.localeCompare(right.food.slug);
}

function typeRank(type: FoodMatchType): number {
  if (type === "exact") return 3;
  if (type === "alias") return 2;
  return 1;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
