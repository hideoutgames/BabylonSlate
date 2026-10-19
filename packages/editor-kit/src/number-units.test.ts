import { describe, expect, it } from "vitest";
import { isInlineNumberUnit, stripNumberUnit, withNumberUnit } from "./number-units";

describe("number units", () => {
  it("shows degrees as the degree sign, symbols tight and words spaced", () => {
    expect(withNumberUnit("45", "deg")).toBe("45°");
    expect(withNumberUnit("90", "deg/s")).toBe("90°/s");
    expect(withNumberUnit("50", "%")).toBe("50%");
    expect(withNumberUnit("20", "/s")).toBe("20/s");
    expect(withNumberUnit("120", "ms")).toBe("120 ms");
    expect(withNumberUnit("", "px")).toBe("");
  });

  it("accepts the unit typed in its usual forms but leaves another unit for the parser to reject", () => {
    expect(stripNumberUnit("45°", "deg")).toBe("45");
    expect(stripNumberUnit("45 DEG", "deg")).toBe("45");
    expect(stripNumberUnit("1.5 s", "s")).toBe("1.5");
    expect(stripNumberUnit("120ms", "ms")).toBe("120");
    expect(stripNumberUnit("120px", "ms")).toBe("120px");
  });

  it("keeps long unit phrases out of the field", () => {
    expect(isInlineNumberUnit("m/s²")).toBe(true);
    expect(isInlineNumberUnit("scene units")).toBe(false);
  });
});
