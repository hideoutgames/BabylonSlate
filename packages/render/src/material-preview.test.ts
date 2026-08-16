import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, Scene } from "@babylonjs/core";
import { MATERIAL_PREVIEW_MESHES } from "@babylonslate/shader-graph";
import {
  MATERIAL_PREVIEW_MESH_NAME,
  createMaterialPreviewMesh,
  createMaterialPreviewScene,
} from "./material-preview";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function engine(): NullEngine {
  const created = new NullEngine();
  disposers.push(() => created.dispose());
  return created;
}

describe("material preview scene", () => {
  it("builds a mesh for every preview primitive", () => {
    const scene = new Scene(engine());
    disposers.push(() => scene.dispose());
    for (const kind of MATERIAL_PREVIEW_MESHES) {
      const mesh = createMaterialPreviewMesh(scene, kind);
      expect(mesh.getTotalVertices()).toBeGreaterThan(0);
      mesh.dispose();
    }
  });

  it("collapses the cone apex onto the axis", () => {
    const scene = new Scene(engine());
    disposers.push(() => scene.dispose());
    const cone = createMaterialPreviewMesh(scene, "cone");
    const positions = cone.getVerticesData("position")!;
    let maxY = -Infinity;
    for (let index = 1; index < positions.length; index += 3) {
      maxY = Math.max(maxY, positions[index]!);
    }
    let widestAtTop = 0;
    for (let index = 0; index < positions.length; index += 3) {
      if (Math.abs(positions[index + 1]! - maxY) > 1e-5) continue;
      widestAtTop = Math.max(
        widestAtTop,
        Math.hypot(positions[index]!, positions[index + 2]!),
      );
    }
    expect(widestAtTop).toBeLessThan(1e-5);
  });

  it("falls back to a sphere when a custom mesh has no bytes", () => {
    const scene = new Scene(engine());
    disposers.push(() => scene.dispose());
    const mesh = createMaterialPreviewMesh(scene, "custom", null);
    expect(mesh.getTotalVertices()).toBeGreaterThan(0);
    expect(mesh.name).toBe(MATERIAL_PREVIEW_MESH_NAME);
  });

  it("creates a scene with a camera, lights and a mesh", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    expect(host.scene.cameras.length).toBe(1);
    expect(host.scene.lights.length).toBeGreaterThan(0);
    expect(host.mesh.name).toBe(MATERIAL_PREVIEW_MESH_NAME);
  });

  it("swaps the primitive while keeping the applied material", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const before = host.mesh.getTotalVertices();
    const next = host.setMesh("cube");
    expect(next.getTotalVertices()).not.toBe(before);
    expect(host.scene.meshes.length).toBe(1);
  });

  it("disposes the old mesh when the primitive changes", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const original = host.mesh;
    host.setMesh("plane");
    expect(original.isDisposed()).toBe(true);
  });

  it("disposes its scene on close", () => {
    const created = engine();
    const host = createMaterialPreviewScene(created as never);
    const scene = host.scene;
    host.dispose();
    expect(scene.isDisposed).toBe(true);
  });
});
