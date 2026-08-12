import { describe, expect, it } from "vitest";
import { physicsNodes } from "./physics";

describe("physics nodes", () => {
  it("exports at least one node definition", () => {
    expect(physicsNodes.length).toBeGreaterThan(0);
    expect(physicsNodes[0]?.id).toBeTruthy();
    expect(physicsNodes[0]?.category).toBeTruthy();
  });
});
