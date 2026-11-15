import { describe, expect, it } from "vitest";
import { parseAnimationTickMode } from "./animation-tick-mode";

describe("parseAnimationTickMode", () => {
  it("reads an id, a label or a member index, and falls back to Always", () => {
    expect(parseAnimationTickMode("whenVisible")).toBe("whenVisible");
    expect(parseAnimationTickMode("Never")).toBe("never");
    expect(parseAnimationTickMode(1)).toBe("whenVisible");
    expect(parseAnimationTickMode(undefined)).toBe("always");
    expect(parseAnimationTickMode("sometimes")).toBe("always");
    expect(parseAnimationTickMode(7)).toBe("always");
  });
});
