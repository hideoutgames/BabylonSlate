import type { AbstractMesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, createDefaultScene } from "@haptic/core";
import { createTestEngine } from "./create-null-engine";
import { createEditorCamera } from "./editor-camera";
import { EditorSceneSync } from "./editor-scene-sync";
import { editorComponentMeshName } from "./scene-loader";
import {
  BLOCKING_VOLUME_COLOR,
  TIMELINE_PROXY_OUTLINE_CLASS_ID,
  createEditorVolumeMesh,
  createTimelineProxyOutlineMesh,
  isEditorVolumeMesh,
  NAV_BLOCKER_VOLUME_COLOR,
  timelineProxyOutlineOptions,
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

  it("builds a Timeline proxy Outline sized by Size, a cube in 3D and a square in 2D", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const cube = createTimelineProxyOutlineMesh(handle.scene, "proxy", { size: 2, color: "#22d3ee", twoD: false });
    expect(isEditorVolumeMesh(cube)).toBe(true);
    expect(cube.isPickable).toBe(true);
    expect(unlitBinding(cube).alpha).toBe(0);
    cube.computeWorldMatrix(true);
    const extent = cube.getBoundingInfo().boundingBox.extendSize;
    expect([extent.x, extent.y, extent.z]).toEqual([1, 1, 1]);
    const square = createTimelineProxyOutlineMesh(handle.scene, "proxy2d", { size: 2, color: "#22d3ee", twoD: true });
    // A square has a third of a cube's edges (4 of 12), so fewer dashes.
    expect(outlineDashCount(square)).toBeLessThan(outlineDashCount(cube));
    expect(timelineProxyOutlineOptions({ size: 3, color: "#ffffff", twoD: true })).toEqual({ size: 3, color: "#ffffff", twoD: true });
    expect(timelineProxyOutlineOptions({})).toEqual({ size: 1, color: "", twoD: false });
  });

  it("draws a Timeline proxy outline component in an editor scene, moving it without a rebuild and rebuilding on a new size", () => {
    const handle = createTestEngine();
    handles.push(handle);
    createEditorCamera(handle.scene, { mode: "3d" });
    const sync = new EditorSceneSync(handle.scene);
    const data = createDefaultScene();
    data.actors = [createActor("door", "Door", { components: [{
      id: "door:preview", classId: TIMELINE_PROXY_OUTLINE_CLASS_ID, properties: { size: 2, color: "#22d3ee", twoD: false },
    }] })];
    sync.apply(data);
    const outline = handle.scene.getMeshByName(editorComponentMeshName("door", "door:preview"))!;
    expect(outline).toBeTruthy();
    expect(outline.getChildMeshes().some((mesh) => mesh.name.endsWith(":outline"))).toBe(true);
    const moved = structuredClone(data);
    moved.actors[0]!.transform.position = [3, 0, 0];
    sync.apply(moved);
    expect(handle.scene.getMeshByName(outline.name)).toBe(outline);
    expect(outline.getAbsolutePosition().x).toBeCloseTo(3);
    const resized = structuredClone(moved);
    resized.actors[0]!.components[0]!.properties.size = 3;
    sync.apply(resized);
    const rebuilt = handle.scene.getMeshByName(outline.name)!;
    expect(rebuilt).not.toBe(outline);
    rebuilt.computeWorldMatrix(true);
    expect(rebuilt.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(1.5);
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
