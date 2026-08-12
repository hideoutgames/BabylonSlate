import { describe, expect, it } from "vitest";
import { flowNodes } from "./flow";

describe("flow nodes", () => {
  it("exports at least one node definition", () => {
    expect(flowNodes.length).toBeGreaterThan(0);
    expect(flowNodes[0]?.id).toBeTruthy();
    expect(flowNodes[0]?.category).toBeTruthy();
  });
});
