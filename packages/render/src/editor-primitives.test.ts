import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { buildEditorPrimitivesFiles, decodeHassetChunk, readHassetHeader } from "@haptic/assets";
import { createTestEngine } from "./test-support/test-engine";
import { loadModelContainer, modelMaterialIndexOf } from "./model-container";

/** Model space after Babylon's glTF handedness conversion, which reflects X. */
const BOUNDS: Record<string, [[number, number, number], [number, number, number]]> = {
  Cube: [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
  Sphere: [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
  Hemisphere: [[-0.5, 0, -0.5], [0.5, 0.5, 0.5]],
  Cylinder: [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
  Cone: [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
  Capsule: [[-0.5, -1, -0.5], [0.5, 1, 0.5]],
  Torus: [[-0.5, -0.15, -0.5], [0.5, 0.15, 0.5]],
  Tube: [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
  Pyramid: [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
  Wedge: [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
  Plane: [[-0.5, 0, -0.5], [0.5, 0, 0.5]],
  SubdividedPlane: [[-0.5, 0, -0.5], [0.5, 0, 0.5]],
  Disc: [[-0.5, 0, -0.5], [0.5, 0, 0.5]],
};

function worldVertices(mesh: AbstractMesh): Vector3[] {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind) ?? [];
  const world = mesh.computeWorldMatrix(true);
  const out: Vector3[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    out.push(Vector3.TransformCoordinates(new Vector3(positions[index], positions[index + 1], positions[index + 2]), world));
  }
  return out;
}

describe("EditorPrimitives Models", () => {
  // One build and one Engine for the file: a build hashes, hulls and bakes every Model.
  const sources = new Map<string, Uint8Array>();
  let handle: ReturnType<typeof createTestEngine>;
  beforeAll(async () => {
    for (const file of await buildEditorPrimitivesFiles()) {
      if (!file.path.startsWith("assets/")) continue;
      expect(readHassetHeader(file.data).type).toBe("Model");
      sources.set(file.path.slice("assets/".length, -".hasset".length), (await decodeHassetChunk(file.data, "source"))!);
    }
    handle = createTestEngine();
  });
  afterAll(() => {
    handle.scene.dispose();
    handle.engine.dispose();
  });

  async function load(name: string) {
    const container = await loadModelContainer(handle.scene, sources.get(name)!, `${name}.glb`);
    container.addAllToScene();
    for (const node of container.transformNodes) node.computeWorldMatrix(true);
    for (const mesh of container.meshes) mesh.computeWorldMatrix(true);
    return { meshes: container.meshes.filter((mesh) => mesh.getTotalVertices() > 0), dispose: () => container.dispose() };
  }

  it("loads every shape through the glTF loader as one mesh on slot 0 at its documented size", async () => {
    expect([...sources.keys()].sort()).toEqual(Object.keys(BOUNDS).sort());
    for (const [name, [min, max]] of Object.entries(BOUNDS)) {
      const { meshes, dispose } = await load(name);
      expect(meshes, name).toHaveLength(1);
      expect(modelMaterialIndexOf(meshes[0]!), name).toBe(0);
      const vertices = worldVertices(meshes[0]!);
      for (const [axis, key] of (["x", "y", "z"] as const).entries()) {
        expect(Math.min(...vertices.map((vertex) => vertex[key])), `${name} min ${key}`).toBeCloseTo(min[axis]!, 5);
        expect(Math.max(...vertices.map((vertex) => vertex[key])), `${name} max ${key}`).toBeCloseTo(max[axis]!, 5);
      }
      dispose();
    }
  });

  it("raises the Wedge towards +Z, an actor's forward", async () => {
    const { meshes: [wedge], dispose } = await load("Wedge");
    const top = worldVertices(wedge!).filter((vertex) => vertex.y > 0.49);
    expect(top.length).toBeGreaterThan(0);
    for (const vertex of top) expect(vertex.z).toBeCloseTo(0.5, 5);
    dispose();
  });
});
