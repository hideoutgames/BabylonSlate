import { describe, expect, it } from "vitest";
import { vectorNodes } from "./vector";

describe("vector nodes", () => {
  it("exports at least one node definition", () => {
    expect(vectorNodes.length).toBeGreaterThan(0);
    expect(vectorNodes[0]?.id).toBeTruthy();
    expect(vectorNodes[0]?.category).toBeTruthy();
  });
});
