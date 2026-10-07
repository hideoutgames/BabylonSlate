import { describe, expect, it } from "vitest";
import { normalizePostProcessStack } from "./post-process-material";

describe("post-process stack", () => {
  it("normalizes authored entries: sorts by order, defaults enabled, drops entries without a material guid", () => {
    const stack = normalizePostProcessStack([
      { id: "second", materialGuid: "b", order: 2, scalable: true },
      { enabled: true },
      null,
      4,
      { id: "first", materialGuid: "a", order: 1 },
    ]);
    expect(stack.map((entry) => entry.materialGuid)).toEqual(["a", "b"]);
    expect(stack.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(stack.map((entry) => entry.enabled)).toEqual([true, true]);
    expect(stack[1]!.scalable).toBe(true);
  });
});
