import { describe, expect, it } from "vitest";
import { mathNodes } from "./math";

describe("math nodes", () => {
  it("exports at least one node definition", () => {
    expect(mathNodes.length).toBeGreaterThan(0);
    expect(mathNodes[0]?.id).toBeTruthy();
    expect(mathNodes[0]?.category).toBeTruthy();
  });
});
