import { expect, it } from "vitest";
import { MeshBuilder, NullEngine, Scene } from "@babylonjs/core";
import { partitionShadowGeometry } from "./shadow-geometry-partitions";

it("partitions a large static ground without changing its geometry, UVs or face order", () => {
  const engine = new NullEngine();
  try {
    const scene = new Scene(engine);
    const ground = MeshBuilder.CreateGround("terrain", { width: 1000, height: 1000, subdivisions: 64 }, scene);
    ground.computeWorldMatrix(true);
    const geometry = ground.geometry;
    const indices = Array.from(ground.getIndices()!);
    const uv = Array.from(ground.getVerticesData("uv")!);
    partitionShadowGeometry(ground);
    expect(ground.geometry).toBe(geometry);
    expect(Array.from(ground.getIndices()!)).toEqual(indices);
    expect(Array.from(ground.getVerticesData("uv")!)).toEqual(uv);
    expect(ground.subMeshes.length).toBeGreaterThan(1);
    expect(ground.subMeshes.reduce((sum, part) => sum + part.indexCount, 0)).toBe(indices.length);
    expect(ground.subMeshes.every((part) => part.indexCount <= 3072 && part.materialIndex === 0)).toBe(true);
    const count = ground.subMeshes.length;
    partitionShadowGeometry(ground);
    expect(ground.subMeshes).toHaveLength(count);
  } finally { engine.dispose(); }
});
