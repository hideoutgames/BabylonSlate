import { describe, expect, it } from "vitest";
import { uiNodes } from "./ui";

describe("ui nodes", () => {
  it("exports at least one node definition", () => {
    expect(uiNodes.length).toBeGreaterThan(0);
    expect(uiNodes[0]?.id).toBeTruthy();
    expect(uiNodes[0]?.category).toBeTruthy();
  });
});
