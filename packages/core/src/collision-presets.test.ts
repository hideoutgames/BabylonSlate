import { describe, expect, it } from "vitest";
import {
  newCollisionPresetId,
  normalizeCollisionPresets,
  resolveCollisionFilter,
} from "./collision-presets";

const presets = [{ id: "ghost-pass", name: "Ghost Pass", layer: 2, mask: 0xffffffef }];

describe("Collision Presets", () => {
  it("keeps one Default preset when none are authored and drops duplicate or reserved ids", () => {
    expect(normalizeCollisionPresets(undefined)).toEqual([{ id: "default", name: "Default", layer: 1, mask: 0xffffffff }]);
    expect(normalizeCollisionPresets([
      { id: "a", name: "A", layer: 4, mask: -1 },
      { id: "a", name: "Again" },
      { id: "custom", name: "Reserved" },
    ])).toEqual([{ id: "a", name: "A", layer: 4, mask: 0xffffffff }]);
  });

  it("uses the preset's layer and mask, and the collider's own for Custom or a removed preset", () => {
    expect(resolveCollisionFilter(1, 4, "ghost-pass", presets)).toEqual({ layer: 2, mask: 0xffffffef });
    expect(resolveCollisionFilter(1, 4, "custom", presets)).toEqual({ layer: 1, mask: 4 });
    expect(resolveCollisionFilter(1, 4, undefined, presets)).toEqual({ layer: 1, mask: 4 });
    expect(resolveCollisionFilter(1, 4, "removed", presets)).toEqual({ layer: 1, mask: 4 });
  });

  it("derives an unused id from a new preset's name", () => {
    expect(newCollisionPresetId("Ghost Pass", presets)).toBe("ghost-pass-2");
    expect(newCollisionPresetId("Custom", presets)).toBe("custom-preset");
  });
});
