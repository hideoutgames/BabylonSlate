import { describe, expect, it } from "vitest";
import { actorNodes } from "./actor";

describe("actor nodes", () => {
  it("exports at least one node definition", () => {
    expect(actorNodes.length).toBeGreaterThan(0);
    expect(actorNodes[0]?.id).toBeTruthy();
    expect(actorNodes[0]?.category).toBeTruthy();
  });
});
