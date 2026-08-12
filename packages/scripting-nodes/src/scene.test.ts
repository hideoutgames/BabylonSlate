import { describe, expect, it } from "vitest";
import { sceneNodes } from "./scene";

describe("scene nodes", () => {
  it("exports at least one node definition", () => {
    expect(sceneNodes.length).toBeGreaterThan(0);
    expect(sceneNodes[0]?.id).toBeTruthy();
    expect(sceneNodes[0]?.category).toBeTruthy();
  });
});
