import { describe, expect, it } from "vitest";
import { transformNodes } from "./transform";

describe("transform nodes", () => {
  it("exports at least one node definition", () => {
    expect(transformNodes.length).toBeGreaterThan(0);
    expect(transformNodes[0]?.id).toBeTruthy();
    expect(transformNodes[0]?.category).toBeTruthy();
  });
});
