import { describe, expect, it } from "vitest";
import { createEmptyProject, pixelArtProjectSettings, type SerializedComponent } from "@haptic/core";
import { cameraPropertyRows } from "./camera-property-rows";
import { pixelMatchedSizeStatus, projectPixelMatchedLens } from "./pixel-matched-camera-status";

const camera: SerializedComponent = { id: "lens", classId: "CameraComponent", properties: { projectionMode: "orthographic", orthographicSize: 1 } };

describe("pixel-matched camera rows", () => {
  it("pixel-matches only with Pixel-Perfect Mode and Nearest Texture Filtering", () => {
    const basic2D = createEmptyProject("Basic", { kind: "2d" });
    expect(projectPixelMatchedLens(basic2D)).toBeNull();
    const pixelArt = { ...basic2D, settings: pixelArtProjectSettings({ ...basic2D.settings, render: { ...basic2D.settings.render, width: 640, height: 360 } }) };
    expect(projectPixelMatchedLens(pixelArt)).toEqual({ design: { width: 640, height: 360 }, pixelsPerUnit: 100 });
  });

  it("says what the size resolves to, in whole design pixels per texel", () => {
    const lens = { design: { width: 640, height: 360 }, pixelsPerUnit: 100 };
    expect(pixelMatchedSizeStatus(2, lens)).toBe("Pixel-matched: 2 design pixels per texel, 1.8 units tall.");
    expect(pixelMatchedSizeStatus(10, lens)).toBe("Pixel-matched: 1/3 design pixels per texel, 10.8 units tall.");
  });

  it("shows the status and tooltip on Orthographic Size only while the project pixel-matches", () => {
    const lens = { design: { width: 640, height: 360 }, pixelsPerUnit: 100 };
    const size = (pixelMatchedCamera: typeof lens | null) => cameraPropertyRows("a", camera, () => {}, {
      sortingLayers: [], collisionLayers: [], assetLabel: () => undefined, physicsWorld: "2d", onPickAsset: () => {}, pixelMatchedCamera,
    }).find((row) => row.label === "Orthographic Size")!;
    expect(size(lens)).toMatchObject({ status: "Pixel-matched: 2 design pixels per texel, 1.8 units tall." });
    expect(size(lens).description).toBeTruthy();
    expect(size(null).status).toBeUndefined();
    expect(size(null).description).toBeUndefined();
  });
});
