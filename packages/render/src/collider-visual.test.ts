import { LinesMesh, Mesh, StandardMaterial } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import {
  createColliderVisualMesh,
  isColliderVisualMesh,
} from "./collider-visual";
import { RENDERING_GROUP } from "./sorting";

describe("collider visual", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function createHandle() {
    const handle = createTestEngine();
    handles.push(handle);
    return handle;
  }

  it("builds world-space dashed box segments with depth, not a line overlay", () => {
    const { scene } = createHandle();
    const mesh = createColliderVisualMesh(scene, "col", {
      kind: "box",
      halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
    });
    expect(isColliderVisualMesh(mesh)).toBe(true);
    expect(mesh).not.toBeInstanceOf(LinesMesh);
    expect(mesh.overlay).toBe(false);
    expect(mesh.isPickable).toBe(false);
    expect(mesh.renderingGroupId).toBe(RENDERING_GROUP.world);
    const dashes = mesh.getChildMeshes().filter((child): child is Mesh => child instanceof Mesh);
    expect(dashes.length).toBeGreaterThan(8);
    expect(dashes.some((child) => child instanceof LinesMesh)).toBe(false);
    const material = dashes[0]!.material as StandardMaterial;
    expect(material.disableDepthWrite).toBe(false);
    expect(material.alpha).toBe(1);
    expect(material.disableLighting).toBe(true);
  });

  it("builds dashed rings for a sphere", () => {
    const { scene } = createHandle();
    const mesh = createColliderVisualMesh(scene, "sphere", {
      kind: "sphere",
      radius: 0.5,
    });
    expect(mesh.getChildMeshes().length).toBeGreaterThan(8);
  });
});
