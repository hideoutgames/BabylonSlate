import { describe, expect, it } from "vitest";
import {
  collisionPairResponse,
  newCollisionPresetId,
  normalizeCollisionPresets,
  resolveCollisionFilter,
  setCollisionResponse,
} from "./collision-presets";

const presets = [{ id: "ghost-pass", name: "Ghost Pass", layer: 2, mask: 0xffffffef, overlapMask: 0x10 }];
const own = { layer: 1, mask: 4, overlapMask: 0 };

describe("Collision Presets", () => {
  it("keeps one Default preset when none are authored and drops duplicate or reserved ids", () => {
    expect(normalizeCollisionPresets(undefined)).toEqual([{ id: "default", name: "Default", layer: 1, mask: 0xffffffff, overlapMask: 0 }]);
    expect(normalizeCollisionPresets([
      { id: "a", name: "A", layer: 4, mask: 1, overlapMask: 3 },
      { id: "a", name: "Again" },
      { id: "custom", name: "Reserved" },
    ])).toEqual([{ id: "a", name: "A", layer: 4, mask: 1, overlapMask: 2 }]);
  });

  it("uses the preset's filter, Default without one, and the collider's own for Custom or a removed preset", () => {
    expect(resolveCollisionFilter(own, "ghost-pass", presets)).toEqual({ layer: 2, mask: 0xffffffef, overlapMask: 0x10 });
    expect(resolveCollisionFilter(own, undefined, normalizeCollisionPresets(undefined))).toEqual({ layer: 1, mask: 0xffffffff, overlapMask: 0 });
    expect(resolveCollisionFilter(own, "custom", presets)).toEqual(own);
    expect(resolveCollisionFilter(own, "removed", presets)).toEqual(own);
  });

  it("gives a pair the weaker of its two responses", () => {
    const blocker = { layer: 1, mask: 0xffffffff, overlapMask: 0 };
    const ghost = { layer: 2, mask: 0, overlapMask: 1 };
    const ignorer = { layer: 4, mask: 0, overlapMask: 0 };
    expect(collisionPairResponse(blocker, blocker)).toBe("block");
    expect(collisionPairResponse(blocker, ghost)).toBe("overlap");
    expect(collisionPairResponse(ghost, blocker)).toBe("overlap");
    expect(collisionPairResponse(blocker, ignorer)).toBe("ignore");
    expect(collisionPairResponse(ghost, ghost)).toBe("ignore");
  });

  it("moves a layer between Block, Overlap and Ignore", () => {
    expect(setCollisionResponse({ mask: 0b11, overlapMask: 0 }, 1, "overlap")).toEqual({ mask: 0b01, overlapMask: 0b10 });
    expect(setCollisionResponse({ mask: 0b01, overlapMask: 0b10 }, 1, "ignore")).toEqual({ mask: 0b01, overlapMask: 0 });
  });

  it("derives an unused id from a new preset's name", () => {
    expect(newCollisionPresetId("Ghost Pass", presets)).toBe("ghost-pass-2");
    expect(newCollisionPresetId("Custom", presets)).toBe("custom-preset");
  });
});
