import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { createTestEngine } from "./test-support/test-engine";
import { PREVIEW_OWNER_MESH, HapticMeshShapeBlock, meshGeometryRelativeTo } from "./particle-mesh-shape";

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

  it("spawns on the drawn triangle at the drawn barycentric point, along its face normal, in its blended colour", () => {
    const block = new HapticMeshShapeBlock("shape");
    block.useMeshColor = true;
    // Two triangles; the second, (0,0,0) (2,0,0) (0,4,0), has red, half-transparent green and blue corners.
    block.source = { geometry: () => ({
      positions: [9, 9, 9, 9, 9, 8, 9, 8, 9, 0, 0, 0, 2, 0, 0, 0, 4, 0],
      indices: [0, 1, 2, 3, 4, 5],
      colors: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0.5, 0, 0, 1, 1],
    }) };
    const creation = (): { process: (particle: unknown) => void } => ({ process: () => {} });
    const system = { isLocal: true, _positionCreation: creation(), _directionCreation: creation(), _colorCreation: creation() };
    vi.spyOn(block.particle, "getConnectedValue").mockReturnValue(system);
    block._build({} as never);
    // Face 0.75 of two picks the second; u 0.25, then v 0.5 of what u leaves (0.375), w the rest (0.375).
    const draws = [0.75, 0.25, 0.5];
    const random = vi.spyOn(Math, "random").mockImplementation(() => draws.shift()!);
    const particle = { _properties: {} as Record<string, unknown>, position: new Vector3(), direction: new Vector3(), color: new Color4() };
    system._positionCreation.process(particle as never);
    system._directionCreation.process(particle as never);
    expect(random).toHaveBeenCalledTimes(3);
    random.mockRestore();
    expect(particle.position.asArray()).toEqual([0.75, 1.5, 0]);
    expect(particle.direction.asArray()).toEqual([0, 0, 1]);
    expect(particle.color.asArray()).toEqual([0.25, 0.375, 0.375, 0.8125]);
    expect((particle._properties.initialDirection as Vector3).asArray()).toEqual([0, 0, 1]);
  });

  it("shows Owner Mesh on a unit sphere in previews", () => {
    const sphere = PREVIEW_OWNER_MESH.geometry()!;
    expect(sphere.indices.length % 3).toBe(0);
    const radius = Math.hypot(sphere.positions[0]!, sphere.positions[1]!, sphere.positions[2]!);
    expect(radius).toBeCloseTo(0.5, 3);
  });
});
