import { describe, expect, it } from "vitest";
import { playInputStampTick } from "./input";

describe("playInputStampTick", () => {
  it("prefers the in-process clock when present", () => {
    expect(playInputStampTick(12, 3)).toBe(12);
  });

  it("uses the last worker tick when the in-process clock is missing", () => {
    expect(playInputStampTick(undefined, 7)).toBe(7);
  });
});
