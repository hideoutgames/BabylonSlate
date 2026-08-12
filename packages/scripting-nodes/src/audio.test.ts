import { describe, expect, it } from "vitest";
import { audioNodes } from "./audio";

describe("audio nodes", () => {
  it("exports at least one node definition", () => {
    expect(audioNodes.length).toBeGreaterThan(0);
    expect(audioNodes[0]?.id).toBeTruthy();
    expect(audioNodes[0]?.category).toBeTruthy();
  });
});
