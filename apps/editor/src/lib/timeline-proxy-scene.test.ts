import { describe, expect, it } from "vitest";
import { applyTimelineClipToScene, createDefaultTimelineClipAsset, defaultTimelineProxyPreview, type SerializedTimelineClipAsset } from "@haptic/core";
import { TIMELINE_PROXY_OUTLINE_CLASS_ID } from "@haptic/render";
import { composeTimelineProxyPreview, timelineProxyPreviewScene, timelineProxyScene } from "./timeline-proxy-scene";

const key = (id: string, Time: number, Value: unknown) => ({ id, Time, Value, Interpolation: "linear" as const, ArriveTangent: 0, LeaveTangent: 0 });

function clipAsset(previewAs: "relative" | "absolute", representation: "outline" | "model" | "class" = "outline"): SerializedTimelineClipAsset {
  return {
    ...createDefaultTimelineClipAsset("story"),
    length: 2,
    proxies: [
      { id: "door", name: "Door", represents: "actor", classId: "Door", tracks: [{
        id: "t", target: { kind: "transform", property: "location" }, valueType: "vec3",
        keys: [key("a", 0, { x: 0, y: 0, z: 0 }), key("b", 2, { x: 2, y: 0, z: 0 })],
      }] },
      { id: "glow", name: "Glow", represents: "component", classId: "LightComponent", tracks: [] },
    ],
    editorPreview: { proxies: {
      door: { ...defaultTimelineProxyPreview(0), location: [10, 0, 0], rotation: [0, 90, 0], previewAs, representation, ...(representation === "model" ? { assetGuid: "door-model" } : {}) },
      glow: { ...defaultTimelineProxyPreview(1), location: [0, 3, 0], size: 0.5 },
    } },
  };
}
const graphs = { Door: { nodes: [], edges: [], components: [{ id: "panel", classId: "MeshComponent", properties: {}, parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }] } } as never;
const close = (values: readonly number[]) => values.map((value) => Math.round(value * 1000) / 1000);

describe("Timeline proxy preview", () => {
  it("keys a Relative proxy from the origin and an Absolute one from its placement", () => {
    expect(timelineProxyScene(clipAsset("relative"), "Swing", graphs, false).actors[0]!.transform.position).toEqual([0, 0, 0]);
    expect(timelineProxyScene(clipAsset("absolute"), "Swing", graphs, false).actors[0]!.transform.position).toEqual([10, 0, 0]);
    // A 2D clip previews on a Scene Layer's base.
    expect(timelineProxyScene(clipAsset("relative"), "Swing", graphs, true)).toMatchObject({ viewportMode: "2d", overlayEditor: true });
  });

  it("draws each proxy by its representation, keeping a Component proxy's component", () => {
    const outline = timelineProxyPreviewScene(timelineProxyScene(clipAsset("relative"), "Swing", graphs, false), clipAsset("relative"), false);
    expect(outline.actors[0]!.components.map((component) => [component.id, component.classId])).toEqual([["door:preview", TIMELINE_PROXY_OUTLINE_CLASS_ID]]);
    expect(outline.actors[1]!.components.map((component) => component.id)).toEqual(["glow", "glow:preview"]);
    expect(outline.actors[1]!.components[1]!.properties).toMatchObject({ size: 0.5, twoD: false });
    const model = timelineProxyPreviewScene(timelineProxyScene(clipAsset("relative", "model"), "Swing", graphs, false), clipAsset("relative", "model"), false);
    expect(model.actors[0]!.components[0]).toMatchObject({ classId: "MeshComponent", properties: { assetGuid: "door-model" } });
    const own = timelineProxyPreviewScene(timelineProxyScene(clipAsset("relative", "class"), "Swing", graphs, false), clipAsset("relative", "class"), false);
    expect(own.actors[0]!.components.map((component) => component.id)).toEqual(["panel"]);
  });

  it("places a Relative proxy's keyed offset at its preview placement, and leaves an Absolute one where its keys are", () => {
    for (const previewAs of ["relative", "absolute"] as const) {
      const payload = clipAsset(previewAs);
      const scene = timelineProxyPreviewScene(timelineProxyScene(payload, "Swing", graphs, false), payload, false);
      const clip = scene.timelineClips![0]!;
      const shown = composeTimelineProxyPreview(applyTimelineClipToScene(scene, clip, 1, new Map()), payload);
      const door = shown.actors.find((actor) => actor.id === "door")!;
      // An offset of +1 on X, turned 90 degrees about Y, from (10, 0, 0); else the keyed (1, 0, 0).
      expect(close(door.transform.position)).toEqual(previewAs === "relative" ? [10, 0, -1] : [1, 0, 0]);
    }
  });
});
