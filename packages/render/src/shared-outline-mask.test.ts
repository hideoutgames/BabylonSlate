import { afterEach, expect, it, vi } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, RawTexture, Scene, StandardMaterial, Vector3, type PBRMaterial, type SubMesh, type UniformBuffer } from "@babylonjs/core";
import { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { WATER_WAVE_MAX_COMPONENTS, createDefaultWaterDefinition, normalizeRenderingQuality, normalizeWaterBody, qualityPresetPatch } from "@babylonslate/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { isDisposedNodeMaterial } from "./gpu-resource-live";
import { acquireAuthoredOutlineVariant, compileMaterialPlan } from "./material-compiler";
import { SharedOutlineOwner } from "./shared-outline";
import { SharedOutlineMaskRenderer } from "./shared-outline-mask";
import { registerSharedOutlineShaders } from "./shared-outline-shaders";
import { updateSceneRenderingSettings } from "./render-settings";
import { waterFftDiagnostics, waterFftForSurface } from "./water-fft";
import { WATER_FFT_SAMPLER, type WaterMaterialPlugin } from "./water-material";
import { createWaterMesh, setSceneWaterTime, setWaterGpuWaves, updateSceneWater } from "./water-mesh";

afterEach(() => vi.restoreAllMocks());

it("retains a live instance mask program across pruning and releases it with its owner", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  const source = MeshBuilder.CreateBox("source", {}, scene);
  const instance = source.createInstance("actor");
  const owner = SharedOutlineOwner.forScene(scene), view = owner.createView("test");
  view.setContribution("actor", { kind: "component", targets: [{ key: "actor", meshes: [instance] }],
    color: [1, 0, 0], width: 1 });
  registerSharedOutlineShaders();
  const objects = new ObjectRenderer("mask", scene);
  objects.activeCamera = camera;
  objects.renderList = [instance];
  const mask = new SharedOutlineMaskRenderer(objects, view, "strict");
  try {
    objects.isReadyForRendering(80, 64);
    const subMesh = instance.subMeshes![0]!;
    const wrapper = subMesh._getDrawWrapper(objects.renderPassId)!;
    const effect = wrapper.effect!;
    expect(effect).toBeTruthy();
    // The GPU compiler is the external boundary: keep this program pending
    // across repeated preparation/cleanup, as native parallel WebGL does.
    const readiness = vi.spyOn(effect, "isReady").mockReturnValue(false);
    for (let attempt = 0; attempt < 3; attempt++) {
      mask.prune();
      expect(subMesh._getDrawWrapper(objects.renderPassId)).toBe(wrapper);
      expect(effect.isDisposed).toBe(false);
      expect(objects.isReadyForRendering(80, 64)).toBe(false);
    }
    readiness.mockRestore();
    expect(objects.isReadyForRendering(80, 64)).toBe(true);
    instance.dispose();
    mask.prune();
    await mask.whenReleased();
    expect(subMesh._getDrawWrapper(objects.renderPassId)).toBeUndefined();
  } finally {
    mask.dispose(); objects.dispose(); view.dispose();
    await owner.whenReleased();
    scene.dispose(); engine.dispose();
  }
});

it("revalidates coverage edited after a drawn mask pass for readiness and the next pass", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  const source = MeshBuilder.CreateBox("source", {}, scene);
  const material = new StandardMaterial("coverage", scene);
  source.material = material;
  const instance = source.createInstance("actor");
  const owner = SharedOutlineOwner.forScene(scene), view = owner.createView("test");
  view.setContribution("actor", { kind: "component", targets: [{ key: "actor", meshes: [instance] }],
    color: [1, 0, 0], width: 1 });
  registerSharedOutlineShaders();
  const objects = new ObjectRenderer("mask", scene);
  objects.activeCamera = camera;
  objects.renderList = [instance];
  owner.registerRenderPass(objects.renderPassId);
  const mask = new SharedOutlineMaskRenderer(objects, view, "strict");
  // As FrameGraph object passes: a fresh render id and intermediate rendering.
  const render = () => {
    scene.incrementRenderId(); scene._intermediateRendering = true;
    objects.prepareRenderList(); objects.initRender(80, 64); objects.render(); objects.finishRender();
    scene._intermediateRendering = false;
  };
  const defines = (subMesh: SubMesh) => subMesh._getDrawWrapper(objects.renderPassId)?.defines;
  try {
    expect(objects.isReadyForRendering(80, 64)).toBe(true);
    render();
    // The instance is probed; its source submesh is what the pass submits.
    const probed = instance.subMeshes![0]!, drawn = source.subMeshes[0]!;
    expect(defines(drawn)).toBeTypeOf("string");
    expect(defines(drawn)).not.toContain("ALPHATEST");
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    texture.hasAlpha = true;
    texture.getInternalTexture()!.isReady = true; // NullEngine never completes raw uploads.
    material.diffuseTexture = texture;
    // A between-frame probe follows the last mask pass without a new render id.
    objects.isReadyForRendering(80, 64);
    expect(defines(probed)).toContain("#define ALPHATEST");
    render();
    expect(defines(drawn)).toContain("#define ALPHATEST");
  } finally {
    mask.dispose(); objects.dispose(); view.dispose();
    await owner.whenReleased();
    scene.dispose(); engine.dispose();
  }
});

it("releases the authored coverage variants of pruned and disposed mask programs", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const authored = compileMaterialPlan(lowered.plan, { scene, name: "authored" });
  if (!authored.ok) throw new Error(JSON.stringify(authored.diagnostics));
  expect(await authored.ready).toEqual([]);
  const meshes = ["a", "b"].map((name) => {
    const mesh = MeshBuilder.CreateBox(name, {}, scene);
    mesh.material = authored.material;
    return mesh;
  });
  // A consumer outside the pass shares the same reference-counted variant.
  const outside = acquireAuthoredOutlineVariant(authored.material)!;
  expect(await outside.compiled.ready).toEqual([]);
  const owner = SharedOutlineOwner.forScene(scene), view = owner.createView("test");
  view.setContribution("actors", { kind: "component", targets: meshes.map((mesh) => ({ key: mesh.name, meshes: [mesh] })),
    color: [1, 0, 0], width: 1 });
  registerSharedOutlineShaders();
  const objects = new ObjectRenderer("mask", scene);
  objects.activeCamera = camera;
  objects.renderList = meshes;
  const mask = new SharedOutlineMaskRenderer(objects, view, "strict");
  try {
    // Readiness stops at the first pending mesh; ready means both programs exist.
    expect(objects.isReadyForRendering(80, 64)).toBe(true);
    meshes[0]!.dispose();
    mask.prune();
    mask.dispose();
    await mask.whenReleased();
    expect(isDisposedNodeMaterial(outside.compiled.material, scene)).toBe(false);
    await outside.release();
    expect(isDisposedNodeMaterial(outside.compiled.material, scene)).toBe(true);
  } finally {
    mask.dispose(); objects.dispose(); view.dispose();
    await owner.whenReleased();
    authored.dispose(); scene.dispose(); engine.dispose();
  }
});

it("displaces built-in GPU water in the mask with the material's swell for the frame, and never displaces CPU water twice", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 6, -12), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  setSceneWaterTime(scene, 2.5);
  const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 10, length: 10, waveScale: 1, resolution: 8 }),
    { ...createDefaultWaterDefinition(), waveModel: "ocean", choppiness: 0.4 });
  const owner = SharedOutlineOwner.forScene(scene), view = owner.createView("test");
  view.setContribution("lake", { kind: "component", targets: [{ key: "lake", meshes: [lake] }], color: [1, 0, 0], width: 1 });
  registerSharedOutlineShaders();
  const objects = new ObjectRenderer("mask", scene);
  objects.activeCamera = camera;
  objects.renderList = [lake];
  owner.registerRenderPass(objects.renderPassId);
  const mask = new SharedOutlineMaskRenderer(objects, view, "strict");
  const render = () => {
    updateSceneWater(scene);
    scene.incrementRenderId(); scene._intermediateRendering = true;
    objects.prepareRenderList(); objects.initRender(80, 64); objects.render(); objects.finishRender();
    scene._intermediateRendering = false;
  };
  const program = () => lake.subMeshes[0]!._getDrawWrapper(objects.renderPassId)!;
  try {
    expect(objects.isReadyForRendering(80, 64)).toBe(true);
    render();
    expect(program().defines).toContain("#define SLATE_WATER_GPU_WAVES");
    expect(program().defines).toContain("#define SLATE_WATER_OCEAN");
    // Each mask draw binds what the water material's own vertex shader reads in the same frame.
    const bound = new Map<string, number[]>(), effect = program().effect!;
    vi.spyOn(effect, "setFloat4").mockImplementation((name: string, x: number, y: number, z: number, w: number) => { bound.set(name, [x, y, z, w]); return effect; });
    render();
    const plugin = (lake.material as PBRMaterial).pluginManager!.getPlugin<WaterMaterialPlugin>("SlateWater")!;
    const material = new Map<string, number[]>();
    plugin.hardBindForSubMesh({ updateFloat4: (name: string, ...values: number[]) => material.set(name, values), updateMatrix: () => {} } as unknown as UniformBuffer, scene);
    for (let i = 0; i < WATER_WAVE_MAX_COMPONENTS; i++)
      for (const name of [`slateWaterSwellDir${i}`, `slateWaterSwellAmp${i}`]) expect(bound.get(name), name).toEqual(material.get(name));
    expect(bound.get("slateWaterSwellInfo")![0]).toBe(material.get("slateWaterSwellInfo")![0]);
    expect(bound.get("slateWaterShape")![0]).toBe(material.get("slateWaterShape")![0]);
    // CPU-path water uploads displaced vertices: its mask program must draw them as they are.
    setWaterGpuWaves(lake, false);
    render();
    expect(program().defines).not.toContain("SLATE_WATER_GPU_WAVES");
  } finally {
    mask.dispose(); objects.dispose(); view.dispose();
    await owner.whenReleased();
    scene.dispose(); engine.dispose();
  }
});

it("adds the FFT detail band's displacement in the mask from the band the water material binds", async () => {
  const engine = new NullEngine();
  Object.assign(engine.getCaps(), { textureFloatRender: true, textureHalfFloatRender: true });
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 6, -12), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch("high")) });
  setSceneWaterTime(scene, 2.5);
  const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 1, length: 1, waveScale: 0.8, resolution: 8 }), createDefaultWaterDefinition());
  const owner = SharedOutlineOwner.forScene(scene), view = owner.createView("test");
  view.setContribution("lake", { kind: "component", targets: [{ key: "lake", meshes: [lake] }], color: [1, 0, 0], width: 1 });
  registerSharedOutlineShaders();
  const objects = new ObjectRenderer("mask", scene);
  objects.activeCamera = camera;
  objects.renderList = [lake];
  owner.registerRenderPass(objects.renderPassId);
  const mask = new SharedOutlineMaskRenderer(objects, view, "strict");
  const render = () => {
    updateSceneWater(scene);
    scene.incrementRenderId(); scene._intermediateRendering = true;
    objects.prepareRenderList(); objects.initRender(80, 64); objects.render(); objects.finishRender();
    scene._intermediateRendering = false;
  };
  const program = () => lake.subMeshes[0]!._getDrawWrapper(objects.renderPassId)!;
  try {
    const material = lake.material as PBRMaterial, subMesh = lake.subMeshes[0]!;
    await vi.waitFor(() => expect(material.isReadyForSubMesh(lake, subMesh)).toBe(true));
    expect(objects.isReadyForRendering(80, 64)).toBe(true);
    render();
    // A grid fine enough to resolve High's first cascade: the mask compiles the material's vertex cascades, and its
    // draws alone keep the band running.
    expect(program().defines).toContain("#define SLATE_WATER_FFT_VERTEX 2");
    await vi.waitFor(() => { render(); expect(waterFftDiagnostics(scene).simulations.some((simulation) => simulation.ready)).toBe(true); });
    const bound = new Map<string, number[]>(), textures = new Map<string, unknown>(), effect = program().effect!;
    vi.spyOn(effect, "setFloat4").mockImplementation((name: string, x: number, y: number, z: number, w: number) => { bound.set(name, [x, y, z, w]); return effect; });
    vi.spyOn(effect, "setTexture").mockImplementation((name: string, texture) => { textures.set(name, texture); });
    render();
    const plugin = material.pluginManager!.getPlugin<WaterMaterialPlugin>("SlateWater")!;
    const drawn = new Map<string, number[]>();
    plugin.hardBindForSubMesh({ updateFloat4: (name: string, ...values: number[]) => drawn.set(name, values), updateMatrix: () => {} } as unknown as UniformBuffer, scene, engine, subMesh);
    // The same band, gain, λ and world-anchored cascades with their filter frequencies as the material's own vertex
    // shader (the view footprint follows each pass's own target).
    expect(textures.get(WATER_FFT_SAMPLER)).toBe(waterFftForSurface(scene, plugin.water)!.texture);
    expect(bound.get("slateWaterFft")!.slice(0, 2)).toEqual(drawn.get("slateWaterFft")!.slice(0, 2));
    expect(bound.get("slateWaterFft")![0]).toBeCloseTo(0.8, 6);
    for (const name of ["slateWaterFftCascade0", "slateWaterFftCascade1"]) expect(bound.get(name), name).toEqual(drawn.get(name));
  } finally {
    mask.dispose(); objects.dispose(); view.dispose();
    await owner.whenReleased();
    scene.dispose(); engine.dispose();
  }
});
