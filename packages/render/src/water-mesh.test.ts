import { describe, expect, it } from "vitest";
import { NullEngine, Scene, VertexBuffer } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody, sampleWaterSurface } from "@babylonslate/core";
import { createWaterMesh, sceneHasWater, setSceneWaterTime, updateSceneWater } from "./water-mesh";
import { applyAssignMesh, createPlayMesh, createSnapshotSceneBinding } from "./snapshot-apply";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";

describe("Water rendering", () => {
  it("realizes and resizes an identity-transform Water component received from Play", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const binding = createSnapshotSceneBinding();
    binding.waters = new Map([["water", { ...createDefaultWaterDefinition(), waveHeight: 0 }]]);
    const assign = (width: number) => applyAssignMesh(scene, binding, {
      type: "assignMesh", slotId: 1, meshKind: "water", meshAssetGuid: "water",
      parts: [{ componentId: "lake", meshKind: "water", meshAssetGuid: "water", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], water: normalizeWaterBody({ width, length: 10, resolution: 8 }) }],
    });
    try {
      assign(12);
      const root = binding.meshes.get(1)!;
      const surface = root.getChildMeshes()[0]!;
      expect(surface.isVerticesDataPresent("slateWaterData")).toBe(true);
      expect(surface.getBoundingInfo().boundingBox.maximum.x).toBeCloseTo(6);
      assign(20);
      expect(root.isDisposed()).toBe(true);
      expect(binding.meshes.get(1)!.getChildMeshes()[0]!.getBoundingInfo().boundingBox.maximum.x).toBeCloseTo(10);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("compiles Water Surface data into a custom material and preserves borrowed ownership", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const doc = createDefaultMaterialDocument("Foam");
      doc.shadingModel = "unlit";
      doc.nodes.push({ id: "water", type: "input.waterSurface", position: { x: 0, y: 0 }, properties: {} });
      doc.edges = [{ id: "foam", sourceNodeId: "water", sourcePinId: "bankDistance", targetNodeId: "output", targetPinId: "emissive" }];
      const plan = lowerMaterialDocument(doc);
      if (!plan.ok) throw new Error(JSON.stringify(plan.diagnostics));
      const result = compileMaterialPlan(plan.plan, { scene, name: "water-custom" });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      expect(await result.ready).toEqual([]);
      const mesh = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), undefined, result.material);
      const data = mesh.getVerticesData("slateWaterData")!;
      expect(data[1]).toBeCloseTo(0);
      expect(data[(4 * 9 + 4) * 4 + 1]).toBeCloseTo(15);
      mesh.dispose();
      expect(scene.materials).toContain(result.material);
      result.dispose();
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("moves the rendered surface with the simulation clock and releases owned resources", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const water = createDefaultWaterDefinition("stylized"), body = normalizeWaterBody({ width: 10, length: 10, waveScale: 1, resolution: 8 });
    try {
      const mesh = createWaterMesh(scene, "lake", body, water);
      const material = mesh.material;
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
      expect(scene.materials).not.toContain(material);
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
