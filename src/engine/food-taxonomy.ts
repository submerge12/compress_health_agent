export type FoodWeightType = "raw" | "cooked" | "dry";

const FISH_SLUGS = new Set(["salmon", "cod", "mackerel", "sardine", "hairtail", "sea_bream"]);
const SHRIMP_SLUGS = new Set(["shrimp_jiweixia", "dried_shrimp", "shrimp_paste"]);
const SOY_SLUGS = new Set(["tofu", "soy_milk", "soybean", "edamame"]);
const FISH_CATEGORY_CODES = new Set(["121"]);
const SHELLFISH_CATEGORY_CODES = new Set(["122", "123", "124", "129"]);
const DAIRY_CATEGORY_CODES = new Set(["101", "102", "103", "104", "105", "109", "164"]);
const SOY_CATEGORY_CODES = new Set(["031"]);
const NUT_CATEGORY_CODES = new Set(["071"]);
const FISH_KEYWORDS = [
  "\u9c7c",
  "\u5e26\u9c7c",
  "\u9cb7",
  "\u9cd5",
  "\u9c95",
  "\u9cc8",
];
const SHELLFISH_KEYWORDS = [
  "\u867e",
  "\u87f9",
  "\u8d1d",
  "\u9c8d",
  "\u86ce",
  "\u868c",
  "\u7ae0\u9c7c",
  "\u8f6f\u4f53",
];
const DAIRY_KEYWORDS = [
  "\u4e73",
  "\u5976",
  "\u725b\u5976",
  "\u9178\u5976",
  "\u5976\u916a",
  "\u829d\u58eb",
];
const SOY_KEYWORDS = [
  "\u5927\u8c46",
  "\u9ec4\u8c46",
  "\u8c46\u8150",
  "\u8c46\u6d46",
  "\u8150\u7af9",
];
const NUT_KEYWORDS = [
  "\u575a\u679c",
  "\u6811\u575a\u679c",
  "\u679c\u4ec1",
  "\u674f\u4ec1",
  "\u8170\u679c",
  "\u6838\u6843",
];
const DRY_WEIGHT_SLUGS = new Set([
  "oats",
  "brown_rice",
  "glass_noodles",
  "nori_dried",
  "dried_shrimp",
  "red_bean",
  "mung_bean",
  "black_bean",
]);
const COOKED_WEIGHT_SLUGS = new Set(["steamed_bun", "quinoa_ciabatta"]);

const SEASONING_ALLERGEN_TAGS = new Map<string, readonly string[]>([
  ["light_soy_sauce", ["soy"]],
  ["dark_soy_sauce", ["soy"]],
  ["soy_sauce", ["soy"]],
  ["oyster_sauce", ["seafood", "shellfish"]],
  ["fish_sauce", ["seafood", "fish"]],
  ["shrimp_paste", ["seafood", "shellfish", "shrimp"]],
  ["dried_shrimp", ["seafood", "shellfish", "shrimp"]],
]);

const HIDDEN_ALLERGEN_SEASONINGS = new Set(["oyster_sauce", "fish_sauce", "shrimp_paste", "dried_shrimp"]);

export function allergenTagsForFood(
  slug: string,
  category: string | null | undefined,
  label?: string | null | undefined,
): string[] {
  const normalizedSlug = normalizeToken(slug);
  const normalizedCategory = normalizeToken(category ?? "");
  const normalizedLabel = normalizeToken(label ?? "");
  const signal = [normalizedSlug, normalizedCategory, normalizedLabel].filter(Boolean).join("_");
  const tags = new Set<string>();

  if (
    normalizedCategory === "seafood" ||
    FISH_SLUGS.has(normalizedSlug) ||
    SHRIMP_SLUGS.has(normalizedSlug) ||
    FISH_CATEGORY_CODES.has(normalizedCategory) ||
    SHELLFISH_CATEGORY_CODES.has(normalizedCategory) ||
    includesAny(signal, FISH_KEYWORDS) ||
    includesAny(signal, SHELLFISH_KEYWORDS)
  ) {
    tags.add("seafood");
  }
  if (
    FISH_SLUGS.has(normalizedSlug) ||
    FISH_CATEGORY_CODES.has(normalizedCategory) ||
    includesAny(signal, FISH_KEYWORDS)
  ) {
    tags.add("fish");
  }
  if (
    SHRIMP_SLUGS.has(normalizedSlug) ||
    SHELLFISH_CATEGORY_CODES.has(normalizedCategory) ||
    includesAny(signal, SHELLFISH_KEYWORDS)
  ) {
    tags.add("shellfish");
  }
  if (SHRIMP_SLUGS.has(normalizedSlug) || includesAny(signal, ["shrimp", "\u867e"])) {
    tags.add("shrimp");
  }
  if (
    SOY_SLUGS.has(normalizedSlug) ||
    normalizedSlug.includes("soy") ||
    SOY_CATEGORY_CODES.has(normalizedCategory) ||
    includesAny(signal, SOY_KEYWORDS)
  ) {
    tags.add("soy");
  }
  if (
    normalizedCategory === "dairy" ||
    DAIRY_CATEGORY_CODES.has(normalizedCategory) ||
    includesAny(signal, DAIRY_KEYWORDS)
  ) {
    tags.add("dairy");
  }
  if (
    normalizedCategory === "nut" ||
    NUT_CATEGORY_CODES.has(normalizedCategory) ||
    includesAny(signal, NUT_KEYWORDS)
  ) {
    tags.add("nuts");
  }

  return sorted(tags);
}

export function allergenTagsForSeasoning(slug: string): string[] {
  return [...(SEASONING_ALLERGEN_TAGS.get(normalizeToken(slug)) ?? [])].sort();
}

export function specialHandlingTagsForFood(slug: string, _category: string | null | undefined): string[] {
  const normalizedSlug = normalizeToken(slug);
  if (normalizedSlug === "konjac") {
    return ["filler", "not_vegetable"];
  }
  if (normalizedSlug === "dried_shrimp") {
    return ["seasoning", "high_sodium", "seasoning_not_main_protein"];
  }
  if (normalizedSlug === "chicken_liver") {
    return ["weekly_frequency"];
  }
  return [];
}

export function specialHandlingTagsForSeasoning(slug: string): string[] {
  return HIDDEN_ALLERGEN_SEASONINGS.has(normalizeToken(slug)) ? ["hidden_allergen"] : [];
}

export function frequencyHintForFood(slug: string): string | undefined {
  return normalizeToken(slug) === "chicken_liver" ? "weekly" : undefined;
}

export function inferWeightType(slug: string, category: string | null | undefined): FoodWeightType {
  const normalizedSlug = normalizeToken(slug);
  const normalizedCategory = normalizeToken(category ?? "");
  if (
    DRY_WEIGHT_SLUGS.has(normalizedSlug) ||
    normalizedSlug.endsWith("_dried") ||
    normalizedCategory === "starch" ||
    normalizedCategory === "nut" ||
    (normalizedCategory === "legume" && !SOY_SLUGS.has(normalizedSlug))
  ) {
    return "dry";
  }
  if (COOKED_WEIGHT_SLUGS.has(normalizedSlug) || normalizedCategory === "bread") {
    return "cooked";
  }
  return "raw";
}

export function allergenGroupsForText(value: string): string[] {
  const normalized = normalizeToken(value);
  const groups = new Set<string>();
  if (normalized.includes("seafood") || normalized.includes("fish") || normalized.includes("shellfish") ||
    normalized.includes("shrimp") || normalized.includes("\u6d77\u9c9c") || normalized.includes("\u9c7c") ||
    normalized.includes("\u867e")) {
    groups.add("seafood");
  }
  if (normalized.includes("soy") || normalized.includes("tofu") || normalized.includes("\u5927\u8c46") ||
    normalized.includes("\u9ec4\u8c46") || normalized.includes("\u8c46\u8150")) {
    groups.add("soy");
  }
  if (normalized.includes("nut") || normalized.includes("almond") || normalized.includes("walnut") ||
    normalized.includes("cashew") || normalized.includes("pistachio") || normalized.includes("\u575a\u679c")) {
    groups.add("nuts");
  }
  if (normalized.includes("dairy") || normalized.includes("milk") || normalized.includes("lactose") ||
    normalized.includes("yogurt") || normalized.includes("\u4e73\u7cd6") || normalized.includes("\u725b\u5976") ||
    normalized.includes("\u5976")) {
    groups.add("dairy");
  }
  return sorted(groups);
}

export function allergenGroupsForMemorySubject(value: string): string[] {
  const normalized = normalizeToken(value);
  const groups = new Set<string>();
  if (isAnyOf(normalized, ["seafood", "shellfish", "fish", "shrimp"]) ||
    includesAny(normalized, ["seafood_allergy", "shellfish_allergy", "fish_allergy", "shrimp_allergy"]) ||
    isAnyOf(normalized, ["\u6d77\u9c9c", "\u9c7c", "\u867e"])) {
    groups.add("seafood");
  }
  if (isAnyOf(normalized, ["soy", "soybean"]) ||
    includesAny(normalized, ["soy_allergy", "soybean_allergy"])) {
    groups.add("soy");
  }
  if (isAnyOf(normalized, ["nut", "nuts"]) ||
    includesAny(normalized, ["nut_allergy", "nuts_allergy"]) ||
    isAnyOf(normalized, ["\u575a\u679c"])) {
    groups.add("nuts");
  }
  if (isAnyOf(normalized, ["dairy", "milk", "lactose"]) ||
    includesAny(normalized, ["dairy_allergy", "milk_allergy", "lactose_intolerance"]) ||
    isAnyOf(normalized, ["\u4e73\u7cd6", "\u725b\u5976"])) {
    groups.add("dairy");
  }
  return sorted(groups);
}

export function expandedAllergenTags(values: readonly string[]): ReadonlySet<string> {
  const tags = new Set<string>();
  for (const value of values) {
    const normalized = normalizeToken(value);
    if (!normalized) continue;
    tags.add(normalized);
    for (const group of allergenGroupsForText(value)) {
      tags.add(group);
      if (group === "seafood") {
        tags.add("fish");
        tags.add("shellfish");
        tags.add("shrimp");
      }
      if (group === "nuts") {
        tags.add("nut");
      }
    }
  }
  return tags;
}

export function normalizeTaxonomyToken(value: string): string {
  return normalizeToken(value);
}

function normalizeToken(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase().replace(/[-\s]+/g, "_");
}

function isAnyOf(value: string, candidates: readonly string[]): boolean {
  return candidates.includes(value);
}

function includesAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort();
}
