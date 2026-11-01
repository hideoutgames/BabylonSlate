import { describe, expect, it } from "vitest";
import { applyTimelineClipToScene, createDefaultTimelineClipAsset, defaultTimelineProxyPreview, eulerDegreesToQuaternion, type SerializedTimelineClipAsset } from "@haptic/core";
import { TIMELINE_PROXY_OUTLINE_CLASS_ID } from "@haptic/render";
import { composeTimelineProxyPreview, timelineProxyGizmoEdit, timelineProxyPreviewScene, timelineProxyScene } from "./timeline-proxy-scene";

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
const close = (values: readonly number[]) => values.map((value) => Math.round(value * 1000) / 1000 + 0);

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

describe("Gizmo drags on proxies", () => {
  let ids = 0;
  const options = (autoKey: boolean) => ({ autoKey, unkeyed: new Map<string, unknown>(), newId: () => `k${ids++}` });
  const live = (actorId: string, position: [number, number, number], yaw = 0, scale: [number, number, number] = [1, 1, 1]) => ({
    actorId, position, rotation: eulerDegreesToQuaternion([0, yaw, 0]), scale,
  });
  const doorKeys = (payload: SerializedTimelineClipAsset) => payload.proxies[0]!.tracks[0]!.keys.map((entry) => [entry.Time, close(Object.values(entry.Value as object) as number[])]);

  it("keys a Relative proxy's tracked Location as the offset from its turned placement (Auto Key)", () => {
    const payload = clipAsset("relative");
    // Dropped at (10, 0, -1.5): 1.5 units along the placement's turned X axis, where the clip had 1.
    const edit = timelineProxyGizmoEdit(payload, timelineProxyScene(payload, "Swing", graphs, false), 1, [live("door", [10, 0, -1.5], 90)], options(true));
    expect(doorKeys(edit.payload)).toEqual([[0, [0, 0, 0]], [1, [1.5, 0, 0]], [2, [2, 0, 0]]]);
    // Rotation has no track and did not change: the placement stays.
    expect(edit.payload.editorPreview!.proxies.door).toEqual(payload.editorPreview!.proxies.door);
  });

  it("keeps a tracked change unkeyed without Auto Key, and keys an Absolute proxy's world value", () => {
    const relative = clipAsset("relative");
    const pending = timelineProxyGizmoEdit(relative, timelineProxyScene(relative, "Swing", graphs, false), 1, [live("door", [10, 0, -3], 90)], options(false));
    expect(pending.payload).toBe(relative);
    expect([...pending.unkeyed].map(([id, value]) => [id, close(Object.values(value as object) as number[])])).toEqual([["t", [3, 0, 0]]]);
    const absolute = clipAsset("absolute");
    const keyed = timelineProxyGizmoEdit(absolute, timelineProxyScene(absolute, "Swing", graphs, false), 1, [live("door", [4, 0, 0], 90)], options(true));
    expect(doorKeys(keyed.payload)).toContainEqual([1, [4, 0, 0]]);
  });

  it("moves an untracked proxy's preview placement, and turns a Relative one in place", () => {
    const payload = clipAsset("relative");
    const scene = timelineProxyScene(payload, "Swing", graphs, false);
    // Glow has no tracks: its placement follows the drop.
    const moved = timelineProxyGizmoEdit(payload, scene, 0, [live("glow", [5, 1, 0], 45)], options(true));
    expect(close(moved.payload.editorPreview!.proxies.glow!.location)).toEqual([5, 1, 0]);
    expect(close(moved.payload.editorPreview!.proxies.glow!.rotation)).toEqual([0, 45, 0]);
    expect(moved.payload.proxies).toEqual(payload.proxies);
    // Door turned to 0 degrees where it stands at 1 s, (10, 0, -1): its keyed offset now runs along world X, so the placement moves back by it.
    const turned = timelineProxyGizmoEdit(payload, scene, 1, [live("door", [10, 0, -1], 0)], options(true));
    expect(close(turned.payload.editorPreview!.proxies.door!.rotation)).toEqual([0, 0, 0]);
    expect(close(turned.payload.editorPreview!.proxies.door!.location)).toEqual([9, 0, -1]);
    expect(turned.payload.proxies).toEqual(payload.proxies);
  });

  it("keeps Scale without a track in the preview placement, which Relative Scale keys then multiply", () => {
    const payload = clipAsset("relative");
    const scene = timelineProxyScene(payload, "Swing", graphs, false);
    const edit = timelineProxyGizmoEdit(payload, scene, 0, [live("door", [10, 0, 0], 90, [2, 3, 1])], options(true));
    expect(edit.payload.editorPreview!.proxies.door).toEqual({ ...payload.editorPreview!.proxies.door, scale: [2, 3, 1] });
    expect(edit.payload.proxies).toEqual(payload.proxies);
    expect(edit.unkeyed.size).toBe(0);

    // Drawn at the placement's Scale; a Scale key of 2 on X doubles it, and a drag keys the value divided by it.
    const scaleTrack = { id: "s", target: { kind: "transform" as const, property: "scale" as const }, valueType: "vec3" as const,
      keys: [key("s0", 0, { x: 2, y: 1, z: 1 })] };
    const scaled: SerializedTimelineClipAsset = { ...edit.payload, proxies: [{ ...edit.payload.proxies[0]!, tracks: [...edit.payload.proxies[0]!.tracks, scaleTrack] }, edit.payload.proxies[1]!] };
    const preview = timelineProxyPreviewScene(timelineProxyScene(scaled, "Swing", graphs, false), scaled, false);
    const shown = composeTimelineProxyPreview(applyTimelineClipToScene(preview, preview.timelineClips![0]!, 0, new Map()), scaled);
    expect(close(shown.actors[0]!.transform.scale)).toEqual([4, 3, 1]);
    const keyed = timelineProxyGizmoEdit(scaled, timelineProxyScene(scaled, "Swing", graphs, false), 0, [live("door", [10, 0, 0], 90, [6, 3, 1])], options(true));
    expect(keyed.payload.proxies[0]!.tracks[1]!.keys.map((entry) => close(Object.values(entry.Value as object) as number[]))).toEqual([[3, 1, 1]]);
    expect(keyed.payload.editorPreview!.proxies.door!.scale).toEqual([2, 3, 1]);
  });

  it("overwrites the preview placement for transform tracks without keys, with Auto Key on or off", () => {
    const empty = (property: "location" | "rotation" | "scale") => ({ id: property, target: { kind: "transform" as const, property }, valueType: "vec3" as const, keys: [] });
    const base = clipAsset("relative");
    const payload: SerializedTimelineClipAsset = { ...base, proxies: [base.proxies[0]!, { ...base.proxies[1]!, tracks: [empty("location"), empty("rotation"), empty("scale")] }] };
    const scene = timelineProxyScene(payload, "Swing", graphs, false);
    for (const autoKey of [true, false]) {
      const edit = timelineProxyGizmoEdit(payload, scene, 1, [live("glow", [5, 1, 0], 45, [2, 2, 2])], options(autoKey));
      expect(edit.payload.editorPreview!.proxies.glow).toMatchObject({ location: [5, 1, 0], scale: [2, 2, 2] });
      expect(close(edit.payload.editorPreview!.proxies.glow!.rotation)).toEqual([0, 45, 0]);
      expect(edit.payload.proxies).toEqual(payload.proxies);
      expect(edit.unkeyed.size).toBe(0);
    }
  });

  it("stands an Absolute proxy at its placement's Scale", () => {
    const payload = clipAsset("absolute");
    payload.editorPreview!.proxies.door!.scale = [2, 2, 2];
    expect(timelineProxyScene(payload, "Swing", graphs, false).actors[0]!.transform.scale).toEqual([2, 2, 2]);
  });
});
