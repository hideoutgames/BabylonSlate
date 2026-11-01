import { describe, expect, it } from "vitest";
import { meetsBreakpointCondition } from "./script-breakpoints";

describe("breakpoint conditions", () => {
  // Is Valid and Is Not Valid agree with the Is Valid node: a destroyed object is not valid.
  it.each([
    ["an object", { classId: "Door" }, true],
    ["an empty reference", null, false],
    ["a destroyed object", { classId: "Door", destroyed: true }, false],
  ])("Is Valid on %s", (_label, value, valid) => {
    expect(meetsBreakpointCondition({ pinId: "p", direction: "in", op: "isValid" }, value)).toBe(valid);
    expect(meetsBreakpointCondition({ pinId: "p", direction: "in", op: "isNotValid" }, value)).toBe(!valid);
  });
});
