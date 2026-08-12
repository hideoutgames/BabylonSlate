import { describe, expect, it } from "vitest";
import { interfaceNodes } from "./interface";

describe("interface nodes", () => {
  it("exports at least one node definition", () => {
    expect(interfaceNodes.length).toBeGreaterThan(0);
    expect(interfaceNodes[0]?.id).toBeTruthy();
    expect(interfaceNodes[0]?.category).toBeTruthy();
  });
});
