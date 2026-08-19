import { describe, expect, it } from "vitest";
import {
  isFlowSwitchKind,
  type StructuredFlowMeta,
} from "./structured-flow";

describe("structured flow switch metadata", () => {
  it("recognizes Switch on Int / Switch on String kinds", () => {
    expect(isFlowSwitchKind("switchOnInt")).toBe(true);
    expect(isFlowSwitchKind("switchOnString")).toBe(true);
    expect(isFlowSwitchKind("branch")).toBe(false);
    expect(isFlowSwitchKind(undefined)).toBe(false);
  });

  it("shapes switch metadata with value and default pin ids", () => {
    const intMeta: StructuredFlowMeta = {
      kind: "switchOnInt",
      valuePin: "value",
      defaultPin: "default",
    };
    const stringMeta: StructuredFlowMeta = {
      kind: "switchOnString",
      valuePin: "value",
      defaultPin: "default",
    };
    expect(intMeta.kind).toBe("switchOnInt");
    expect(stringMeta.defaultPin).toBe("default");
  });
});
