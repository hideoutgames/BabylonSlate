import { describe, expect, it } from "vitest";
import { physicsNodes } from "./physics";

describe("physics nodes", () => {
  it("exports at least one node definition", () => {
    expect(physicsNodes.length).toBeGreaterThanOrEqual(4);
    expect(physicsNodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        "physics.lineTrace",
        "physics.sphereOverlap",
        "physics.shapeSweep",
        "physics.addImpulse",
      ]),
    );
  });
});
