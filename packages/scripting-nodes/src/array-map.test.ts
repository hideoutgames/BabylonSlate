import { describe, expect, it } from "vitest";
import { arrayMapNodes } from "./array-map";

describe("array-map nodes", () => {
  it("exports at least one node definition", () => {
    expect(arrayMapNodes.length).toBeGreaterThan(0);
    expect(arrayMapNodes[0]?.id).toBeTruthy();
    expect(arrayMapNodes[0]?.category).toBeTruthy();
  });
});
