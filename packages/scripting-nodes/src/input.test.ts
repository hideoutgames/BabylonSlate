import { describe, expect, it } from "vitest";
import { inputNodes } from "./input";

describe("input nodes", () => {
  it("exports at least one node definition", () => {
    expect(inputNodes.length).toBeGreaterThan(0);
    expect(inputNodes[0]?.id).toBeTruthy();
    expect(inputNodes[0]?.category).toBeTruthy();
  });
});
