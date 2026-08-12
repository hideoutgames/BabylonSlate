import { describe, expect, it } from "vitest";
import { variableNodes } from "./variables";

describe("variables nodes", () => {
  it("exports at least one node definition", () => {
    expect(variableNodes.length).toBeGreaterThan(0);
    expect(variableNodes[0]?.id).toBeTruthy();
    expect(variableNodes[0]?.category).toBeTruthy();
  });
});
