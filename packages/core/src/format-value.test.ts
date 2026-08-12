import { describe, expect, it } from "vitest";
import { formatValue } from "./format-value";

describe("formatValue", () => {
  it("formats primitives", () => {
    expect(formatValue(null)).toBe("null");
    expect(formatValue(undefined)).toBe("undefined");
    expect(formatValue(true)).toBe("true");
    expect(formatValue(42)).toBe("42");
    expect(formatValue("hi")).toBe("hi");
  });

  it("formats arrays and maps deterministically", () => {
    expect(formatValue([1, "a", false])).toBe("[1, a, false]");
    expect(formatValue(new Map([["b", 2], ["a", 1]]))).toBe("{b: 2, a: 1}");
  });

  it("formats object refs as ClassName(guid)", () => {
    expect(
      formatValue({ guid: "g1", className: "Player" }),
    ).toBe("Player(g1)");
    expect(
      formatValue(
        { guid: "g2" },
        { classNameByGuid: new Map([["g2", "Enemy"]]) },
      ),
    ).toBe("Enemy(g2)");
  });

  it("formats structs with sorted keys", () => {
    expect(formatValue({ z: 1, a: 2 })).toBe("{a: 2, z: 1}");
  });

  it("formats boxed wildcards", () => {
    expect(formatValue({ tag: "int", value: 3 })).toBe("Wildcard(int, 3)");
  });

  it("golden: nested containers", () => {
    expect(
      formatValue({
        items: [{ guid: "a", classId: "Actor" }, 1],
        meta: { b: true, a: "x" },
      }),
    ).toBe("{items: [Actor(a), 1], meta: {a: x, b: true}}");
  });
});
