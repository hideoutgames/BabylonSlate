import { describe, expect, it } from "vitest";
import { HeldFrameReasons } from "./held-frames";

describe("HeldFrameReasons", () => {
  it("counts each reason under its own key, up to seven, and later reasons under other", () => {
    const reasons = new HeldFrameReasons();
    for (const reason of ["a", "b", "a", "c", "d", "e", "f", "g", "h", "i", "h", "a"]) reasons.count(reason);
    expect(reasons.snapshot()).toEqual({ a: 3, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, other: 3 });
  });

  it("keeps a reason named like an object property as its own key", () => {
    const reasons = new HeldFrameReasons();
    reasons.count("constructor");
    reasons.count("constructor");
    expect(reasons.snapshot()).toEqual({ constructor: 2 });
  });

  it("gives a snapshot that later counts do not change", () => {
    const reasons = new HeldFrameReasons();
    reasons.count("Scene is not ready to render.");
    const before = reasons.snapshot();
    reasons.count("Scene is not ready to render.");
    expect(before).toEqual({ "Scene is not ready to render.": 1 });
    expect(reasons.snapshot()).toEqual({ "Scene is not ready to render.": 2 });
  });
});
