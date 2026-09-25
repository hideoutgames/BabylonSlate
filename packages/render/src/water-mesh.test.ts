import { describe, expect, it } from "vitest";
import { NullEngine, Scene, VertexBuffer } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody, sampleWaterSurface } from "@babylonslate/core";
import { createWaterMesh, sceneHasWater, setSceneWaterTime, updateSceneWater } from "./water-mesh";
import { createPlayMesh } from "./snapshot-apply";

describe("Water rendering", () => {
  it("moves the rendered surface with the simulation clock and releases owned resources", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const water = createDefaultWaterDefinition("stylized"), body = normalizeWaterBody({ width: 10, length: 10, waveScale: 1, resolution: 8 });
    const materialCount = scene.materials.length;
    try {
      const mesh = createWaterMesh(scene, "lake", body, water);
      setSceneWaterTime(scene, 2);
      updateSceneWater(scene);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const middle = (4 * 9 + 4) * 3;
      const height = positions[middle + 1]!;
      expect(height).toBeCloseTo(sampleWaterSurface(water, body, { x: 0, y: 0, z: 0 }, 2).height, 5);
      setSceneWaterTime(scene, 3);
      updateSceneWater(scene);
      expect(Math.abs(mesh.getVerticesData(VertexBuffer.PositionKind)![middle + 1]! - height)).toBeGreaterThan(0.05);
      expect(sceneHasWater(scene)).toBe(true);
      mesh.dispose();
      expect(sceneHasWater(scene)).toBe(false);
      expect(scene.materials.length).toBe(materialCount);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("constructs a bounded river from a Play component without a model asset", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const body = normalizeWaterBody({ width: 2, waveScale: 0, points: [[0, 4, 0], [0, 2, 10]], resolution: 8 }, "river");
    try {
      const mesh = createPlayMesh(scene, 1, "water", null, undefined, undefined, undefined, undefined, undefined, undefined, undefined, body);
      const box = mesh.getBoundingInfo().boundingBox;
      expect(box.minimum.x).toBeCloseTo(-1);
      expect(box.maximum.x).toBeCloseTo(1);
      expect(box.minimum.y).toBeCloseTo(2);
      expect(box.maximum.y).toBeCloseTo(4);
      expect(box.minimum.z).toBeCloseTo(-1);
      expect(box.maximum.z).toBeCloseTo(11);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
