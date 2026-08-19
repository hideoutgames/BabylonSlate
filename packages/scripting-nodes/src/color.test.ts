import { describe, expect, it } from "vitest";
import {
  ALL_NODE_CATEGORIES,
  colorNodes,
  createDefaultNodeRegistry,
} from "./index";

describe("color nodes", () => {
  it("registers Lerp, Multiply, and Nearly Equal under color", () => {
    expect(ALL_NODE_CATEGORIES).toContain("color");
    expect(colorNodes.map((entry) => entry.id)).toEqual([
      "color.lerp",
      "color.multiply",
      "color.nearlyEqual",
    ]);
    expect(colorNodes.every((entry) => entry.category === "color")).toBe(true);
    const registry = createDefaultNodeRegistry();
    expect(registry.get("struct.makeColor")?.category).toBe("color");
    expect(registry.get("struct.breakColor")?.category).toBe("color");
    expect(registry.get("color.lerp")?.title).toBe("Lerp Color");
  });
});
