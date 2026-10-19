import { describe, expect, it } from "vitest";
import { declaredValueUnit } from "./value-units";

describe("declaredValueUnit", () => {
  it("keeps a known unit on number and vector types only", () => {
    expect(declaredValueUnit("float", "deg")).toBe("deg");
    expect(declaredValueUnit("vec3", "%")).toBe("%");
    expect(declaredValueUnit("float", "hours")).toBeUndefined();
    expect(declaredValueUnit("string", "px")).toBeUndefined();
    expect(declaredValueUnit("rotator", "deg")).toBeUndefined();
  });
});
