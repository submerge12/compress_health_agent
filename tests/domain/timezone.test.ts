import { describe, expect, it } from "vitest";

import { localDateInTimezone } from "../../src/domain/timezone.js";

describe("canonical user-local date", () => {
  it("formats one instant on each user's calendar day", () => {
    const instant = new Date("2035-04-01T00:30:00.000Z");
    expect(localDateInTimezone("America/Los_Angeles", instant)).toBe("2035-03-31");
    expect(localDateInTimezone("Asia/Shanghai", instant)).toBe("2035-04-01");
  });

  it("rejects an invalid profile timezone instead of falling back silently", () => {
    expect(() => localDateInTimezone("Mars/Olympus_Mons", new Date()))
      .toThrow("invalid IANA timezone");
  });
});
