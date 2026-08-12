import { describe, expect, it } from "vitest";
import { castingNodes } from "./casting";

describe("casting nodes", () => {
  it("exports at least one node definition", () => {
    expect(castingNodes.length).toBeGreaterThan(0);
    expect(castingNodes[0]?.id).toBeTruthy();
    expect(castingNodes[0]?.category).toBeTruthy();
  });
});
