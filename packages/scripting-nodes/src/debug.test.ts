import { describe, expect, it } from "vitest";
import { debugNodes } from "./debug";

describe("debug nodes", () => {
  it("exports at least one node definition", () => {
    expect(debugNodes.length).toBeGreaterThan(0);
    expect(debugNodes[0]?.id).toBeTruthy();
    expect(debugNodes[0]?.category).toBeTruthy();
  });
});
