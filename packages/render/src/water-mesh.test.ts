import { describe, expect, it, vi } from "vitest";
import { ArcRotateCamera, CubeTexture, FreeCamera, type Mesh, MeshBuilder, NullEngine, PBRMaterial, Quaternion, Scene, SphericalPolynomial, Texture, type UniformBuffer, Vector3, VertexBuffer } from "@babylonjs/core";
import {
  createDefaultWaterDefinition, createWaterBlendSample, createWaterWaveOutput, DEFAULT_WATER_BLEND_DISTANCE, evaluateWaterBlend, evaluateWaterVertex,
  normalizeRenderingQuality, normalizeWaterBody, qualityPresetPatch, WaterBlendIndex,
  RENDER_QUALITY_PROFILES, sampleWaterSurface, sampleWaterWaves, waterBankFadeLength, waterHorizontalEnvelope, waterWaveSet,
  type QualityLevel, type WaterBodyProperties, type WaterDefinition,
} from "@babylonslate/core";
import {
  createWaterMesh, sceneWaterSamplesSceneCopy, setSceneWaterTime, setWaterGpuWaves, updateSceneWater, updateWaterMeshBody, updateWaterMeshDefinition,
  waterMeshBody, WATER_BLEND_REFRESH_MS, WATER_FINITE_CELL_BUDGET, WATER_GLOBAL_CELL_BUDGET, WATER_RESTORES_PER_FRAME,
} from "./water-mesh";
import { updateSceneRenderingSettings } from "./render-settings";
import type { WaterMaterialPlugin } from "./water-material";
import { createLandscapeMesh } from "./landscape-mesh";
import { WATER_FIELD_EDGE_RAMP } from "./water-field";
import { applyAssignMesh, applySnapshotToScene, createPlayMesh, createSnapshotSceneBinding } from "./snapshot-apply";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { compileMaterialPlan, prewarmMaterial } from "./material-compiler";
import { buildFloatDdsCubeFixture } from "@babylonslate/test-kit/environment-fixtures";
import { resourceCacheForEngine, type ResourceLease } from "./resource-cache";
import { createSkyboxMesh } from "./skybox";

/** The vertex whose rest point is the component origin (Gerstner waves move it sideways). */
function centreVertex(mesh: Mesh): number {
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
  for (let i = 0; i < uvs.length; i += 2) if (uvs[i] === 0.5 && uvs[i + 1] === 0.5) return i / 2;
  throw new Error("No centre vertex");
}

/**
 * World position of vertex `index` as the built-in vertex shader (`SLATE_WATER_GPU_WAVES`) displaces it: the static rest
 * grid plus the shared CPU reference (`evaluateWaterVertex`) of its uploaded spacing and bank distance.
 */
function gpuVertex(mesh: Mesh, water: WaterDefinition, body: WaterBodyProperties, index: number, time: number): Vector3 {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!, data = mesh.getVerticesData("slateWaterData")!;
  const rest = Vector3.TransformCoordinates(Vector3.FromArray(positions, index * 3), mesh.computeWorldMatrix(true));
  if (body.kind === "global") rest.addInPlace(gridOffset(mesh));
  const out = createWaterWaveOutput(), fade = body.kind === "global" ? 0 : waterBankFadeLength(water, body.waveScale);
  evaluateWaterVertex(waterWaveSet(water), rest.x, rest.z, time, data[index * 4]!, body.waveScale, data[index * 4 + 1]!, fade, 0, 0, out);
  return new Vector3(rest.x + out[1]!, rest.y + out[0]!, rest.z + out[2]!);
}

/**
 * Height of the queried surface under world (x, z) as a mesh vertex `spacing` metres from its neighbours shows it: the
 * shared kernel's inversion with that vertex's filter, which fades only components shorter than the mesh resolves (a
 * physics query keeps them all). Open water and points well inside a body's bank fade, at rest height 0.
 */
const meshSurface = (water: WaterDefinition, body: WaterBodyProperties, x: number, z: number, time: number, spacing: number) =>
  sampleWaterWaves(water, x, z, time, body.waveScale, spacing).height;

const pluginOf = (mesh: Mesh) => (mesh.material as PBRMaterial).pluginManager!.getPlugin<WaterMaterialPlugin>("SlateWater")!;
const setQuality = (scene: Scene, level: QualityLevel, blendDistance?: number) =>
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(level)), ...(blendDistance === undefined ? {} : { water: { blendDistance } }) });
/** Tests of one body's own layout place several bodies in one scene: they keep blending off. */
const noBlending = (scene: Scene) => updateSceneRenderingSettings(scene, { water: { blendDistance: 0 } });

/**
 * World translation the vertex shader adds to the uploaded positions (`slateWaterGridOffset`): a Global grid is uploaded
 * relative to its snapped centre, so its rest points are the positions plus this (the tests' Global meshes are untransformed).
 */
const gridOffset = (mesh: Mesh) => Vector3.FromArray(bindWater(mesh).get("slateWaterGridOffset")!);

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
  const offset = gridOffset(mesh).x;
  for (let i = 0; i < positions.length && (i === 0 || positions[i]! > positions[i - 3]!); i += 3) xs.push(positions[i]! + offset);
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
      const count = mesh.getTotalVertices(), waterData = mesh.getVerticesData("slateWaterData")!;
      const transform = { position: mesh.position, rotation: mesh.rotationQuaternion, scale: mesh.scaling };
      // The built-in shader displaces a static rest grid: its uploaded inputs, through the shared CPU reference, must
      // reproduce the public physics query (not a duplicate wave formula), including the bank fade near the edges.
      const sampled = new Map<number, Vector3>();
      for (let i = 5; i < count - 5; i += 19) {
        if (waterData[i * 4 + 1]! < 0.001) continue;
        const point = gpuVertex(mesh, water, body, i, 1.7);
        const sample = sampleWaterSurface(water, body, point, 1.7, transform);
        expect(sample.found).toBe(true);
        // Within half a millimetre: the uploaded rest grid and bank distances are float32, tens of metres from the
        // origin and stretched threefold here, and the swell warp's bends steepen the slopes those errors ride on.
        expect(Math.abs(sample.height - point.y)).toBeLessThan(5e-4);
        sampled.set(i, point);
      }
      expect(sampled.size).toBeGreaterThan(10);
      // Custom Material water uploads CPU-displaced vertices from the same reference: the two paths draw one surface.
      expect(setWaterGpuWaves(mesh, false)).toBe(true);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!, matrix = mesh.computeWorldMatrix(true);
      for (const [i, expected] of sampled) {
        const point = Vector3.TransformCoordinates(Vector3.FromArray(positions, i * 3), matrix);
        expect(Vector3.Distance(point, expected)).toBeLessThan(1e-4);
      }
      mesh.scaling.setAll(0); updateSceneWater(scene);
      expect(Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!).every(Number.isFinite)).toBe(true);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("keeps Ocean bounds fixed when the camera moves and lets Global Water Volume cover the horizon", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 4, 0), scene);
    camera.maxZ = 1500;
    noBlending(scene);
    try {
      const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 60, length: 40 }, "ocean"));
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 50, length: 30, waveScale: 1 }));
      const global = createWaterMesh(scene, "global", normalizeWaterBody({}, "global"));
      setSceneWaterTime(scene, 4); updateSceneWater(scene);
      // Culling bounds are the authored footprint padded by the wave envelopes (horizontally too, for tilted volumes).
      const reach = waterHorizontalEnvelope(createDefaultWaterDefinition(), 1), bounds = [-30 - reach, 30 + reach, -20 - reach, 20 + reach];
      expect(reach).toBeGreaterThan(0.1);
      const before = ocean.getBoundingInfo().boundingBox;
      for (const [i, value] of [before.minimum.x, before.maximum.x, before.minimum.z, before.maximum.z].entries()) expect(value).toBeCloseTo(bounds[i]!, 5);
      // Gerstner motion fades out at the banks, so the rendered edge stays on the authored footprint.
      const oceanBody = waterMeshBody(ocean)!, oceanWater = createDefaultWaterDefinition();
      let widest = 0;
      for (let i = 0; i < ocean.getTotalVertices(); i++) {
        const vertex = gpuVertex(ocean, oceanWater, oceanBody, i, 4);
        expect(Math.abs(vertex.x)).toBeLessThanOrEqual(30 + 1e-4);
        expect(Math.abs(vertex.z)).toBeLessThanOrEqual(20 + 1e-4);
        widest = Math.max(widest, Math.abs(vertex.x));
      }
      expect(widest).toBeCloseTo(30, 4);
      const lakeGrid = [VertexBuffer.PositionKind, "slateWaterData"].map((kind) => Array.from(lake.getVerticesData(kind)!));
      camera.position.set(10000, 4, -5000); updateSceneWater(scene);
      // Finite water is anchored to the world: the camera neither reshapes its grid nor changes what the shader filters.
      expect([VertexBuffer.PositionKind, "slateWaterData"].map((kind) => Array.from(lake.getVerticesData(kind)!))).toEqual(lakeGrid);
      // Neither the camera nor animated waves change those bounds.
      setSceneWaterTime(scene, 5.5); updateSceneWater(scene);
      const after = ocean.getBoundingInfo().boundingBox;
      for (const [i, value] of [after.minimum.x, after.maximum.x, after.minimum.z, after.maximum.z].entries()) expect(value).toBeCloseTo(bounds[i]!, 5);
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
  it("pads a finite body's culling bounds by the FFT detail band's horizontal bound only while its vertex shader adds the band", () => {
    const engine = new NullEngine();
    Object.assign(engine.getCaps(), { textureFloatRender: true, textureHalfFloatRender: true });
    const scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 4, -20), scene);
    try {
      const water = { ...createDefaultWaterDefinition(), steepness: 0.8 };
      const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 60, length: 40, waveScale: 0.7 }, "ocean"), water);
      const width = () => { const box = ocean.getBoundingInfo().boundingBox; return box.maximum.x - box.minimum.x; };
      const analytic = 60 + 2 * waterHorizontalEnvelope(water, 0.7);
      updateSceneWater(scene);
      // Medium samples no band: the analytic envelope alone.
      expect(width()).toBeCloseTo(analytic, 4);
      // At Ultra the vertex shader adds the band's offset: λ (Steepness at most) times its 4σ height at this Wave Scale,
      // on each side.
      setQuality(scene, "ultra"); updateSceneWater(scene);
      expect(width()).toBeCloseTo(analytic + 2 * 0.8 * waterWaveSet(water).detailHeight * 0.7, 4);
      // CPU-displaced vertices never carry the band, and Medium drops it again.
      setWaterGpuWaves(ocean, false); updateSceneWater(scene);
      expect(width()).toBeCloseTo(analytic, 4);
      setWaterGpuWaves(ocean, true); setQuality(scene, "medium"); updateSceneWater(scene);
      expect(width()).toBeCloseTo(analytic, 4);
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
      // Default Global Water cells are 0.5 m at Mesh Density 1 (the default Medium tier scales them), at the target and
      // at the water nearest the eye alike.
      const cell = 0.5 / RENDER_QUALITY_PROFILES.medium.water.meshDensity;
      expect(gap(30)).toBeLessThanOrEqual(cell + 1e-4);
      expect(gap(camera.position.x + 3)).toBeLessThanOrEqual(cell + 1e-4);
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
  it("draws Play water at the physics water time of the applied snapshot frames, interpolated between them like poses", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const binding = createSnapshotSceneBinding();
    const apply = (frameId: number, previousFrameId: number, alpha: number) =>
      applySnapshotToScene(scene, binding, { frameId, previousFrameId, tickIndex: frameId, alpha, actorCount: 0, actors: [] });
    try {
      setSceneWaterTime(scene, 0);
      const mesh = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 10, length: 10 }));
      const drawnTime = () => { updateSceneWater(scene); return bindWater(mesh).get("slateWaterMotion")![0]; };
      // The worker stepped frame 4's water at 0.15 s and frame 5's at 0.2 s (slomo 0.5 with a 0.1 s step).
      setSceneWaterTime(scene, 0.15, 4); setSceneWaterTime(scene, 0.2, 5);
      apply(5, 4, 1);
      expect(drawnTime()).toBeCloseTo(0.2, 12);
      apply(5, 4, 0.25);
      expect(drawnTime()).toBeCloseTo(0.1625, 12);
      apply(4, 4, 1);
      expect(drawnTime()).toBeCloseTo(0.15, 12);
      // A frame whose water time has not arrived keeps the newest earlier one; the late time applies without a new sample.
      apply(6, 5, 0.5);
      expect(drawnTime()).toBeCloseTo(0.2, 12);
      setSceneWaterTime(scene, 0.25, 6);
      expect(drawnTime()).toBeCloseTo(0.225, 12);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("resamples CPU-displaced waves for an edited definition while the water clock is paused", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    // Half-metre cells resolve every swell component (the mesh filter fades none), so vertices sit on the queried surface.
    const water = createDefaultWaterDefinition(), body = normalizeWaterBody({ width: 10, length: 10, waveScale: 1, resolution: 128 });
    try {
      // Paused where the centre stands well off its rest height (between wave groups it can sit near rest).
      setSceneWaterTime(scene, 1.5);
      const mesh = createWaterMesh(scene, "lake", body, water);
      // The grid's spacing at the centre vertex (the GPU layout stores it; the CPU path filters by the same spacing).
      const spacing = mesh.getVerticesData("slateWaterData")![centreVertex(mesh) * 4]!;
      // Custom Material water (and this parity switch) displaces its vertices on the CPU.
      setWaterGpuWaves(mesh, false);
      updateSceneWater(scene);
      const middle = centreVertex(mesh) * 3, vertex = () => Vector3.FromArray(mesh.getVerticesData(VertexBuffer.PositionKind)!, middle);
      const before = Float32Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
      const edited = { ...water, waveHeight: 1.2 };
      expect(updateWaterMeshDefinition(mesh, edited)).toBe(true);
      // The next frame repeats the paused time. Gerstner waves carry the vertex sideways: the query at its X/Z agrees.
      updateSceneWater(scene);
      const after = vertex();
      expect(after.y).toBeCloseTo(meshSurface(edited, body, after.x, after.z, 1.5, spacing), 4);
      // The whole grid is resampled (one vertex may sit where its wave groups are calm).
      const resampled = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      expect(Math.max(...Array.from(before, (y, i) => i % 3 === 1 ? Math.abs(resampled[i]! - y) : 0))).toBeGreaterThan(0.05);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("applies Water v2 edits in place exactly as a rebuilt surface binds, compiles, bounds and asks for the scene copy", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    // FFT Ocean Detail needs float render targets; Ultra runs every feature an asset can ask for.
    Object.assign(engine.getCaps(), { textureFloatRender: true, textureHalfFloatRender: true });
    try {
      new FreeCamera("camera", new Vector3(0, 5, -10), scene);
      setQuality(scene, "ultra");
      setSceneWaterTime(scene, 2);
      const body = normalizeWaterBody({ width: 12, length: 12, waveScale: 1, resolution: 8 });
      const compiled = async (mesh: Mesh) => {
        const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
        await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
        return subMesh.effect!.defines;
      };
      const shaderInputs = [
        ...Array.from({ length: 8 }, (_, i) => [`slateWaterSwellDir${i}`, `slateWaterSwellAmp${i}`]).flat(), "slateWaterSwellWarp0", "slateWaterSwellWarp1", "slateWaterSwellWarp2",
        "slateWaterSea", "slateWaterSwellInfo", "slateWaterShape", "slateWaterWaves", "slateWaterLook", "slateWaterTerms", "slateWaterMotion",
      ];
      // No scene copy intent, no detail band, Classic waves and no Sparkles to start with.
      let definition: WaterDefinition = { ...createDefaultWaterDefinition(), refraction: 0, objectReflections: false, detailWaves: 0, sparkles: 0 };
      const lake = createWaterMesh(scene, "lake", body, definition);
      const material = lake.material;
      await compiled(lake);
      expect(sceneWaterSamplesSceneCopy(scene, true, true)).toBe(false);
      const edits: Array<Partial<WaterDefinition>> = [
        // Uniform-only fields; Steepness also widens a finite body's culling bounds.
        { steepness: 0.9, colorVariation: 0.1, waveHeight: 1.4 },
        // Wave Model, Peak Sharpness and Wave Seed change the components (uniform-only: both models evaluate eight).
        { waveModel: "ocean", peakSharpness: 6, waveSeed: 42 },
        // Features crossing zero recompile: refraction intent, the planar mirror, the FFT band and Sparkles.
        { refraction: 0.6, objectReflections: true, detailWaves: 0.8, sparkles: 0.5 },
      ];
      for (const edit of edits) {
        definition = { ...definition, ...edit };
        expect(updateWaterMeshDefinition(lake, definition)).toBe(true);
        const rebuilt = createWaterMesh(scene, "rebuilt", body, definition);
        updateSceneWater(scene);
        expect(lake.material).toBe(material);
        expect(await compiled(lake)).toBe(await compiled(rebuilt));
        const live = bindWater(lake), fresh = bindWater(rebuilt);
        for (const name of shaderInputs) expect([name, live.get(name)]).toEqual([name, fresh.get(name)]);
        const bounds = (mesh: Mesh) => [...mesh.getBoundingInfo().boundingBox.minimum.asArray(), ...mesh.getBoundingInfo().boundingBox.maximum.asArray()];
        expect(bounds(lake)).toEqual(bounds(rebuilt).map((value) => expect.closeTo(value, 6)));
        rebuilt.dispose();
      }
      expect(await compiled(lake)).toContain("#define SLATE_WATER_SPARKLES\n");
      // Refraction and Object Reflections now ask for the scene copy; the count leaves with the surface.
      expect(sceneWaterSamplesSceneCopy(scene, true, false)).toBe(true);
      expect(sceneWaterSamplesSceneCopy(scene, false, true)).toBe(true);
      lake.dispose();
      expect(sceneWaterSamplesSceneCopy(scene, true, true)).toBe(false);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("re-tessellates Global Water for a new Wave Length and keeps its terrain field over the landscape and edge ramp", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 4, 0), scene);
    try {
      // A 40 m landscape floor centred on the origin, 4 m under the water.
      createLandscapeMesh(scene, "land", { width: 40, depth: 40, subdivisions: 4, heights: Array.from({ length: 25 }, () => -4) });
      setSceneWaterTime(scene, 1.5);
      // High's Mesh Density 1 resolves every swell component (the mesh filter fades none; Medium's cells fade the
      // shortest a little), so displaced vertices below sit exactly on the queried surface.
      setQuality(scene, "high");
      const water = createDefaultWaterDefinition(), body = normalizeWaterBody({}, "global");
      const ocean = createWaterMesh(scene, "ocean", body, water);
      updateSceneWater(scene);
      const gapAtOrigin = () => { const xs = rowXs(ocean), k = xs.findIndex((x) => x > 0); return xs[k]! - xs[k - 1]!; };
      const fieldMinX = () => bindWater(ocean).get("slateWaterFieldBounds")![0]!;
      // Unbounded water's field covers the landscape plus the larger of the contact range (three Contact Foam Widths,
      // at most 8 m) and the depth ramp past the terrain, and a metre.
      const before = fieldMinX();
      expect(before).toBeLessThanOrEqual(-20 - (WATER_FIELD_EDGE_RAMP + 1));
      // Default Global Water cells are 0.5 m at Mesh Density 1; the quality tier's Mesh Density scales them.
      const cell = 0.5 / RENDER_QUALITY_PROFILES.high.water.meshDensity;
      expect(gapAtOrigin()).toBeCloseTo(cell, 4);
      const edited = { ...water, waveLength: 24, contactFoamWidth: 2.5 };
      expect(updateWaterMeshDefinition(ocean, edited)).toBe(true);
      updateSceneWater(scene);
      // The wider contact range (7.5 m) stays inside the ramp, so the re-measured field keeps its extent.
      expect(fieldMinX()).toBe(before);
      // Cells scale with Wave Length even though the camera-following layout has not moved.
      expect(gapAtOrigin()).toBeCloseTo(2 * cell, 4);
      // Each new rest vertex sits at its own world X/Z with the new cell size as its wave filter and the body's depth
      // and open-water edge, so the vertex shader displaces it onto the queried surface.
      const positions = ocean.getVerticesData(VertexBuffer.PositionKind)!, data = ocean.getVerticesData("slateWaterData")!, offset = gridOffset(ocean);
      let checked = 0;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]! + offset.x, z = positions[i + 2]! + offset.z;
        if (Math.abs(x) > 8 || Math.abs(z) > 8) continue;
        const vertex = i / 3, rendered = gpuVertex(ocean, edited, body, vertex, 1.5);
        expect(rendered.y).toBeCloseTo(meshSurface(edited, body, rendered.x, rendered.z, 1.5, data[vertex * 4]!), 4);
        expect([data[vertex * 4]!, data[vertex * 4 + 1], data[vertex * 4 + 2]]).toEqual([expect.closeTo(2 * cell, 4), 10000, body.depth]);
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
  it("animates built-in water on the GPU from the clock alone, keeps the CPU path for parity, and releases owned resources", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    // Half-metre cells resolve every swell component (the mesh filter fades none), so vertices sit on the queried surface.
    const water = createDefaultWaterDefinition("stylized"), body = normalizeWaterBody({ width: 10, length: 10, waveScale: 1, resolution: 128 });
    try {
      const mesh = createWaterMesh(scene, "lake", body, water);
      const material = mesh.material, plugin = pluginOf(mesh);
      setSceneWaterTime(scene, 2);
      updateSceneWater(scene);
      const middle = centreVertex(mesh);
      // The static rest grid stays put; the shader's clock follows the simulation, so frames upload no vertex data.
      expect(Vector3.FromArray(mesh.getVerticesData(VertexBuffer.PositionKind)!, middle * 3).length()).toBeCloseTo(0, 6);
      expect(plugin.gpuWaves).toBe(true);
      expect(plugin.time).toBe(2);
      const uploads = vi.spyOn(engine, "updateDynamicVertexBuffer");
      setSceneWaterTime(scene, 3); updateSceneWater(scene);
      expect(uploads).not.toHaveBeenCalled();
      expect(plugin.time).toBe(3);
      // Gerstner waves carry the centre vertex sideways; the query at its displaced X/Z finds the same surface.
      const moving = gpuVertex(mesh, water, body, middle, 3), spacing = mesh.getVerticesData("slateWaterData")![middle * 4]!;
      expect(Math.hypot(moving.x, moving.z)).toBeGreaterThan(0.01);
      expect(moving.y).toBeCloseTo(meshSurface(water, body, moving.x, moving.z, 3, spacing), 5);
      // The CPU path displaces and uploads the same vertex, and only when the clock moves.
      setWaterGpuWaves(mesh, false);
      expect(plugin.gpuWaves).toBe(false);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      expect(Vector3.FromArray(positions, middle * 3).subtract(moving).length()).toBeLessThan(1e-5);
      // The built-in shader subtracts this per-vertex offset from the displaced position to find its rest point.
      const offsets = mesh.getVerticesData("slateWaterOffset")!;
      expect(offsets[middle * 2]).toBeCloseTo(positions[middle * 3]!, 5);
      expect(offsets[middle * 2 + 1]).toBeCloseTo(positions[middle * 3 + 2]!, 5);
      uploads.mockClear();
      updateSceneWater(scene);
      expect(uploads).not.toHaveBeenCalled();
      setSceneWaterTime(scene, 4); updateSceneWater(scene);
      expect(uploads).toHaveBeenCalled();
      expect(Math.abs(mesh.getVerticesData(VertexBuffer.PositionKind)![middle * 3 + 1]! - moving.y)).toBeGreaterThan(0.02);
      // A translated CPU-path volume samples its waves at its new world rest points.
      mesh.position.set(-5, 1, 6); updateSceneWater(scene);
      const shifted = Vector3.TransformCoordinates(Vector3.FromArray(mesh.getVerticesData(VertexBuffer.PositionKind)!, middle * 3), mesh.computeWorldMatrix(true));
      expect(shifted.y).toBeCloseTo(mesh.position.y + meshSurface(water, body, shifted.x, shifted.z, 4, spacing), 4);
      mesh.position.setAll(0);
      // Back on the GPU path the grid returns to rest. Moving the volume then uploads nothing (the shader reads world
      // positions and the bounds follow the world matrix), and its waves still agree with world-space queries.
      setWaterGpuWaves(mesh, true); updateSceneWater(scene);
      const moves = vi.spyOn(mesh, "updateVerticesData");
      mesh.position.set(7, 3, -4); updateSceneWater(scene);
      expect(moves).not.toHaveBeenCalled();
      moves.mockRestore();
      const centre = mesh.getBoundingInfo().boundingBox.centerWorld;
      expect(Vector3.Distance(centre, new Vector3(7, 3, -4))).toBeLessThan(1e-4);
      const point = gpuVertex(mesh, water, body, middle, 4);
      const sample = sampleWaterSurface(water, body, point, 4, { position: mesh.position, rotation: Quaternion.Identity(), scale: mesh.scaling });
      expect(sample.found).toBe(true);
      expect(point.y).toBeCloseTo(mesh.position.y + meshSurface(water, body, point.x, point.z, 4, spacing), 5);
      mesh.dispose();
      expect(scene.materials).not.toContain(material);
      // A disposed surface leaves the per-scene set, so later frames never resample it.
      const resample = vi.spyOn(mesh, "updateVerticesData");
      setSceneWaterTime(scene, 5); updateSceneWater(scene);
      expect(resample).not.toHaveBeenCalled();
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });
  it("scales grids with Water Mesh Density within the hard caps and rebuilds them when quality changes", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 4, 0), scene);
    try {
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 60, length: 60, resolution: 64 }));
      const sea = createWaterMesh(scene, "sea", normalizeWaterBody({ width: 2000, length: 2000, resolution: 128 }, "ocean"));
      const global = createWaterMesh(scene, "global", normalizeWaterBody({ resolution: 128 }, "global"));
      const cells = (mesh: Mesh) => Math.sqrt(mesh.getTotalVertices()) - 1;
      const levels: QualityLevel[] = ["low", "medium", "high", "ultra"];
      const sizes = levels.map((level) => {
        // The camera never moves: a quality change alone must rebuild every grid, Global Water included.
        setQuality(scene, level, 0); updateSceneWater(scene);
        return { lake: cells(lake), sea: cells(sea), global: cells(global) };
      });
      // Surface Resolution × density on the 60 m lake: 64 × 0.5 gives 1.5 m cells, 64 × 1.5 gives 0.5 m cells.
      expect(sizes.map((size) => size.lake)).toEqual(levels.map((level) => 60 / (48 / (64 * RENDER_QUALITY_PROFILES[level].water.meshDensity))));
      expect(sizes.map((size) => size.global)).toEqual(levels.map((level) => 128 * RENDER_QUALITY_PROFILES[level].water.meshDensity));
      // The caps hold at the densest tier: Global Water and large finite volumes stop growing there.
      expect(sizes[3]!.global).toBe(WATER_GLOBAL_CELL_BUDGET);
      expect(sizes.every((size) => size.sea === WATER_FINITE_CELL_BUDGET)).toBe(true);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("recentres Global Water as the camera moves by moving a grid offset in the shader and uploading no vertex data", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 4, 0), scene);
    try {
      const global = createWaterMesh(scene, "global", normalizeWaterBody({}, "global"));
      updateSceneWater(scene);
      const kinds = [VertexBuffer.PositionKind, VertexBuffer.NormalKind, "slateWaterData", "slateWaterFlow", "slateWaterBaseNormal", "slateWaterOffset"];
      const buffers = kinds.map((kind) => global.getVertexBuffer(kind)!.getBuffer());
      const count = global.getTotalVertices(), before = Array.from(global.getVerticesData(VertexBuffer.PositionKind)!), offsetBefore = gridOffset(global);
      const created = [vi.spyOn(engine, "createVertexBuffer"), vi.spyOn(engine, "createDynamicVertexBuffer"), vi.spyOn(engine, "createIndexBuffer")];
      const uploads = [vi.spyOn(global, "updateVerticesData"), vi.spyOn(engine, "updateDynamicVertexBuffer")];
      camera.position.x += 7.3; camera.position.z -= 2.1; updateSceneWater(scene);
      // The dense cells follow the eye with no new GPU buffers and no upload at all: the same grid is moved by the shader.
      for (const spy of [...created, ...uploads]) expect(spy).not.toHaveBeenCalled();
      kinds.forEach((kind, i) => expect(global.getVertexBuffer(kind)!.getBuffer()).toBe(buffers[i]));
      expect(global.getTotalVertices()).toBe(count);
      expect(Array.from(global.getVerticesData(VertexBuffer.PositionKind)!)).toEqual(before);
      // The offset moved by whole dense cells to the one nearest the camera's move.
      const offset = gridOffset(global).subtract(offsetBefore), cell = 0.5 / RENDER_QUALITY_PROFILES.medium.water.meshDensity;
      expect([offset.x, offset.z]).toEqual([expect.closeTo(Math.round(7.3 / cell) * cell, 4), expect.closeTo(Math.round(-2.1 / cell) * cell, 4)]);
      const xs = rowXs(global), k = xs.findIndex((value) => value > camera.position.x);
      expect(xs[k]! - xs[k - 1]!).toBeLessThanOrEqual(cell + 1e-4);
      // The recentred grid draws exactly what a grid built at this camera position draws: the same rest points (the
      // uploaded lines plus the offset), the same static shader inputs (to float32 precision of the kilometre-wide outer
      // cells) and the same culling bounds.
      for (const spy of uploads) spy.mockRestore();
      const fresh = createWaterMesh(scene, "fresh", normalizeWaterBody({}, "global"));
      const freshOffset = gridOffset(fresh);
      expect([offset.x + offsetBefore.x, offset.z + offsetBefore.z]).toEqual([expect.closeTo(freshOffset.x, 4), expect.closeTo(freshOffset.z, 4)]);
      for (const kind of kinds) {
        const a = global.getVerticesData(kind)!, b = fresh.getVerticesData(kind)!;
        expect(a.length).toBe(b.length);
        let worst = 0;
        for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!) / Math.max(1, Math.abs(b[i]!)));
        expect(worst, kind).toBeLessThan(1e-5);
      }
      const box = global.getBoundingInfo().boundingBox, expected = fresh.getBoundingInfo().boundingBox;
      expect(Vector3.Distance(box.minimumWorld, expected.minimumWorld)).toBeLessThan(1e-3);
      expect(Vector3.Distance(box.maximumWorld, expected.maximumWorld)).toBeLessThan(1e-3);
      // A longer view distance widens the grid: that builds a new one.
      camera.maxZ = 4000; updateSceneWater(scene);
      expect(created[1]).toHaveBeenCalled();
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });
  it("pauses CPU vertex work for surfaces out of view and resumes it in the frame they come back", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 5, -20), scene);
    camera.setTarget(Vector3.Zero());
    try {
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 10, length: 10, waveScale: 1, resolution: 8 }));
      setWaterGpuWaves(lake, false);
      setSceneWaterTime(scene, 2); updateSceneWater(scene);
      camera.setTarget(new Vector3(0, 5, -60));
      // Nothing draws it in this headless scene, and the camera looks away: the next steps skip its vertices.
      updateSceneWater(scene);
      const uploads = vi.spyOn(lake, "updateVerticesData");
      setSceneWaterTime(scene, 3); updateSceneWater(scene);
      expect(uploads).not.toHaveBeenCalled();
      camera.setTarget(Vector3.Zero());
      updateSceneWater(scene);
      expect(uploads).toHaveBeenCalled();
      expect(lake.getVerticesData("slateWaterData")![centreVertex(lake) * 4 + 3]).toBe(3);
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });
  it("gives back a disabled body's terrain and contact textures after a while and rebuilds them when it returns", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 5, -20), scene);
    camera.setTarget(Vector3.Zero());
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      createLandscapeMesh(scene, "land", { width: 40, depth: 40, subdivisions: 4, heights: Array.from({ length: 25 }, () => -4) });
      MeshBuilder.CreateBox("post", { width: 1, height: 4, depth: 1 }, scene);
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 10, length: 10 }));
      const plugin = pluginOf(lake);
      updateSceneWater(scene);
      expect([plugin.field!.texture, plugin.contacts!.texture]).not.toContain(null);
      lake.setEnabled(false);
      updateSceneWater(scene);
      clock += 1000; updateSceneWater(scene);
      // A brief toggle keeps them.
      expect([plugin.field!.texture, plugin.contacts!.texture]).not.toContain(null);
      clock += 1500; updateSceneWater(scene);
      expect([plugin.field!.texture, plugin.contacts!.texture]).toEqual([null, null]);
      lake.setEnabled(true);
      clock += 16; updateSceneWater(scene);
      expect([plugin.field!.texture, plugin.contacts!.texture]).not.toContain(null);
      // Many bodies returning in one frame (a streamed-in section) rebuild a few at a time, the rest in later frames.
      noBlending(scene);
      const more = [0, 1, 2, 3].map((i) => createWaterMesh(scene, `pond ${i}`, normalizeWaterBody({ width: 4, length: 4 })));
      more.forEach((mesh, i) => mesh.position.set(-12 + i * 6, 0, 8));
      const all = [lake, ...more], plugins = all.map(pluginOf);
      clock += 16; updateSceneWater(scene);
      for (const mesh of all) mesh.setEnabled(false);
      clock += 16; updateSceneWater(scene);
      clock += 2500; updateSceneWater(scene);
      expect(plugins.every((p) => p.field!.texture === null)).toBe(true);
      for (const mesh of all) mesh.setEnabled(true);
      const restored = () => plugins.filter((p) => p.field!.texture !== null).length;
      clock += 16; updateSceneWater(scene);
      expect(restored()).toBe(WATER_RESTORES_PER_FRAME);
      for (let frame = 0; frame < 3; frame++) { clock += 16; updateSceneWater(scene); }
      expect(restored()).toBe(all.length);
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
  it("blends overlapping lakes into one owned surface with the shared kernel's rest height, and stops when blending is off", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 30, -40), scene);
    try {
      const a = createWaterMesh(scene, "a", normalizeWaterBody({ width: 24, length: 24, waveScale: 0.3, resolution: 24 }));
      const b = createWaterMesh(scene, "b", normalizeWaterBody({ width: 24, length: 24, waveScale: 0.9, resolution: 24 }));
      const far = createWaterMesh(scene, "far", normalizeWaterBody({ width: 10, length: 10, resolution: 8 }));
      b.position.set(16, 0.5, 0); far.position.set(200, 0, 0);
      updateSceneWater(scene);
      expect([a, b, far].map((mesh) => [pluginOf(mesh).blend, mesh.isVerticesDataPresent("slateWaterBlend")])).toEqual([[true, true], [true, true], [false, false]]);
      // Each vertex carries the shared kernel's blended surface: rest height, union shoreline and ownership.
      const bodies = [a, b].map((mesh) => ({ definition: createDefaultWaterDefinition(), body: waterMeshBody(mesh)! as WaterBodyProperties, transform: {
        position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 },
      } }));
      const index = new WaterBlendIndex();
      index.update(bodies, DEFAULT_WATER_BLEND_DISTANCE);
      const sample = createWaterBlendSample();
      let owned = 0, seam = 0;
      for (const [self, mesh] of [a, b].entries()) {
        const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!, data = mesh.getVerticesData("slateWaterData")!, blend = mesh.getVerticesData("slateWaterBlend")!;
        const world = mesh.computeWorldMatrix(true);
        for (let v = 0; v < positions.length / 3; v++) {
          const point = Vector3.TransformCoordinates(Vector3.FromArray(positions, v * 3), world);
          // No water of this body here: the fragment discards (outside the union or not owned).
          if (!evaluateWaterBlend(index, self, point.x, point.y, point.z, sample)) { expect(Math.min(data[v * 4 + 1]!, blend[v * 4 + 2]!)).toBeLessThan(0); continue; }
          expect(point.y).toBeCloseTo(sample.restHeight, 4);
          // The union shoreline (only its sign matters past it, where the fragment discards).
          expect(Math.max(data[v * 4 + 1]!, 0)).toBeCloseTo(Math.max(sample.union, 0), 4);
          expect(blend[v * 4]! * waterMeshBody(mesh)!.waveScale).toBeCloseTo(sample.heightScale * waterMeshBody(mesh)!.waveScale, 5);
          // The margin is stored in metres (`blendNormals`): the same owner, the same sign.
          expect(Math.sign(blend[v * 4 + 2]!)).toBe(Math.sign(sample.margin));
          if (sample.margin >= 0) owned++;
          if (point.x > 6 && point.x < 10) seam++;
        }
      }
      // Both lakes reach into the 8 m overlap, and the seam region is covered.
      expect(seam).toBeGreaterThan(4);
      expect(owned).toBeGreaterThan(0);
      updateSceneRenderingSettings(scene, { water: { blendDistance: 0 } }); updateSceneWater(scene);
      expect([a, b].map((mesh) => [pluginOf(mesh).blend, mesh.isVerticesDataPresent("slateWaterBlend")])).toEqual([[false, false], [false, false]]);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("keeps Global Water's blend data on the world as its grid recentres under a moving camera", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 10, -30), scene);
    try {
      const sea = createWaterMesh(scene, "sea", normalizeWaterBody({ resolution: 48 }, "global"));
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 20, length: 20, resolution: 16 }));
      lake.position.y = 0.2;
      updateSceneWater(scene);
      const definition = createDefaultWaterDefinition(), index = new WaterBlendIndex(), sample = createWaterBlendSample();
      index.update([sea, lake].map((mesh) => ({ definition, body: waterMeshBody(mesh)! as WaterBodyProperties, transform: {
        position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 },
      } })), DEFAULT_WATER_BLEND_DISTANCE);
      const check = () => {
        const positions = sea.getVerticesData(VertexBuffer.PositionKind)!, blend = sea.getVerticesData("slateWaterBlend")!, offset = gridOffset(sea);
        let inside = 0;
        for (let v = 0; v < positions.length / 3; v++) {
          const x = positions[v * 3]! + offset.x, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]! + offset.z;
          expect(evaluateWaterBlend(index, 0, x, 0, z, sample)).toBe(true);
          expect(y).toBeCloseTo(sample.restHeight, 4);
          // The margin is stored in metres (`blendNormals`): the same owner, the same sign.
          expect(Math.sign(blend[v * 4 + 2]!)).toBe(Math.sign(sample.margin));
          if (sample.margin < 0) inside++;
        }
        return inside;
      };
      // The lake owns its middle, wherever the ocean's grid lines fall.
      expect(check()).toBeGreaterThan(4);
      camera.position.x += 7.3; camera.position.z += 3.1;
      updateSceneWater(scene);
      expect(check()).toBeGreaterThan(4);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("recentres a blending Global grid by rewriting only the rows near its neighbours, in place", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 10, -30), scene);
    try {
      const sea = createWaterMesh(scene, "sea", normalizeWaterBody({ resolution: 48 }, "global"));
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 20, length: 20, resolution: 16 }));
      lake.position.y = 0.2;
      updateSceneWater(scene);
      const count = sea.getTotalVertices();
      const meshUploads = vi.spyOn(sea, "updateVerticesData"), rangeUploads = vi.spyOn(engine, "updateDynamicVertexBuffer");
      camera.position.x += 7.3; camera.position.z += 3.1;
      updateSceneWater(scene);
      // The moved grid is the shader's offset: nothing is uploaded whole, and every attribute (the lifted positions
      // included) only over the rows near the lake.
      expect(meshUploads).not.toHaveBeenCalled();
      const partial = rangeUploads.mock.calls.filter(([, , offset]) => offset !== undefined);
      expect(partial.length).toBe(6);
      for (const [, data] of partial) expect((data as Float32Array).length).toBeLessThan(count);
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });
  it("keeps a moving body's neighbours on their last blend data between refreshes, and lands the final pose", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 30, -40), scene);
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const a = createWaterMesh(scene, "a", normalizeWaterBody({ width: 24, length: 24, resolution: 16 }));
      const b = createWaterMesh(scene, "b", normalizeWaterBody({ width: 24, length: 24, resolution: 16 }));
      b.position.set(18, 0.1, 0);
      updateSceneWater(scene);
      const refreshes = vi.spyOn(a, "updateVerticesData");
      const blendUploads = () => refreshes.mock.calls.filter(([kind]) => kind === "slateWaterBlend").length;
      // Dragged every frame for half a second at 60 frames per second: a few refreshes, not thirty.
      for (let frame = 0; frame < 30; frame++) { clock += 1000 / 60; b.position.x -= 0.02; updateSceneWater(scene); }
      expect(blendUploads()).toBeGreaterThan(0);
      expect(blendUploads()).toBeLessThanOrEqual(Math.ceil(500 / WATER_BLEND_REFRESH_MS));
      // Once it stops, the next refresh lands on the final pose: the same data a fresh pass computes.
      const settled = blendUploads();
      for (let frame = 0; frame < 20; frame++) { clock += 1000 / 60; updateSceneWater(scene); }
      expect(blendUploads()).toBe(settled + 1);
      const current = Array.from(a.getVerticesData("slateWaterBlend")!);
      updateWaterMeshBody(a, waterMeshBody(a)!);
      updateSceneWater(scene);
      const fresh = a.getVerticesData("slateWaterBlend")!;
      expect(current.every((value, i) => Math.abs(value - fresh[i]!) < 1e-5)).toBe(true);
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });
  it("discovers blending neighbours only when a body, the distance or the set of surfaces changes", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 30, -40), scene);
    const update = vi.spyOn(WaterBlendIndex.prototype, "update");
    try {
      const a = createWaterMesh(scene, "a", normalizeWaterBody({ width: 20, length: 20, resolution: 8 }));
      updateSceneWater(scene); updateSceneWater(scene);
      // One body: nothing to blend, no index.
      expect(update).not.toHaveBeenCalled();
      const b = createWaterMesh(scene, "b", normalizeWaterBody({ width: 20, length: 20, resolution: 8 }));
      b.position.x = 50;
      for (let frame = 0; frame < 5; frame++) { setSceneWaterTime(scene, frame); updateSceneWater(scene); }
      expect(update).toHaveBeenCalledTimes(1);
      expect(pluginOf(a).blend).toBe(false);
      // Moving a body into range rebuilds once; still frames rebuild nothing.
      b.position.x = 22;
      for (let frame = 0; frame < 5; frame++) { setSceneWaterTime(scene, 5 + frame); updateSceneWater(scene); }
      expect(update).toHaveBeenCalledTimes(2);
      expect([pluginOf(a).blend, pluginOf(b).blend]).toEqual([true, true]);
      updateWaterMeshBody(b, { ...waterMeshBody(b)!, width: 4, length: 4 });
      updateSceneWater(scene);
      expect(update).toHaveBeenCalledTimes(3);
      expect([pluginOf(a).blend, pluginOf(b).blend]).toEqual([false, false]);
    } finally { update.mockRestore(); scene.dispose(); engine.dispose(); }
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
