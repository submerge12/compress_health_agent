export type CookingMethod = "stir_fry" | "steam" | "boil" | "roast" | "grill" | "raw" | "unknown";

export interface CookingRecord {
  ingredientSlug: string;
  method: CookingMethod;
  seasonings: readonly string[];
  portionG: number;
  notes: string;
  recordedAt?: string;
}

export interface CookingRecordStore {
  insertCookingRecord?: (record: CookingRecord) => unknown;
  cookingRecords?: {
    insert: (record: CookingRecord) => unknown;
  };
}

export interface UpdateCookingRecordInput {
  note: string;
  recordedAt?: string;
  store?: CookingRecordStore;
}

export interface UpdateCookingRecordResult {
  record: CookingRecord;
  stored: boolean;
}

interface KeywordMapping {
  slug: string;
  keywords: readonly string[];
}

const INGREDIENT_KEYWORDS: readonly KeywordMapping[] = [
  { slug: "broccoli", keywords: ["broccoli", "\u897f\u5170\u82b1"] },
  { slug: "chicken_breast", keywords: ["chicken breast", "chicken", "\u9e21\u80f8", "\u9e21\u8089"] },
  { slug: "beef", keywords: ["beef", "\u725b\u8089"] },
  { slug: "tofu", keywords: ["tofu", "\u8c46\u8150"] },
  { slug: "brown_rice", keywords: ["brown rice", "rice", "\u7cd9\u7c73", "\u7c73\u996d"] },
  { slug: "salmon", keywords: ["salmon", "\u4e09\u6587\u9c7c"] },
];

const SEASONING_KEYWORDS: readonly KeywordMapping[] = [
  { slug: "light_soy_sauce", keywords: ["light soy sauce", "soy sauce", "\u751f\u62bd", "\u9171\u6cb9"] },
  { slug: "garlic", keywords: ["garlic", "\u849c"] },
  { slug: "scallion", keywords: ["scallion", "green onion", "\u8471"] },
  { slug: "ginger", keywords: ["ginger", "\u59dc"] },
  { slug: "salt", keywords: ["salt", "\u76d0"] },
];

const METHOD_KEYWORDS: readonly { method: CookingMethod; keywords: readonly string[] }[] = [
  { method: "stir_fry", keywords: ["stir fry", "saute", "pan fry", "\u7092", "\u714e"] },
  { method: "steam", keywords: ["steam", "\u84b8"] },
  { method: "boil", keywords: ["boil", "soup", "\u716e", "\u6c64"] },
  { method: "roast", keywords: ["roast", "bake", "\u70e4"] },
  { method: "grill", keywords: ["grill"] },
  { method: "raw", keywords: ["raw", "salad", "\u51c9\u62cc"] },
];

export function updateCookingRecord(input: UpdateCookingRecordInput): UpdateCookingRecordResult {
  const note = normalizeNote(input.note);
  const ingredientSlug = findFirstSlug(note, INGREDIENT_KEYWORDS);
  if (ingredientSlug === undefined) {
    throw new RangeError("Could not identify an ingredient in the cooking note");
  }
  const record = buildCookingRecord(note, ingredientSlug, input.recordedAt);
  const stored = insertRecord(input.store, record);
  return { record, stored };
}

function buildCookingRecord(note: string, ingredientSlug: string, recordedAt: string | undefined): CookingRecord {
  return {
    ingredientSlug,
    method: inferMethod(note),
    seasonings: findAllSlugs(note, SEASONING_KEYWORDS),
    portionG: inferPortionG(note),
    notes: note,
    ...(recordedAt === undefined ? {} : { recordedAt }),
  };
}

function insertRecord(store: CookingRecordStore | undefined, record: CookingRecord): boolean {
  if (store?.insertCookingRecord !== undefined) {
    store.insertCookingRecord(record);
    return true;
  }
  if (store?.cookingRecords !== undefined) {
    store.cookingRecords.insert(record);
    return true;
  }
  return false;
}

function normalizeNote(note: string): string {
  const normalized = note.trim();
  if (normalized.length === 0) throw new RangeError("Cooking note is required");
  return normalized;
}

function findFirstSlug(note: string, mappings: readonly KeywordMapping[]): string | undefined {
  return mappings.find((mapping) => containsKeyword(note, mapping.keywords))?.slug;
}

function findAllSlugs(note: string, mappings: readonly KeywordMapping[]): readonly string[] {
  return mappings
    .filter((mapping) => containsKeyword(note, mapping.keywords))
    .sort((left, right) => firstKeywordIndex(note, left.keywords) - firstKeywordIndex(note, right.keywords))
    .map((mapping) => mapping.slug);
}

function inferMethod(note: string): CookingMethod {
  return METHOD_KEYWORDS.find((mapping) => containsKeyword(note, mapping.keywords))?.method ?? "unknown";
}

function inferPortionG(note: string): number {
  const match = /(\d+(?:\.\d+)?)\s*(?:(?:grams?|g)\b|\u514b)/i.exec(note);
  if (match === null) return 150;
  const grams = Number(match[1]);
  if (!Number.isFinite(grams) || grams <= 0) throw new RangeError("portion grams must be positive");
  return Math.round(grams);
}

function containsKeyword(note: string, keywords: readonly string[]): boolean {
  const normalized = note.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function firstKeywordIndex(note: string, keywords: readonly string[]): number {
  const normalized = note.toLowerCase();
  const indexes = keywords
    .map((keyword) => normalized.indexOf(keyword.toLowerCase()))
    .filter((index) => index >= 0);
  return Math.min(...indexes);
}
