import { afterEach, describe, expect, it } from "vitest";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { createTestEngine } from "./test-support/test-engine";
import { PREVIEW_OWNER_MESH, meshGeometryRelativeTo } from "./particle-mesh-shape";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

describe("Mesh Shape geometry", () => {
  it("bakes a mesh's vertices and normals into the emitter's space", () => {
    const { scene, engine } = createTestEngine();
    cleanups.push(() => { scene.dispose(); engine.dispose(); });
    const actor = MeshBuilder.CreateBox("actor", { size: 0.01 }, scene);
    actor.position.set(10, 0, 0);
    const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    box.parent = actor;
    box.position.set(0, 3, 0);
    const emitter = MeshBuilder.CreateBox("emitter", { size: 0.01 }, scene);
    emitter.parent = actor;
    const geometry = meshGeometryRelativeTo(box, emitter)!;
    const ys = Array.from({ length: geometry.positions.length / 3 }, (_, index) => geometry.positions[index * 3 + 1]!);
    // Offset by the box's local position, not the actor's world position.
    expect(Math.min(...ys)).toBeCloseTo(2, 5);
    expect(Math.max(...ys)).toBeCloseTo(4, 5);
    const xs = Array.from({ length: geometry.positions.length / 3 }, (_, index) => geometry.positions[index * 3]!);
    expect(Math.max(...xs)).toBeCloseTo(1, 5);
    const normal = new Vector3(geometry.normals![0], geometry.normals![1], geometry.normals![2]);
    expect(normal.length()).toBeCloseTo(1, 5);
  });

  it("shows Owner Mesh on a unit sphere in previews", () => {
    const sphere = PREVIEW_OWNER_MESH.geometry()!;
    expect(sphere.indices.length % 3).toBe(0);
    const radius = Math.hypot(sphere.positions[0]!, sphere.positions[1]!, sphere.positions[2]!);
    expect(radius).toBeCloseTo(0.5, 3);
  });
});
