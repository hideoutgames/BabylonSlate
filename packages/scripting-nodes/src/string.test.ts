import { describe, expect, it } from "vitest";
import { stringNodes } from "./string";

describe("string nodes", () => {
  it("exports at least one node definition", () => {
    expect(stringNodes.length).toBeGreaterThan(0);
    expect(stringNodes[0]?.id).toBeTruthy();
    expect(stringNodes[0]?.category).toBeTruthy();
  });
});
