import { describe, expect, it } from "vitest";
import { timerNodes } from "./timers";

describe("timers nodes", () => {
  it("exports at least one node definition", () => {
    expect(timerNodes.length).toBeGreaterThan(0);
    expect(timerNodes[0]?.id).toBeTruthy();
    expect(timerNodes[0]?.category).toBeTruthy();
  });
});
