import { describe, expect, it, vi } from "vitest";
import { CubeTexture, FreeCamera, NullEngine, PBRMaterial, Quaternion, Scene, SphericalPolynomial, Texture, Vector3, VertexBuffer } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody, sampleWaterSurface } from "@babylonslate/core";
import { createWaterMesh, sceneHasWater, setSceneWaterTime, updateSceneWater } from "./water-mesh";
import { applyAssignMesh, createPlayMesh, createSnapshotSceneBinding } from "./snapshot-apply";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { compileMaterialPlan, prewarmMaterial } from "./material-compiler";
import { buildFloatDdsCubeFixture } from "@babylonslate/test-kit/environment-fixtures";
import { resourceCacheForEngine, type ResourceLease } from "./resource-cache";
import { createSkyboxMesh } from "./skybox";

describe("Water rendering", () => {
  it("shares owned water reflection views without changing the skybox, and honors an explicit environment", () => {
    const engine = new NullEngine(), scene = new Scene(engine), cache = resourceCacheForEngine(engine);
    // Only native upload IO is substituted: keep real cube views, materials and cache leases.
    vi.spyOn(engine, "createPrefilteredCubeTexture").mockImplementation((url) => {
      const internal = engine.createTexture(url, false, false, null);
      internal.isCube = true; internal._sphericalPolynomial = new SphericalPolynomial();
      return internal;
    });
    try {
      const lease = cache.acquireTexture("sky", engine, buildFloatDdsCubeFixture(), { isCube: true }) as ResourceLease<CubeTexture>;
      const source = lease.resource, sky = createSkyboxMesh(scene, "sky", lease);
      const a = createWaterMesh(scene, "a", normalizeWaterBody({ resolution: 8 }));
      const b = createWaterMesh(scene, "b", normalizeWaterBody({ resolution: 8 }));
      updateSceneWater(scene);
      const material = a.material as PBRMaterial, other = b.material as PBRMaterial;
      const view = material.reflectionTexture!;
      expect(view).not.toBe(source);
      expect(view).toBe(other.reflectionTexture);
      expect(view.getInternalTexture()).toBe(source.getInternalTexture());
      expect(source.coordinatesMode).toBe(Texture.SKYBOX_MODE);
      expect(view.coordinatesMode).toBe(Texture.CUBIC_MODE);
      scene.environmentTexture = source; updateSceneWater(scene);
      expect(material.reflectionTexture).toBeNull();
      expect(view.getInternalTexture()).toBeNull();
      scene.environmentTexture = null; updateSceneWater(scene);
      const replacement = other.reflectionTexture!;
      a.dispose();
      expect(replacement.isReady()).toBe(true);
      b.dispose();
      expect(replacement.getInternalTexture()).toBeNull();
      expect(source.isReady()).toBe(true);
      sky.dispose(); cache.flushUnreferenced();
      expect(source.getInternalTexture()).toBeNull();
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });
  it("resizes tessellation with a stretched volume while rendered waves still match world-space queries", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const water = createDefaultWaterDefinition(), body = normalizeWaterBody({ width: 12, length: 10, waveScale: 1 }, "ocean");
    try {
      const mesh = createWaterMesh(scene, "ocean", body, water), initialVertices = mesh.getTotalVertices();
      mesh.position.set(7, 3, -4); mesh.scaling.set(-3, 4, 2);
      mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.2, 0.12, -0.05);
      setSceneWaterTime(scene, 1.7); updateSceneWater(scene);
      expect(mesh.getTotalVertices()).toBeGreaterThan(initialVertices * 3);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const waterData = mesh.getVerticesData("slateWaterData")!;
      const matrix = mesh.computeWorldMatrix(true);
      const transform = { position: mesh.position, rotation: mesh.rotationQuaternion, scale: mesh.scaling };
      // Interior vertices compare the renderer and the public physics query, not a duplicate wave formula.
      for (let i = 15; i < positions.length - 15; i += 57) {
        if (waterData[i / 3 * 4 + 1]! < 1) continue;
        const point = Vector3.TransformCoordinates(Vector3.FromArray(positions, i), matrix);
        const sample = sampleWaterSurface(water, body, point, 1.7, transform);
        expect(sample.found).toBe(true);
        expect(sample.height).toBeCloseTo(point.y, 4);
      }
      mesh.scaling.setAll(0); updateSceneWater(scene);
      expect(Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!).every(Number.isFinite)).toBe(true);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("keeps Ocean bounds fixed when the camera moves and lets Global Water Volume cover the horizon", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 4, 0), scene);
    camera.maxZ = 1500;
    try {
      const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 60, length: 40 }, "ocean"));
      const global = createWaterMesh(scene, "global", normalizeWaterBody({}, "global"));
      const before = ocean.getBoundingInfo().boundingBox;
      expect([before.minimum.x, before.maximum.x, before.minimum.z, before.maximum.z]).toEqual([-30, 30, -20, 20]);
      camera.position.set(10000, 4, -5000); updateSceneWater(scene);
      const after = ocean.getBoundingInfo().boundingBox;
      expect([after.minimum.x, after.maximum.x, after.minimum.z, after.maximum.z]).toEqual([-30, 30, -20, 20]);
      const horizon = global.getBoundingInfo().boundingBox;
      expect(horizon.minimum.x).toBeLessThan(8500);
      expect(horizon.maximum.x).toBeGreaterThan(11500);
      expect(horizon.minimum.z).toBeLessThan(-6500);
      expect(horizon.maximum.z).toBeGreaterThan(-3500);
      expect(global.getTotalVertices()).toBeLessThan(20000);
    } finally { scene.dispose(); engine.dispose(); }
  });
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
      await prewarmMaterial(result.material, mesh);
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
      const mesh = createPlayMesh(scene, 1, "water", null, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, body);
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
