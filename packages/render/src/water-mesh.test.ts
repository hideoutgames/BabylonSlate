import { describe, expect, it, vi } from "vitest";
import { ArcRotateCamera, CubeTexture, FreeCamera, type Mesh, MeshBuilder, NullEngine, PBRMaterial, Quaternion, Scene, SphericalPolynomial, Texture, type UniformBuffer, Vector3, VertexBuffer } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody, sampleWaterSurface, type WaterDefinition } from "@babylonslate/core";
import { createWaterMesh, setSceneWaterTime, updateSceneWater, updateWaterMeshBody, updateWaterMeshDefinition, waterMeshBody } from "./water-mesh";
import type { WaterMaterialPlugin } from "./water-material";
import { createLandscapeMesh } from "./landscape-mesh";
import { applyAssignMesh, createPlayMesh, createSnapshotSceneBinding } from "./snapshot-apply";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { compileMaterialPlan, prewarmMaterial } from "./material-compiler";
import { buildFloatDdsCubeFixture } from "@babylonslate/test-kit/environment-fixtures";
import { resourceCacheForEngine, type ResourceLease } from "./resource-cache";
import { createSkyboxMesh } from "./skybox";

/** The vertex over the component origin; vertical waves never move it sideways. */
function centreVertex(mesh: Mesh): number {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < positions.length; i += 3) if (Math.hypot(positions[i]!, positions[i + 2]!) < 1e-6) return i / 3;
  throw new Error("No centre vertex");
}

/** Bind the built-in surface's shader inputs through its real material plugin; record the uploaded vectors. */
function bindWater(mesh: Mesh): Map<string, number[]> {
  const vectors = new Map<string, number[]>();
  const buffer = { updateFloat4: (name: string, ...values: number[]) => vectors.set(name, values), updateMatrix: () => {} } as unknown as UniformBuffer;
  (mesh.material as PBRMaterial).pluginManager!.getPlugin<WaterMaterialPlugin>("SlateWater")!.hardBindForSubMesh(buffer, mesh.getScene());
  return vectors;
}

/** X coordinates of the first grid row, in order. */
function rowXs(mesh: Mesh): number[] {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!, xs: number[] = [];
  for (let i = 0; i < positions.length && (i === 0 || positions[i]! > positions[i - 3]!); i += 3) xs.push(positions[i]!);
  return xs;
}

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
      setSceneWaterTime(scene, 1.7);
      const mesh = createWaterMesh(scene, "ocean", body, water), initialVertices = mesh.getTotalVertices();
      mesh.position.set(7, 3, -4); mesh.scaling.set(-3, 4, 2);
      mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.2, 0.12, -0.05);
      updateSceneWater(scene);
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
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 50, length: 30, waveScale: 1 }));
      const global = createWaterMesh(scene, "global", normalizeWaterBody({}, "global"));
      setSceneWaterTime(scene, 4); updateSceneWater(scene);
      const before = ocean.getBoundingInfo().boundingBox;
      expect([before.minimum.x, before.maximum.x, before.minimum.z, before.maximum.z]).toEqual([-30, 30, -20, 20]);
      const lakeSurface = Array.from(lake.getVerticesData(VertexBuffer.PositionKind)!);
      camera.position.set(10000, 4, -5000); updateSceneWater(scene);
      // Finite water is anchored to the world: the camera neither reshapes nor flattens its waves.
      expect(Array.from(lake.getVerticesData(VertexBuffer.PositionKind)!)).toEqual(lakeSurface);
      const after = ocean.getBoundingInfo().boundingBox;
      expect([after.minimum.x, after.maximum.x, after.minimum.z, after.maximum.z]).toEqual([-30, 30, -20, 20]);
      const horizon = global.getBoundingInfo().boundingBox;
      expect(horizon.minimum.x).toBeLessThan(8500);
      expect(horizon.maximum.x).toBeGreaterThan(11500);
      expect(horizon.minimum.z).toBeLessThan(-6500);
      expect(horizon.maximum.z).toBeGreaterThan(-3500);
      expect(global.getTotalVertices()).toBeLessThan(20000);
      camera.maxZ = 3000; updateSceneWater(scene);
      const expanded = global.getBoundingInfo().boundingBox;
      expect(expanded.maximum.x - expanded.minimum.x).toBeCloseTo(7200, 3);
      expect(expanded.maximum.z - expanded.minimum.z).toBeCloseTo(7200, 3);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("keeps Global Water's fine wave cells under an orbit camera's target as well as near its eye", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    // The eye stands about 20 m from the target horizontally, beyond the dense cells' half width around the eye.
    const camera = new ArcRotateCamera("orbit", Math.PI, 1.2, 22, new Vector3(30, 0, 0), scene);
    camera.getViewMatrix(true);
    try {
      const global = createWaterMesh(scene, "global", normalizeWaterBody({}, "global"));
      updateSceneWater(scene);
      const xs = rowXs(global);
      const gap = (x: number) => { const k = xs.findIndex((value) => value > x); return xs[k]! - xs[k - 1]!; };
      // Default Global Water cells are 0.5 m, at the target and at the water nearest the eye alike.
      expect(gap(30)).toBeLessThanOrEqual(0.5 + 1e-4);
      expect(gap(camera.position.x + 3)).toBeLessThanOrEqual(0.5 + 1e-4);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("applies an edited definition to a built surface in place and refuses edits that need a rebuild", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      // A post crossing the lake gives it a contact field, whose range the shader then reads.
      MeshBuilder.CreateBox("post", { width: 1, height: 6, depth: 1 }, scene).position.set(6, 0, 0);
      scene.incrementRenderId();
      const water = createDefaultWaterDefinition();
      const mesh = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 30, waveScale: 1 }), water);
      const material = mesh.material as PBRMaterial;
      // Default Contact Foam Width 1.2 m: distances clamp at three widths.
      expect(bindWater(mesh).get("slateWaterContactInfo")!.slice(0, 2)).toEqual([1, expect.closeTo(3.6, 6)]);
      const edited: WaterDefinition = { ...water, shallowColor: [1, 0, 0], roughness: 0.5, reflectionStrength: 0.25, foamAmount: 0.2, crestFoam: 0.8, contactFoamWidth: 2.5 };
      expect(updateWaterMeshDefinition(mesh, edited)).toBe(true);
      expect(mesh.material).toBe(material);
      expect([material.roughness, material.environmentIntensity]).toEqual([0.5, 0.25]);
      const vectors = bindWater(mesh);
      expect(vectors.get("slateWaterShallow")).toEqual([1, 0, 0, water.opacity]);
      expect(vectors.get("slateWaterFoam")![3]).toBe(0.2);
      expect(vectors.get("slateWaterShape")).toEqual([water.choppiness, water.waveSpread, 0.8, 2.5]);
      expect(vectors.get("slateWaterContactInfo")!.slice(0, 2)).toEqual([1, 7.5]);
      // Style compiles into the shader and a Custom Material replaces it: those edits change nothing here.
      expect(updateWaterMeshDefinition(mesh, { ...edited, style: "stylized", roughness: 0.9 })).toBe(false);
      expect(updateWaterMeshDefinition(mesh, { ...edited, materialGuid: "custom", roughness: 0.9 })).toBe(false);
      expect(material.roughness).toBe(0.5);
      expect(updateWaterMeshDefinition(MeshBuilder.CreateBox("box", {}, scene), edited)).toBe(false);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("resamples waves for an edited definition while the water clock is paused", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const water = createDefaultWaterDefinition(), body = normalizeWaterBody({ width: 10, length: 10, waveScale: 1, resolution: 8 });
    try {
      setSceneWaterTime(scene, 2);
      const mesh = createWaterMesh(scene, "lake", body, water);
      updateSceneWater(scene);
      const middle = centreVertex(mesh) * 3, height = () => mesh.getVerticesData(VertexBuffer.PositionKind)![middle + 1]!;
      const before = height();
      const edited = { ...water, waveHeight: 1.2 };
      expect(updateWaterMeshDefinition(mesh, edited)).toBe(true);
      // The next frame repeats the paused time.
      updateSceneWater(scene);
      expect(height()).toBeCloseTo(sampleWaterSurface(edited, body, { x: 0, y: 0, z: 0 }, 2).height, 5);
      expect(Math.abs(height() - before)).toBeGreaterThan(0.05);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("re-tessellates Global Water for a new Wave Length and widens its terrain field for a new Contact Foam Width", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 4, 0), scene);
    try {
      // A 40 m landscape floor centred on the origin, 4 m under the water.
      createLandscapeMesh(scene, "land", { width: 40, depth: 40, subdivisions: 4, heights: Array.from({ length: 25 }, () => -4) });
      setSceneWaterTime(scene, 1.5);
      const water = createDefaultWaterDefinition(), body = normalizeWaterBody({}, "global");
      const ocean = createWaterMesh(scene, "ocean", body, water);
      updateSceneWater(scene);
      const gapAtOrigin = () => { const xs = rowXs(ocean), k = xs.findIndex((x) => x > 0); return xs[k]! - xs[k - 1]!; };
      const fieldMinX = () => bindWater(ocean).get("slateWaterFieldBounds")![0]!;
      // The field covers the landscape plus the contact range (three Contact Foam Widths) and a metre.
      expect(fieldMinX()).toBeGreaterThan(-20 - (2.5 * 3 + 1));
      expect(gapAtOrigin()).toBeCloseTo(0.5, 4);
      const edited = { ...water, waveLength: 24, contactFoamWidth: 2.5 };
      expect(updateWaterMeshDefinition(ocean, edited)).toBe(true);
      updateSceneWater(scene);
      expect(fieldMinX()).toBeLessThanOrEqual(-20 - (2.5 * 3 + 1));
      // Cells scale with Wave Length even though the camera-following layout has not moved.
      expect(gapAtOrigin()).toBeCloseTo(1, 4);
      // Each new vertex samples the waves at its own world X/Z and carries the body's depth and open-water edge.
      const positions = ocean.getVerticesData(VertexBuffer.PositionKind)!, data = ocean.getVerticesData("slateWaterData")!;
      let checked = 0;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]!, z = positions[i + 2]!;
        if (Math.abs(x) > 6 || Math.abs(z) > 6) continue;
        expect(positions[i + 1]).toBeCloseTo(sampleWaterSurface(edited, body, { x, y: 0, z }, 1.5).height, 4);
        expect([data[i / 3 * 4 + 1], data[i / 3 * 4 + 2]]).toEqual([10000, body.depth]);
        checked++;
      }
      expect(checked).toBeGreaterThan(100);
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
      const mesh = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), { ...createDefaultWaterDefinition(), waveHeight: 0 }, result.material);
      await prewarmMaterial(result.material, mesh);
      const data = mesh.getVerticesData("slateWaterData")!;
      expect(data[1]).toBeCloseTo(0);
      expect(data[centreVertex(mesh) * 4 + 1]).toBeCloseTo(15);
      setSceneWaterTime(scene, 2.5); updateSceneWater(scene);
      expect(mesh.getVerticesData("slateWaterData")![centreVertex(mesh) * 4 + 3]).toBeCloseTo(2.5);
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
      const middle = centreVertex(mesh) * 3;
      const height = positions[middle + 1]!;
      expect(height).toBeCloseTo(sampleWaterSurface(water, body, { x: 0, y: 0, z: 0 }, 2).height, 5);
      const uploads = vi.spyOn(engine, "updateDynamicVertexBuffer");
      updateSceneWater(scene);
      expect(uploads).not.toHaveBeenCalled();
      setSceneWaterTime(scene, 3);
      updateSceneWater(scene);
      expect(uploads).toHaveBeenCalled();
      expect(Math.abs(mesh.getVerticesData(VertexBuffer.PositionKind)![middle + 1]! - height)).toBeGreaterThan(0.05);
      mesh.position.set(7, 3, -4); updateSceneWater(scene);
      const point = Vector3.TransformCoordinates(Vector3.FromArray(mesh.getVerticesData(VertexBuffer.PositionKind)!, middle), mesh.computeWorldMatrix(true));
      const sample = sampleWaterSurface(water, body, point, 3, { position: mesh.position, rotation: Quaternion.Identity(), scale: mesh.scaling });
      expect(sample.found).toBe(true);
      expect(point.y).toBeCloseTo(sample.height, 5);
      mesh.dispose();
      expect(scene.materials).not.toContain(material);
      // A disposed surface leaves the per-scene set, so later frames never resample it.
      const resample = vi.spyOn(mesh, "updateVerticesData");
      setSceneWaterTime(scene, 4); updateSceneWater(scene);
      expect(resample).not.toHaveBeenCalled();
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });
  it("fills a curved, widening river inside its query footprint and reshapes it live", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const water = { ...createDefaultWaterDefinition(), waveHeight: 0 };
    const body = normalizeWaterBody({ width: 3, points: [[0, 0, 0], [0, 0, 20], [20, -1, 20]], widthScales: [1, 1, 3] }, "river");
    try {
      const mesh = createWaterMesh(scene, "river", body, water);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      for (let i = 0; i < positions.length; i += 3) {
        const sample = sampleWaterSurface(water, body, { x: positions[i]!, y: positions[i + 1]! - 1, z: positions[i + 2]! }, 0);
        expect(sample.found).toBe(true);
        expect(sample.height).toBeCloseTo(positions[i + 1]!, 3);
      }
      const box = mesh.getBoundingInfo().boundingBox;
      // The downstream end is three times as wide and capped with a half-disc.
      expect(box.maximum.x).toBeCloseTo(24.5, 1);
      expect(box.maximum.z).toBeCloseTo(24.5, 1);
      expect(updateWaterMeshBody(mesh, { ...body, points: [[0, 0, 0], [0, 0, 40]] })).toBe(true);
      expect(waterMeshBody(mesh)?.points).toEqual([[0, 0, 0], [0, 0, 40]]);
      expect(mesh.getBoundingInfo().boundingBox.maximum.z).toBeCloseTo(41.5, 1);
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
