import { describe, expect, it } from "vitest";
import { resolveNaturalPortion } from "../../src/engine/natural-units.js";
import type { FoodPortionRecord, NaturalUnitRecord } from "../../src/engine/types.js";

const brownRice: FoodPortionRecord = {
  slug: "brown_rice",
  defaultGrams: 150,
  defaultUnit: "碗",
};

const egg: FoodPortionRecord = {
  slug: "egg",
  defaultGrams: 50,
  defaultUnit: "个",
};

const chickenBreast: FoodPortionRecord = {
  slug: "chicken_breast",
  defaultGrams: 200,
  defaultUnit: "块",
};

const unitRecords: NaturalUnitRecord[] = [
  { foodSlug: "brown_rice", unit: "碗", grams: 150 },
  { foodSlug: "egg", unit: "个", grams: 50 },
  { foodSlug: "chicken_breast", unit: "块", grams: 200 },
];

describe("natural unit resolver", () => {
  it("test_resolveNaturalPortion_twoBowlsBrownRice_returnsThreeHundredGrams", () => {
    expect(resolveNaturalPortion("2碗", brownRice, unitRecords)).toMatchObject({
      grams: 300,
      quantity: 2,
      unit: "碗",
      source: "natural_unit",
    });
  });

  it("test_resolveNaturalPortion_nullEgg_returnsDefaultPortion", () => {
    expect(resolveNaturalPortion(null, egg, unitRecords)).toMatchObject({
      grams: 50,
      quantity: 1,
      unit: "个",
      source: "default_portion",
    });
  });

  it("test_resolveNaturalPortion_bareGrams_returnsExactGrams", () => {
    expect(resolveNaturalPortion("200g", brownRice, unitRecords)).toMatchObject({
      grams: 200,
      quantity: 200,
      unit: "g",
      source: "grams",
    });
  });

  it("test_resolveNaturalPortion_countAndUnit_returnsMatchedUnitWeight", () => {
    expect(resolveNaturalPortion("1块", chickenBreast, unitRecords)).toMatchObject({
      grams: 200,
      quantity: 1,
      unit: "块",
      source: "natural_unit",
    });
  });

  it("test_resolveNaturalPortion_decimalCount_returnsScaledUnitWeight", () => {
    expect(resolveNaturalPortion("1.5碗", brownRice, unitRecords)).toMatchObject({
      grams: 225,
      quantity: 1.5,
      unit: "碗",
    });
  });

  it("test_resolveNaturalPortion_unknownUnit_throwsRangeError", () => {
    expect(() => resolveNaturalPortion("2盘", brownRice, unitRecords)).toThrow(RangeError);
  });
});
