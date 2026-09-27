import { describe, expect, it } from "vitest";
import type { StructuredFlowMeta } from "./structured-flow";

describe("structured flow switch metadata", () => {
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
