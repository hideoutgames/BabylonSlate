import { describe, expect, it } from "vitest";
import { parseMirrorProperties } from "./mirror";
import { normalizeScene } from "./scene";

describe("mirror authoring", () => {
  it("replaces invalid sizes, clamps scale and tint, and trims the Material override", () => {
    expect(parseMirrorProperties({
      width: 0, height: -3, resolutionScale: 0.01, tint: [-1, 0.25, 7], materialGuid: " mat ", surface: "native",
    })).toEqual({ enabled: true, width: 2, height: 2, resolutionScale: 0.1, tint: [0, 0.25, 1], materialGuid: "mat" });
    expect(parseMirrorProperties({ enabled: false, width: Infinity, resolutionScale: 4, tint: [1, 1], materialGuid: "  " }))
      .toEqual({ enabled: false, width: 2, height: 2, resolutionScale: 1, tint: [1, 1, 1], materialGuid: null });
    expect(parseMirrorProperties({ resolutionScale: Number.NaN }).resolutionScale).toBe(1);
  });

  it("normalizes Mirror components when a scene loads", () => {
    const scene = normalizeScene({
      actors: [{ id: "a", name: "Mirror", components: [{ id: "m", classId: "MirrorComponent", properties: { width: 3, height: "tall" } }] }],
    });
    expect(scene.actors[0]!.components[0]!.properties).toEqual({
      enabled: true, width: 3, height: 2, resolutionScale: 1, tint: [1, 1, 1], materialGuid: null,
    });
  });
});
