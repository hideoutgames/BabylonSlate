import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Color3,
  DirectionalLight,
  FreeCamera,
  HemisphericLight,
  InternalTexture,
  InternalTextureSource,
  MeshBuilder,
  NullEngine,
  PointLight,
  RectAreaLight,
  Scene,
  ShadowGenerator,
  SpotLight,
  Vector3,
  type Mesh,
  type NodeMaterial,
} from "@babylonjs/core";
import type { AreaEmissionPixels } from "@haptic/assets";
import { normalizeRenderingQuality, qualityPresetPatch } from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { areaEmissionTexture, setRectLightEmission, syncAreaEmissionLayers } from "./area-emission-array";
import { retainAreaLightLookup } from "./area-light-resources";
import { CelLightBlock } from "./cel-light-block";
import { HapticLightingBlock } from "./haptic-lighting-block";
import { HAPTIC_LIGHT_MAXIMUM, hapticLightBuffer, setHapticLighting } from "./haptic-lights";
import { isForwardLightExcluded } from "./light-policy";
import { updateSceneRenderingSettings } from "./render-settings";
import { compileMaterialPlan } from "./material-compiler";
import { setSceneRenderSettings } from "./scene-render-mode";
import { sceneLightingLimits, syncSceneLighting } from "./scene-lighting";
import { ScenePbrLightingBlock } from "./scene-pbr-lighting-block";
import { createPreviewLighting } from "./preview-lighting";
import { createAtlasCascadedShadowGenerator, createAtlasShadowGenerator, shadowAtlasTexture } from "./shadow-atlas";
import { shadowAllocationCheckpoint } from "./shadow-map-factory";

/** An atlas edge for the tests that place tiles themselves. */
const EDGE = 2048;

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A NullEngine Scene that reports uniform buffers, as WebGL2 does, and makes the texture arrays and depth textures it cannot. */
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
  vi.spyOn(engine, "createRawTexture2DArray").mockImplementation(() => new InternalTexture(engine, InternalTextureSource.Raw2DArray));
  vi.spyOn(engine, "createDepthStencilTexture").mockImplementation(() => new InternalTexture(engine, InternalTextureSource.DepthStencil));
  const scene = new Scene(engine);
  new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  return { engine, scene };
}

async function litBox(scene: Scene): Promise<{ mesh: Mesh; material: NodeMaterial }> {
  const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
  if (!lowered.ok) throw new Error("Invalid fixture");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "lit" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  mesh.material = compiled.material;
  return { mesh, material: compiled.material };
}

/** The defines of the Effect `material` draws `mesh` with, after a lighting sync and a frame. */
async function drawnDefines(scene: Scene, mesh: Mesh, material: NodeMaterial): Promise<string[]> {
  syncSceneLighting(scene);
  await material.forceCompilationAsync(mesh);
  scene.render();
  expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
  return mesh.subMeshes[0]!.effect!.defines.split("\n").filter((line) => /HAPTIC_|#define LIGHT\d|SPECULARTERM|MAXLIGHTCOUNT/.test(line));
}

describe("HapticLightingBlock and the HapticLights block", () => {
  it("lights PBR graphs from the light block, with no light define, so no light change recompiles them", async () => {
    const { engine, scene } = host();
    new PointLight("lamp", new Vector3(0, 2, 0), scene);
    setHapticLighting(engine, true);
    const { mesh, material } = await litBox(scene);
    expect(material.attachedBlocks.some((block) => block instanceof HapticLightingBlock)).toBe(true);
    expect(material.attachedBlocks.some((block) => block instanceof ScenePbrLightingBlock)).toBe(false);
    const defines = await drawnDefines(scene, mesh, material);
    expect(defines.some((line) => /#define LIGHT\d/.test(line))).toBe(false);
    expect(material.compiledShaders).toContain("uniform HapticLights");
    const effect = mesh.subMeshes[0]!.effect;
    // Lights arriving, leaving and switching keep the Effect.
    new SpotLight("spot", new Vector3(1, 3, 0), Vector3.Down(), Math.PI / 3, 2, scene);
    new DirectionalLight("sun", new Vector3(0, -1, 0), scene);
    scene.lights[0]!.setEnabled(false);
    expect(await drawnDefines(scene, mesh, material)).toEqual(defines);
    expect(mesh.subMeshes[0]!.effect).toBe(effect);
  });

  it("draws CEL as a define of the same graph, which a render-mode change re-prepares even when frozen", async () => {
    const { engine, scene } = host();
    new PointLight("lamp", new Vector3(0, 2, 0), scene);
    setHapticLighting(engine, true);
    setSceneRenderSettings(scene, { mode: "cel" });
    const { mesh, material } = await litBox(scene);
    const lighting = material.attachedBlocks.find((block) => block instanceof HapticLightingBlock);
    expect(lighting).toBeDefined();
    expect(material.attachedBlocks.some((block) => block instanceof CelLightBlock)).toBe(false);
    const cel = await drawnDefines(scene, mesh, material);
    expect(cel).toContain("#define HAPTIC_CEL");
    expect(cel.some((line) => /#define (LIGHT\d|HAPTIC_ENVIRONMENT)/.test(line))).toBe(false);
    expect(material.compiledShaders).toContain("slateCelBand");
    // Frozen and drawn, as the editor holds library Materials: only a dirty mark re-prepares its defines.
    material.freeze();
    expect(await drawnDefines(scene, mesh, material)).toEqual(cel);
    setSceneRenderSettings(scene, { mode: "pbr" });
    expect(await drawnDefines(scene, mesh, material)).not.toContain("#define HAPTIC_CEL");
    expect(material.attachedBlocks.find((block) => block instanceof HapticLightingBlock)).toBe(lighting);
  });

  it("binds every texture a program declares, as WebGPU needs: the split-sum table in both modes, the cube only where declared", async () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    const { mesh, material } = await litBox(scene);
    // A Scene without an environment cube compiles no cube sampler.
    expect(material.compiledShaders).toMatch(/#if defined\(HAPTIC_ENVIRONMENT\)\s+uniform samplerCube hapticEnvironmentSampler;/);
    for (const mode of ["pbr", "cel"] as const) {
      setSceneRenderSettings(scene, { mode });
      await drawnDefines(scene, mesh, material);
      const effect = mesh.subMeshes[0]!.effect!, bound: string[] = [];
      vi.spyOn(effect, "setTexture").mockImplementation((name) => { bound.push(name); });
      material.bindForSubMesh(mesh.computeWorldMatrix(true), mesh, mesh.subMeshes[0]!);
      expect(bound, mode).toEqual(expect.arrayContaining(["hapticEnvironmentBrdfSampler", "hapticAreaLtc1Sampler", "hapticAreaLtc2Sampler", "hapticAreaEmissionSampler"]));
      expect(bound, mode).not.toContain("hapticEnvironmentSampler");
    }
  });

  it("binds the shadow atlas to every draw, and whether the drawn mesh receives shadows", async () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    const { mesh, material } = await litBox(scene);
    await drawnDefines(scene, mesh, material);
    const effect = mesh.subMeshes[0]!.effect!, atlases: unknown[] = [], receivers: number[] = [];
    vi.spyOn(effect, "setDepthStencilTexture").mockImplementation((_name, texture) => { atlases.push(texture); });
    vi.spyOn(effect, "setFloat").mockImplementation((name, value) => {
      if (name === "hapticShadowReceiver") receivers.push(value);
      return effect;
    });
    for (const receives of [true, false]) {
      mesh.receiveShadows = receives;
      material.bindForSubMesh(mesh.computeWorldMatrix(true), mesh, mesh.subMeshes[0]!);
    }
    expect(receivers).toEqual([1, 0]);
    expect(atlases).toEqual([shadowAtlasTexture(scene), shadowAtlasTexture(scene)]);
  });

  it("leaves graphs on Babylon's PBR block while the switch is off", async () => {
    const { scene } = host();
    new PointLight("lamp", new Vector3(0, 2, 0), scene);
    const { mesh, material } = await litBox(scene);
    expect(material.attachedBlocks.some((block) => block instanceof ScenePbrLightingBlock)).toBe(true);
    expect(await drawnDefines(scene, mesh, material)).toEqual(expect.arrayContaining(["#define LIGHT0"]));
  });

  it("writes the Scene's lights as records, the first hemispheric light as the fill and rect lights by their half extents", async () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    const fill = new HemisphericLight("fill", Vector3.Up(), scene);
    fill.diffuse = new Color3(0.5, 0.5, 1);
    fill.groundColor = new Color3(0.2, 0.1, 0);
    fill.intensity = 2;
    new HemisphericLight("second fill", Vector3.Up(), scene);
    const sun = new DirectionalLight("sun", new Vector3(0, -2, 0), scene);
    sun.intensity = 3;
    const lamp = new PointLight("lamp", new Vector3(1, 2, 3), scene);
    lamp.range = 7;
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), new Vector3(0, -2, 0), Math.PI / 2, 2, scene);
    spot.range = 9;
    new PointLight("dark", new Vector3(0, 0, 0), scene).intensity = 0;
    // A Babylon rect light without the tables in place would fetch them.
    retainAreaLightLookup(scene);
    const panel = new RectAreaLight("panel", new Vector3(1, 2, 3), 4, 2, scene);
    panel.intensity = 2;
    syncSceneLighting(scene);
    const buffer = hapticLightBuffer(scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
    const read = (name: string, length: number) => [...buffer._bufferData.subarray(buffer._uniformLocations[name]!, buffer._uniformLocations[name]! + length)];
    expect(read("hapticCounts", 4)).toEqual([1, 1, 1, 1]);
    expect(read("hapticFillDirection", 4)).toEqual([0, 1, 0, 1]);
    expect(read("hapticFillSky", 3)).toEqual([1, 1, 2]);
    expect(read("hapticFillGround", 3).map((value) => Math.round(value * 10) / 10)).toEqual([0.4, 0.2, 0]);
    expect(read("hapticDirectional", 8)).toEqual([0, -2, 0, sun.radius, 3, 3, 3, 0].map(Math.fround));
    expect(read("hapticPoint", 12)).toEqual([1, 2, 3, lamp.radius, 1, 1, 1, 7, -1, 0, 0, 0].map(Math.fround));
    expect(read("hapticSpot", 16).map((value) => Math.round(value * 1000) / 1000)).toEqual([0, 4, 0, 0, 0, -1, 0, 0.707, 1, 1, 1, 9, -1, 0, 0, 0]);
    const scaled = Math.fround(panel.getScaledIntensity());
    // No emission: layer -1, its flat colour.
    expect(read("hapticRect", 16)).toEqual([1, 2, 3, 0, 2, 0, 0, 0, 0, 1, 0, 0, scaled, scaled, scaled, -1]);
    expect(scene._ltcTextures).toBeDefined();
    expect(HAPTIC_LIGHT_MAXIMUM.point).toBeGreaterThan(0);
    // The Unlit viewport: Babylon's materials light with no light, and so does the block.
    scene.lightsEnabled = false;
    syncSceneLighting(scene);
    expect(read("hapticCounts", 4)).toEqual([0, 0, 0, 0]);
    expect(read("hapticFillDirection", 4)[3]).toBe(0);
  });

  it("names each spot light's shadow view of the atlas in its record: its transform, tile, darkness and filter quality", () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    const spots = [0, 1, 2].map((index) => new SpotLight(`spot ${index}`, new Vector3(index, 4, 0), new Vector3(0, -1, 0), Math.PI / 2, 2, scene));
    const [first, second] = [spots[0]!, spots[1]!].map((spot) => createAtlasShadowGenerator(spot, EDGE / 2, EDGE)!);
    second!.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    second!.setDarkness(0.25);
    syncSceneLighting(scene);
    const buffer = hapticLightBuffer(scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
    const read = (name: string, from: number, length: number) =>
      [...buffer._bufferData.subarray(buffer._uniformLocations[name]! + from, buffer._uniformLocations[name]! + from + length)];
    const views = () => [0, 1, 2].map((index) => read("hapticSpot", index * 16 + 12, 1)[0]);
    // The third spot casts no shadow.
    expect(views()).toEqual([0, 1, -1]);
    expect(read("hapticShadowViews", 0, 16)).toEqual([...first!.getTransformMatrix().m].map(Math.fround));
    const texel = 1 / EDGE;
    expect(read("hapticShadowViews", 16, 8)).toEqual([0, 0, 0.5, texel, 0, 2, 0, 0].map(Math.fround));
    expect(read("hapticShadowViews", 24 + 16, 8)).toEqual([0.5, 0, 0.5, texel, 0.25, 1, 0, 0].map(Math.fround));
    // A light's or the Scene's shadows switched off sample none.
    spots[0]!.shadowEnabled = false;
    syncSceneLighting(scene);
    expect(views()).toEqual([-1, 0, -1]);
    scene.shadowsEnabled = false;
    syncSceneLighting(scene);
    expect(views()).toEqual([-1, -1, -1]);
    // Two more tiles of a quarter fill the atlas; disposing a map frees its tile.
    expect([createAtlasShadowGenerator(spots[2]!, EDGE / 2, EDGE), createAtlasShadowGenerator(spots[2]!, EDGE / 2, EDGE)].every(Boolean)).toBe(true);
    expect(createAtlasShadowGenerator(spots[2]!, EDGE / 4, EDGE)).toBeNull();
    first!.dispose();
    expect(createAtlasShadowGenerator(spots[0]!, EDGE / 2, EDGE)!.tile).toEqual({ x: 0, y: 0, size: EDGE / 2 });
  });

  it("writes the shadowed sun's cascades as views, and how the block chooses between them, as they were last drawn", () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    engine._features.supportCSM = true;
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    const generator = createAtlasCascadedShadowGenerator(sun, EDGE / 4, 3, EDGE)!;
    generator.cascadeBlendPercentage = 0.05;
    generator.fadeFraction = 0.1;
    expect(generator.numCascades).toBe(3);
    syncSceneLighting(scene);
    const buffer = hapticLightBuffer(scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
    const read = (name: string, from: number, length: number) =>
      [...buffer._bufferData.subarray(buffer._uniformLocations[name]! + from, buffer._uniformLocations[name]! + from + length)];
    // w marks the shadowed sun; its record: three cascades, blending over their last twentieth, fading over the last
    // tenth of the shadow distance, from view 0.
    expect(read("hapticDirectional", 7, 1)).toEqual([1]);
    expect(read("hapticSunShadow", 0, 4).map((value) => Math.round(value * 1000) / 1000)).toEqual([3, 20, 0.1, 0]);
    // Each cascade a tile, its depth clamped.
    const texel = Math.fround(1 / EDGE);
    expect([0, 1, 2].map((view) => read("hapticShadowViews", view * 24 + 16, 8))).toEqual([
      [0, 0, 0.25, texel, 0, 2, 1, 0], [0.25, 0, 0.25, texel, 0, 2, 1, 0], [0, 0.25, 0.25, texel, 0, 2, 1, 0],
    ]);
    // Drawn, the views and splits are the ones the cascades were drawn with, and the block takes them at once.
    // NullEngine has no scissor.
    vi.spyOn(engine, "enableScissor").mockImplementation(() => {});
    vi.spyOn(engine, "disableScissor").mockImplementation(() => {});
    scene.incrementRenderId();
    scene.updateTransformMatrix(true);
    generator.getShadowMap()!.render();
    expect(generator.cascadeEnds.every((end) => end > 0)).toBe(true);
    expect(read("hapticSunShadow", 8, 3)).toEqual(generator.cascadeEnds.slice(0, 3).map(Math.fround));
    expect(read("hapticShadowViews", 24, 16)).toEqual([...generator.getCascadeTransformMatrix(1)!.m].map(Math.fround));
    // The camera's view depth plane: its forward axis and the camera's depth.
    const plane = read("hapticSunShadow", 4, 4);
    const camera = scene.activeCamera!;
    expect(plane[0]! * camera.globalPosition.x + plane[1]! * camera.globalPosition.y + plane[2]! * camera.globalPosition.z + plane[3]!).toBeCloseTo(0);
  });

  it("draws a point light's shadow as six face tiles of the atlas, in Babylon's face order, filtered with PCF", () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    const lamp = new PointLight("lamp", new Vector3(0, 2, 0), scene);
    const generator = createAtlasShadowGenerator(lamp, EDGE / 4, EDGE)!;
    generator.usePercentageCloserFiltering = true;
    // Babylon's own cube maps fall back to Poisson sampling.
    expect([generator.tiles.length, generator.filter]).toEqual([6, ShadowGenerator.FILTER_PCF]);
    syncSceneLighting(scene);
    const buffer = hapticLightBuffer(scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
    const read = (name: string, from: number, length: number) =>
      [...buffer._bufferData.subarray(buffer._uniformLocations[name]! + from, buffer._uniformLocations[name]! + from + length)];
    // Its record's shadow: the first view and six faces.
    expect(read("hapticPoint", 8, 4)).toEqual([0, 6, 0, 0]);
    // Drawn, each face's view is the one Babylon drew that face with: face 2 looks down.
    vi.spyOn(engine, "enableScissor").mockImplementation(() => {});
    vi.spyOn(engine, "disableScissor").mockImplementation(() => {});
    generator.getShadowMap()!.render();
    const below = Vector3.TransformCoordinates(new Vector3(0, 0, 0), generator.drawnViews[2]!);
    const above = Vector3.TransformCoordinates(new Vector3(0, 0, 0), generator.drawnViews[3]!);
    expect([Math.abs(below.x) < 1e-6 && Math.abs(below.y) < 1e-6, below.z > 0 && below.z < 1]).toEqual([true, true]);
    expect(above.z < 0 || above.z > 1).toBe(true);
    expect(read("hapticShadowViews", 2 * 24, 16)).toEqual([...generator.drawnViews[2]!.m].map(Math.fround));
  });

  it("makes the atlas again after a failed shadow allocation released it with the first tile", () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), new Vector3(0, -1, 0), Math.PI / 2, 2, scene);
    const placeholder = shadowAtlasTexture(scene);
    // As a failed allocation check releases what the attempt made.
    const rollback = shadowAllocationCheckpoint(scene);
    const failed = createAtlasShadowGenerator(spot, EDGE / 2, EDGE)!;
    const released = shadowAtlasTexture(scene);
    expect(released).not.toBe(placeholder);
    rollback(failed);
    expect(shadowAtlasTexture(scene)).toBe(placeholder);
    const generator = createAtlasShadowGenerator(spot, EDGE / 2, EDGE)!;
    const atlas = shadowAtlasTexture(scene);
    expect(atlas).not.toBe(released);
    expect(generator.tile).toEqual({ x: 0, y: 0, size: EDGE / 2 });
    expect(generator.getShadowMap()!.renderTarget).toBe(atlas.renderTarget);
    scene.dispose();
    expect(atlas.getInternalTexture()).toBeNull();
  });

  it("draws the lights nearest the camera within the Local Light Budget and this device's maximum, and reports the rest", () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    const lamps = Array.from({ length: 20 }, (_, index) => new PointLight(`lamp ${index}`, new Vector3(0, 0, index + 1), scene));
    const sun = new DirectionalLight("sun", new Vector3(0, -1, 0), scene);
    new DirectionalLight("second sun", new Vector3(0, -1, 0), scene);
    const fill = new HemisphericLight("fill", Vector3.Up(), scene);
    new HemisphericLight("second fill", Vector3.Up(), scene);
    const buffer = hapticLightBuffer(scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
    const counts = () => [...buffer._bufferData.subarray(buffer._uniformLocations.hapticCounts!, buffer._uniformLocations.hapticCounts! + 4)];
    const budget = (lights: number) => {
      const quality = normalizeRenderingQuality(qualityPresetPatch("high"));
      quality.lighting.localLightMode = "manual";
      quality.lighting.maxLocalLights = lights;
      updateSceneRenderingSettings(scene, { quality });
      syncSceneLighting(scene);
    };
    // The budget ranks out the farthest lights, which the editor shows as limited; one sun and one fill stay.
    budget(12);
    expect(counts()).toEqual([1, 12, 0, 0]);
    expect(lamps.map(isForwardLightExcluded)).toEqual(lamps.map((_, index) => index >= 12));
    expect([sun.isEnabled(), fill.isEnabled()]).toEqual([true, true]);
    expect(sceneLightingLimits(scene).join()).toContain("Light block: 14/23 requested lights admitted; 12 scalability local lights");
    // A phone or tablet draws at most half the block's point lights, whatever the budget.
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", maxTouchPoints: 5 });
    budget(64);
    expect(counts()).toEqual([1, HAPTIC_LIGHT_MAXIMUM.point / 2, 0, 0]);
    expect(lamps.filter((lamp) => !isForwardLightExcluded(lamp))).toEqual(lamps.slice(0, HAPTIC_LIGHT_MAXIMUM.point / 2));
    vi.unstubAllGlobals();
    budget(64);
    expect(counts()).toEqual([1, 20, 0, 0]);
    // The block holds one fill.
    expect(sceneLightingLimits(scene).join()).toContain("Light block: 22/23 requested lights admitted; 64 scalability local lights");
    expect(sceneLightingLimits(scene).join()).toMatch(/Limited: second fill$/);
  });

  it("draws the preview studio rig whole, as the legacy path does: one directional key and one fill", () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    createPreviewLighting(scene);
    syncSceneLighting(scene);
    const buffer = hapticLightBuffer(scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
    const read = (name: string) => [...buffer._bufferData.subarray(buffer._uniformLocations[name]!, buffer._uniformLocations[name]! + 4)];
    expect(read("hapticCounts")).toEqual([1, 0, 0, 0]);
    expect(read("hapticFillDirection")[3]).toBe(1);
    expect(sceneLightingLimits(scene)).toEqual([]);
  });

  it("gives each distinct rect light emission a layer of one array, rebuilt only when the set changes", () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    retainAreaLightLookup(scene);
    const emission = (hash: string) =>
      ({ metadata: { processor: "test", pixelsHash: hash, width: 1, height: 1 }, rgba: new Uint8Array(4) }) as unknown as AreaEmissionPixels;
    const panels = ["a", "b", "a", "c"].map((hash, index) => {
      const panel = new RectAreaLight(`panel ${index}`, new Vector3(index, 2, 0), 1, 1, scene);
      setRectLightEmission(panel, emission(hash));
      return panel;
    });
    const layers: number[] = [];
    syncAreaEmissionLayers(scene, panels, 2, layers);
    // A shared emission shares its layer; one past the cap draws its flat colour.
    expect(layers).toEqual([0, 1, 0, -1]);
    const array = areaEmissionTexture(scene);
    expect(array.is2DArray).toBe(true);
    syncAreaEmissionLayers(scene, panels, 2, layers);
    expect(areaEmissionTexture(scene)).toBe(array);
    setRectLightEmission(panels[1]!, undefined);
    syncAreaEmissionLayers(scene, panels, 2, layers);
    expect(layers).toEqual([0, -1, 0, 1]);
    expect(areaEmissionTexture(scene)).not.toBe(array);
    // The block's records carry each light's layer.
    syncSceneLighting(scene);
    const buffer = hapticLightBuffer(scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
    const records = buffer._bufferData.subarray(buffer._uniformLocations.hapticRect!, buffer._uniformLocations.hapticRect! + 64);
    expect([0, 1, 2, 3].map((index) => records[index * 16 + 15]).sort()).toEqual([-1, 0, 0, 1]);
  });
});
