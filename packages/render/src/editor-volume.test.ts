import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, createDefaultScene } from "@haptic/core";
import { createTestEngine } from "./test-support/test-engine";
import { createEditorCamera } from "./editor-camera";
import { EditorSceneSync } from "./editor-scene-sync";
import { editorComponentMeshName } from "./scene-loader";
import {
  BLOCKING_VOLUME_COLOR,
  TIMELINE_PROXY_SHAPE_CLASS_ID,
  createEditorVolumeMesh,
  createTimelineProxyShapeMesh,
  isEditorVolumeMesh,
  NAV_BLOCKER_VOLUME_COLOR,
  timelineProxyShapeOptions,
} from "./editor-volume";
import { isUnlitMaterial } from "./unlit-material";
import { unlitBinding } from "./unlit-material-blocks";

/** Dash boxes in the merged `:dash:` outline mesh (24 vertices per box). */
function outlineDashCount(mesh: AbstractMesh): number {
  const dashes = mesh.getChildMeshes().filter((child) => child.name.includes(":dash:"));
  expect(dashes).toHaveLength(1);
  return dashes[0]!.getTotalVertices() / 24;
}

describe("editor volume", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("builds a pickable invisible box with a dotted outline", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createEditorVolumeMesh(
      handle.scene,
      "vol",
      "box",
      NAV_BLOCKER_VOLUME_COLOR,
    );
    expect(isEditorVolumeMesh(mesh)).toBe(true);
    expect(mesh.isPickable).toBe(true);
    expect(mesh.visibility).toBe(1);
    expect(isUnlitMaterial(mesh.material)).toBe(true);
    expect(unlitBinding(mesh).alpha).toBe(0);
    expect(outlineDashCount(mesh)).toBeGreaterThan(8);
  });

  it("builds a Timeline proxy Shape: solid, opaque and in the proxy's colour, a shaded box in 3D and a flat rectangle in 2D", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const box = createTimelineProxyShapeMesh(handle.scene, "proxy", { color: "#22d3ee", twoD: false });
    expect(isEditorVolumeMesh(box)).toBe(true);
    expect(box.isPickable).toBe(true);
    expect(box.getChildMeshes()).toHaveLength(0);
    // Opaque, in the proxy's colour (#22d3ee).
    expect(unlitBinding(box)).toMatchObject({ alpha: 1, blend: false });
    expect(unlitBinding(box).color.map((channel) => Math.round(channel * 255))).toEqual([0x22, 0xd3, 0xee]);
    // Faces shaded by the baked light: the top is brighter than the bottom, and every face is lit some.
    const normals = box.getVerticesData(VertexBuffer.NormalKind)!;
    const colors = box.getVerticesData(VertexBuffer.ColorKind)!;
    const shadeFacing = (y: number) => colors[[...Array(normals.length / 3).keys()].find((vertex) => normals[vertex * 3 + 1] === y)! * 4]!;
    expect(shadeFacing(1)).toBeGreaterThan(shadeFacing(-1));
    expect(Math.min(...colors.filter((_, index) => index % 4 === 0))).toBeGreaterThanOrEqual(0.55);
    box.computeWorldMatrix(true);
    const extent = box.getBoundingInfo().boundingBox.extendSize;
    expect([extent.x, extent.y, extent.z]).toEqual([0.5, 0.5, 0.5]);
    const square = createTimelineProxyShapeMesh(handle.scene, "proxy2d", { color: "#22d3ee", twoD: true });
    expect(square.isVerticesDataPresent(VertexBuffer.ColorKind)).toBe(false);
    expect(unlitBinding(square)).toMatchObject({ alpha: 1, twoSided: true });
    square.computeWorldMatrix(true);
    expect(square.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(0.5);
    expect(timelineProxyShapeOptions({ color: "#ffffff", twoD: true })).toEqual({ color: "#ffffff", twoD: true });
    expect(timelineProxyShapeOptions({})).toEqual({ color: "", twoD: false });
  });

  it("draws a Timeline proxy Shape component in an editor scene, moving it without a rebuild and rebuilding on a new colour", () => {
    const handle = createTestEngine();
    handles.push(handle);
    createEditorCamera(handle.scene, { mode: "3d" });
    const sync = new EditorSceneSync(handle.scene);
    const data = createDefaultScene();
    data.actors = [createActor("door", "Door", { components: [{
      id: "door:preview", classId: TIMELINE_PROXY_SHAPE_CLASS_ID, properties: { color: "#22d3ee", twoD: false },
    }] })];
    sync.apply(data);
    const shape = handle.scene.getMeshByName(editorComponentMeshName("door", "door:preview"))!;
    expect(shape).toBeTruthy();
    expect(unlitBinding(shape).alpha).toBe(1);
    const moved = structuredClone(data);
    moved.actors[0]!.transform.position = [3, 0, 0];
    sync.apply(moved);
    expect(handle.scene.getMeshByName(shape.name)).toBe(shape);
    expect(shape.getAbsolutePosition().x).toBeCloseTo(3);
    const recoloured = structuredClone(moved);
    recoloured.actors[0]!.components[0]!.properties.color = "#f97316";
    sync.apply(recoloured);
    const rebuilt = handle.scene.getMeshByName(shape.name)!;
    expect(rebuilt).not.toBe(shape);
    expect(unlitBinding(rebuilt).color.map((channel) => Math.round(channel * 255))).toEqual([0xf9, 0x73, 0x16]);
    sync.dispose();
  });

  it("builds a cylinder volume outline", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createEditorVolumeMesh(
      handle.scene,
      "cyl",
      "cylinder",
      BLOCKING_VOLUME_COLOR,
    );
    expect(outlineDashCount(mesh)).toBeGreaterThan(8);
  });
});
