const QUANTITY_PATTERN = String.raw`(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十半]+)`;
const COUNT_UNIT_PATTERN = String.raw`(?:个|只|颗|枚|碗|杯|份|片|根|把|棵|勺|汤匙|茶匙|pieces?|piece|bowls?|bowl|cups?|cup|servings?|serving)`;

const GRAMS = new RegExp(`(${QUANTITY_PATTERN})\\s*(?:g|grams?|克)`, "i");
const MILLILITERS = new RegExp(`(${QUANTITY_PATTERN})\\s*(?:ml|milliliters?|毫升)`, "i");
const COUNTED = new RegExp(`(${QUANTITY_PATTERN})\\s*(${COUNT_UNIT_PATTERN})`, "i");
const LEADING_PORTION = new RegExp(
  `^\\s*${QUANTITY_PATTERN}\\s*(?:g|grams?|克|ml|milliliters?|毫升|${COUNT_UNIT_PATTERN})?\\s*`,
  "i",
);

/** Remove a leading amount so food matching compares the food words themselves. */
export function stripLeadingPortion(value: string): string {
  return value.replace(LEADING_PORTION, "");
}

/** Return one normalized explicit portion from free text, preserving counts and volume. */
export function extractExplicitPortion(value: string): string | null {
  const grams = value.match(GRAMS);
  if (grams?.[1]) return `${parseQuantity(grams[1])}g`;

  const milliliters = value.match(MILLILITERS);
  if (milliliters?.[1]) return `${parseQuantity(milliliters[1])}ml`;

  const counted = value.match(COUNTED);
  if (counted?.[1] && counted[2]) {
    return `${parseQuantity(counted[1])}${counted[2].toLocaleLowerCase()}`;
  }
  return null;
}

function parseQuantity(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  if (value === "半") return 0.5;

  const digits: Readonly<Record<string, number>> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[value[tenIndex - 1] ?? ""];
    const ones = tenIndex === value.length - 1 ? 0 : digits[value[tenIndex + 1] ?? ""];
    if (tens !== undefined && ones !== undefined) return tens * 10 + ones;
  }
  if (value.length === 1 && digits[value] !== undefined && digits[value]! > 0) {
    return digits[value]!;
  }
  throw new RangeError(`Unsupported quantity: ${value}`);
}
