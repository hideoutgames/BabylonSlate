import { describe, expect, it } from "vitest";
import { componentNodes } from "./component";

describe("component nodes", () => {
  it("exports at least one node definition", () => {
    expect(componentNodes.length).toBeGreaterThan(0);
    expect(componentNodes[0]?.id).toBeTruthy();
    expect(componentNodes[0]?.category).toBeTruthy();
  });
});
