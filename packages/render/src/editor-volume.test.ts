import { StandardMaterial, type AbstractMesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import {
  BLOCKING_VOLUME_COLOR,
  createEditorVolumeMesh,
  isEditorVolumeMesh,
  NAV_BLOCKER_VOLUME_COLOR,
} from "./editor-volume";

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
    const material = mesh.material as StandardMaterial;
    expect(material.alpha).toBe(0);
    expect(outlineDashCount(mesh)).toBeGreaterThan(8);
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
