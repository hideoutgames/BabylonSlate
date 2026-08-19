import { StandardMaterial } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import {
  BLOCKING_VOLUME_COLOR,
  createEditorVolumeMesh,
  isEditorVolumeMesh,
  NAV_BLOCKER_VOLUME_COLOR,
} from "./editor-volume";

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
    expect(mesh.getChildMeshes().length).toBeGreaterThan(8);
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
    expect(mesh.getChildMeshes().length).toBeGreaterThan(8);
  });
});
