import { describe, expect, it } from "vitest";
import { arrayMapNodes } from "./array-map";

describe("array-map nodes", () => {
  it("exports at least one node definition", () => {
    expect(arrayMapNodes.length).toBeGreaterThan(0);
    expect(arrayMapNodes[0]?.id).toBeTruthy();
    expect(arrayMapNodes[0]?.category).toBeTruthy();
  });

  it("registers Make Array plus set/insert/remove/find/clear", () => {
    expect(arrayMapNodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "array.get",
        "array.append",
        "array.make",
        "array.set",
        "array.insert",
        "array.removeIndex",
        "array.find",
        "array.clear",
      ]),
    );
    expect(arrayMapNodes.find((node) => node.id === "array.make")?.title).toBe(
      "Make Array",
    );
  });
});
