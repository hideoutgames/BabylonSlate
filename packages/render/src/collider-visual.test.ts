import { LinesMesh, Mesh, StandardMaterial, Vector3, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import {
  createColliderVisualMesh,
  isColliderVisualMesh,
} from "./collider-visual";
import { RENDERING_GROUP } from "./sorting";

/** World-space dash centers of a visual at the origin; every dash is a 24-vertex box. */
function dashCenters(mesh: Mesh): Vector3[] {
  const centers: Vector3[] = [];
  for (const child of mesh.getChildMeshes()) {
    const world = child.computeWorldMatrix(true);
    const positions = child.getVerticesData(VertexBuffer.PositionKind) ?? [];
    for (let start = 0; start < positions.length; start += 24 * 3) {
      const center = Vector3.Zero();
      for (let i = start; i < start + 24 * 3; i += 3) {
        center.addInPlaceFromFloats(positions[i]!, positions[i + 1]!, positions[i + 2]!);
      }
      centers.push(Vector3.TransformCoordinates(center.scaleInPlace(1 / 24), world));
    }
  }
  return centers;
}

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
    expect(mesh.isPickable).toBe(false);
    expect(mesh.renderingGroupId).toBe(RENDERING_GROUP.world);
    const dashes = mesh.getChildMeshes().filter((child): child is Mesh => child instanceof Mesh);
    expect(dashCenters(mesh).length).toBeGreaterThan(8);
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
    expect(dashCenters(mesh).length).toBeGreaterThan(8);
  });

  it("draws both capsule hemispheres in the front and side planes", () => {
    const { scene } = createHandle();
    const mesh = createColliderVisualMesh(scene, "capsule", {
      kind: "capsule",
      radius: 0.5,
      halfHeight: 1,
    });
    const centers = dashCenters(mesh);
    for (const sign of [-1, 1]) {
      const cap = centers.filter((point) => point.y * sign > 1.1);
      expect(cap.some((point) => Math.abs(point.x) > 0.1 && Math.abs(point.z) < 0.01)).toBe(true);
      expect(cap.some((point) => Math.abs(point.z) > 0.1 && Math.abs(point.x) < 0.01)).toBe(true);
      expect(Math.max(...cap.map((point) => point.y * sign))).toBeGreaterThan(1.45);
    }
  });

  it("builds dashed cylinder edges instead of an AABB", () => {
    const { scene } = createHandle();
    const mesh = createColliderVisualMesh(scene, "cyl", {
      kind: "cylinder",
      radius: 0.5,
      height: 1,
    });
    expect(isColliderVisualMesh(mesh)).toBe(true);
    expect(dashCenters(mesh).length).toBeGreaterThan(8);
  });
});
