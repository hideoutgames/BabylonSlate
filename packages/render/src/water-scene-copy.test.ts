import {
  FreeCamera,
  Mesh,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  ParticleSystem,
  Scene,
  StandardMaterial,
  type UniformBuffer,
  Vector3,
} from "@babylonjs/core";
import { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultWaterDefinition,
  DEFAULT_RENDER_EFFECTS,
  normalizeRenderingQuality,
  normalizeWaterBody,
} from "@babylonslate/core";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";
import { limitManagedRenderBytes, managedRenderReservations } from "./managed-render-resources";
import { updateSceneRenderingSettings } from "./render-settings";
import { configureEditorRenderingGroups } from "./sorting";
import { createWaterMesh } from "./water-mesh";
import { isMainWaterPass, waterSceneCopyForPass } from "./water-scene-copy";

const DEFAULT_TASKS = [
  "Forward admitted shadows",
  "Clustered light mask",
  "Forward clear",
  "Forward cull",
  "Forward objects",
];

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A device with half-float targets and the shared-depth group setup Play and the editor use. */
function host({ sharedDepth = true, options = new NullEngineOptions() } = {}) {
  const engine = new NullEngine(options);
  engines.push(engine);
  engine.getCaps().textureHalfFloatRender = true;
  // Pinned MRT extension installs WebGL calls on ThinEngine without NullEngine
  // overrides. Supply only that absent GPU boundary; graph/tasks remain real.
  vi.spyOn(engine, "buildTextureLayout").mockImplementation((enabled, backbuffer) =>
    backbuffer ? [0x0405] : enabled.map((value, index) => (value ? 0x8ce0 + index : 0)));
  vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(() => {});
  // Babylon 9.20 NullEngine has no FrameGraph allocation overrides. Adapt only
  // those hardware boundaries, retaining real textures, wrappers and refcounts.
  vi.spyOn(engine, "_createInternalTexture").mockImplementation((size, options) => {
    const wrapper = engine.createRenderTargetTexture(size, {
      ...(typeof options === "object" ? options : {}),
      generateDepthBuffer: false,
    });
    const texture = wrapper.texture!;
    texture.format = typeof options === "object" ? (options.format ?? 5) : 5;
    wrapper.dispose(true);
    return texture;
  });
  vi.spyOn(engine, "createMultipleRenderTarget").mockImplementation((size) =>
    engine._createHardwareRenderTargetWrapper(true, false, size));
  const scene = new Scene(engine);
  if (sharedDepth) configureEditorRenderingGroups(scene);
  const camera = new FreeCamera("camera", new Vector3(0, 6, -12), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  return { engine, scene, camera };
}

function lake(scene: Scene, water = createDefaultWaterDefinition()): Mesh {
  return createWaterMesh(scene, "lake", normalizeWaterBody({ width: 4, length: 4, resolution: 8 }), water);
}

function box(scene: Scene, name: string, alpha = 1): Mesh {
  const mesh = MeshBuilder.CreateBox(name, {}, scene);
  const material = new StandardMaterial(name, scene);
  material.alpha = alpha;
  mesh.material = material;
  mesh.position.y = 0.5;
  return mesh;
}

/** The object renderer (by render pass id) and the bound target, output or an offscreen texture, of the current draw. */
function currentPass(scene: Scene): string {
  const engine = scene.getEngine();
  const id = engine.currentRenderPassId;
  const renderer = scene.objectRenderers.find((candidate) => candidate.renderPassId === id)?.name ?? `pass ${id}`;
  return `${renderer} → ${engine._currentRenderTarget ? "texture" : "output"}`;
}

/** `currentPass` for each draw of `mesh`. */
function drawnBy(scene: Scene, mesh: Mesh): string[] {
  const passes: string[] = [];
  mesh.onBeforeRenderObservable.add(() => passes.push(currentPass(scene)));
  return passes;
}

/**
 * A started particle system on a geometry-less, always-active emitter mesh, as
 * ParticleService builds them, and `currentPass` for each of its draws.
 * NullEngine uploads no texture and compiles no particle effect: stub only
 * readiness and the native draw.
 */
function particles(scene: Scene): string[] {
  const emitter = new Mesh("particleEmitter:test", scene);
  emitter.isPickable = false;
  emitter.alwaysSelectAsActiveMesh = true;
  const system = new ParticleSystem("sparks", 8, scene);
  system.emitter = emitter;
  system.start();
  vi.spyOn(system, "isReady").mockReturnValue(true);
  const passes: string[] = [];
  vi.spyOn(system, "render").mockImplementation(() => { passes.push(currentPass(scene)); return 0; });
  return passes;
}

/**
 * Water's first frame creates its field textures. NullEngine never completes
 * a raw upload: stand in for that GPU boundary, then render until a frame
 * draws with readiness settled. The contact field rescans objects every
 * 100 ms and may then replace its texture, so settle once more after a scan.
 */
async function settle(graph: ForwardSceneFrameGraph, camera: FreeCamera): Promise<void> {
  const scene = camera.getScene();
  const drawn = () => vi.waitFor(() => {
    for (const texture of scene.textures) {
      const internal = texture.getInternalTexture();
      if (internal) internal.isReady = true;
    }
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  await drawn();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await drawn();
}

/** Split frames, frames with visible copy-sampling water, and copy draws during `run`. */
function frames(graph: ForwardSceneFrameGraph, run: () => void) {
  const before = graph.waterSceneCopyDiagnostics()!;
  run();
  const after = graph.waterSceneCopyDiagnostics()!;
  return {
    frames: after.frames - before.frames,
    visibleFrames: after.visibleFrames - before.visibleFrames,
    copies: after.copies - before.copies,
  };
}

it("keeps the default five-task graph when no built-in water could sample a copy", async () => {
  const { scene, camera } = host();
  box(scene, "opaque");
  // A custom-material water surface has no WaterMaterialPlugin and cannot sample the copy.
  createWaterMesh(scene, "custom", normalizeWaterBody({ resolution: 8 }), undefined, new StandardMaterial("custom", scene));
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toEqual(DEFAULT_TASKS);
  expect(graph.waterSceneCopyDiagnostics()).toBeNull();
  graph.dispose();
});

it("admits the copy only without per-group depth clears, and re-plans when that changes", async () => {
  const { scene, camera } = host({ sharedDepth: false });
  lake(scene);
  const graph = new ForwardSceneFrameGraph(scene);
  // Babylon's default clears depth before groups 1–3: a transparent pass would lose the opaque depth.
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toEqual(DEFAULT_TASKS);
  configureEditorRenderingGroups(scene);
  expect(graph.readiness(camera)).toEqual({ path: "frameGraph", ready: false, preparationRequired: true });
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toContain("Water scene copy");
  // Low quality turns refraction off and reflects the sky only: the copy is not planned.
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "low" } }) });
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toEqual(DEFAULT_TASKS);
  graph.dispose();
});

it("swaps the backbuffer view onto an own pair only on frames with visible copy-sampling water", async () => {
  const { scene, camera } = host();
  const water = lake(scene);
  const opaque = box(scene, "opaque");
  const glass = box(scene, "glass", 0.5);
  const waterDraws = drawnBy(scene, water), opaqueDraws = drawnBy(scene, opaque), glassDraws = drawnBy(scene, glass);
  const sparkDraws = particles(scene);
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  // Water opaque draws through Forward objects' renderer: one pass id and one readiness probe serve both.
  expect(scene.objectRenderers.map((renderer) => renderer.name).sort()).toEqual(["Forward objects", "Forward transparent"]);
  // The split switches the output clear too, so it decides before that clear runs.
  expect(graph.taskNames()).toEqual([
    "Forward admitted shadows", "Clustered light mask", "Forward cull", "Water split", "Forward clear",
    "Forward objects", "Water clear", "Water opaque", "Water scene copy", "Forward transparent", "Water output",
  ]);
  await settle(graph, camera);
  // Exactly one scene clear per frame, including frames where the split swaps paths.
  const clears = vi.spyOn(FrameGraphRenderContext.prototype, "clearAttachments");
  let work = frames(graph, () => {
    waterDraws.length = opaqueDraws.length = glassDraws.length = sparkDraws.length = 0;
    for (let frame = 0; frame < 3; frame += 1) expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  expect(work).toEqual({ frames: 3, visibleFrames: 3, copies: 3 });
  expect(clears).toHaveBeenCalledTimes(3);
  expect(graph.waterSceneCopyDiagnostics()).toMatchObject({ ownTargets: true, scale: 0.5 });
  // Opaques draw into the own pair; water, transparents and particles after the copy, in the registered pass only.
  expect(new Set(waterDraws)).toEqual(new Set(["Forward transparent → texture"]));
  expect(opaqueDraws).toEqual(Array(3).fill("Forward objects → texture"));
  expect(glassDraws).toEqual(Array(3).fill("Forward transparent → texture"));
  expect(sparkDraws).toEqual(Array(3).fill("Forward transparent → texture"));

  // Without such water in view the direct path draws everything; the split passes stay empty.
  water.setEnabled(false);
  work = frames(graph, () => {
    waterDraws.length = opaqueDraws.length = glassDraws.length = sparkDraws.length = 0;
    for (let frame = 0; frame < 3; frame += 1) expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  expect(work).toEqual({ frames: 3, visibleFrames: 0, copies: 0 });
  expect(clears).toHaveBeenCalledTimes(6);
  expect(waterDraws).toEqual([]);
  expect(opaqueDraws).toEqual(Array(3).fill("Forward objects → output"));
  expect(glassDraws).toEqual(Array(3).fill("Forward objects → output"));
  expect(sparkDraws).toEqual(Array(3).fill("Forward objects → output"));

  water.setEnabled(true);
  work = frames(graph, () => expect(graph.render(camera)).toEqual({ path: "frameGraph" }));
  expect(work).toEqual({ frames: 1, visibleFrames: 1, copies: 1 });
  expect(clears).toHaveBeenCalledTimes(7);
  graph.dispose();
});

it("shares an effect chain's scene targets, deferring transparents only while water is visible", async () => {
  const { scene, camera } = host();
  updateSceneRenderingSettings(scene, { effects: { ...DEFAULT_RENDER_EFFECTS, fxaa: true } });
  const water = lake(scene);
  const glass = box(scene, "glass", 0.5);
  const glassDraws = drawnBy(scene, glass);
  const sparkDraws = particles(scene);
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  const names = graph.taskNames();
  expect(names).not.toContain("Water clear");
  expect(names.indexOf("Water split")).toBe(names.indexOf("Forward objects") - 1);
  expect(names.indexOf("Water scene copy")).toBe(names.indexOf("Forward objects") + 1);
  expect(names.indexOf("Forward transparent")).toBe(names.indexOf("Water scene copy") + 1);
  expect(names.indexOf("Scene Effects FXAA")).toBeGreaterThan(names.indexOf("Forward transparent"));
  await settle(graph, camera);
  expect(graph.waterSceneCopyDiagnostics()).toMatchObject({ ownTargets: false });
  let work = frames(graph, () => {
    glassDraws.length = sparkDraws.length = 0;
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  expect(work).toEqual({ frames: 1, visibleFrames: 1, copies: 1 });
  expect(glassDraws).toEqual(["Forward transparent → texture"]);
  expect(sparkDraws).toEqual(["Forward transparent → texture"]);
  // Enabled water outside the view frustum is not in the cull output: nothing is deferred or copied.
  water.position.x = 500;
  // Moving a surface rebuilds its contact field.
  await settle(graph, camera);
  work = frames(graph, () => {
    glassDraws.length = sparkDraws.length = 0;
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  expect(work).toEqual({ frames: 1, visibleFrames: 0, copies: 0 });
  expect(glassDraws).toEqual(["Forward objects → texture"]);
  expect(sparkDraws).toEqual(["Forward objects → texture"]);
  graph.dispose();
});

it("plans no copy for water whose asset samples none of the features the quality runs", async () => {
  const { engine, scene, camera } = host();
  // Refraction 0 never samples the copy; Object Reflections only sample it under a screen-space march.
  const water = lake(scene, { ...createDefaultWaterDefinition(), refraction: 0, objectReflections: true });
  const waterDraws = drawnBy(scene, water);
  const graph = new ForwardSceneFrameGraph(scene);
  // Medium refracts and reflects the sky only: nothing is planned, reserved or allocated.
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toEqual(DEFAULT_TASKS);
  expect(graph.waterSceneCopyDiagnostics()).toBeNull();
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(0);
  await settle(graph, camera);
  waterDraws.length = 0;
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  expect(new Set(waterDraws)).toEqual(new Set(["Forward objects → output"]));
  // Screen Space reflections march the copy: the same water now plans it.
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "high" } }) });
  expect(graph.readiness(camera)).toEqual({ path: "frameGraph", ready: false, preparationRequired: true });
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toContain("Water scene copy");
  graph.dispose();
});

it("registers the transparent pass before its first readiness probe and unregisters it on release", async () => {
  const { engine, scene, camera } = host();
  const water = lake(scene);
  const probed: { pass: number; registered: boolean; attached: boolean }[] = [];
  const material = water.material!;
  const isReady = material.isReadyForSubMesh.bind(material);
  vi.spyOn(material, "isReadyForSubMesh").mockImplementation((...args) => {
    const pass = engine.currentRenderPassId;
    const copy = waterSceneCopyForPass(scene, pass);
    probed.push({ pass, registered: copy !== null, attached: Boolean(copy?.texture.getInternalTexture()) });
    return isReady(...args);
  });
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  const first = graph.waterSceneCopyDiagnostics()!.renderPassId;
  const copy = waterSceneCopyForPass(scene, first)!;
  // The plugin's defines settle with the copy present at the very first probe of that pass.
  expect(probed.find((entry) => entry.pass === first)).toEqual({ pass: first, registered: true, attached: true });
  expect(probed.filter((entry) => entry.pass !== first).every((entry) => !entry.registered)).toBe(true);
  expect(isMainWaterPass(scene, first)).toBe(true);
  expect(isMainWaterPass(scene, camera.renderPassId)).toBe(false);
  expect(copy.invSize).toEqual([1 / engine.getRenderWidth(true), 1 / engine.getRenderHeight(true)]);
  expect(copy.scale).toBe(0.5);
  expect(copy.texture.wrapU).toBe(0);
  expect(copy.texture.getSize()).toMatchObject({
    width: Math.round(engine.getRenderWidth(true) * 0.5), height: Math.round(engine.getRenderHeight(true) * 0.5),
  });

  // A retained graph keeps its registration until its deferred release.
  const releasePrevious = graph.retainResources();
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { refractionScale: 0.75 } }) });
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  const second = graph.waterSceneCopyDiagnostics()!.renderPassId;
  expect(second).not.toBe(first);
  expect(waterSceneCopyForPass(scene, second)?.scale).toBe(0.75);
  expect(waterSceneCopyForPass(scene, first)).toBe(copy);
  releasePrevious();
  expect(waterSceneCopyForPass(scene, first)).toBeNull();
  graph.dispose();
  expect(waterSceneCopyForPass(scene, second)).toBeNull();
});

it("compiles refraction and the screen-space march only into the copy's pass, for the features each asset asks for", async () => {
  const { scene, camera } = host();
  const quality = (profile: "low" | "medium" | "high") =>
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile } }) });
  quality("high");
  const sampling = lake(scene, { ...createDefaultWaterDefinition(), refraction: 0.35, objectReflections: true });
  const plain = createWaterMesh(scene, "plain", normalizeWaterBody({ width: 4, length: 4, resolution: 8 }),
    { ...createDefaultWaterDefinition(), refraction: 0, objectReflections: false });
  plain.position.x = 1;
  const graph = new ForwardSceneFrameGraph(scene);
  /** Compiled defines of `mesh` in render pass `pass` ("" before that pass has an effect). */
  const compiled = (mesh: Mesh, pass: number) => mesh.subMeshes[0]!._getDrawWrapper(pass)?.effect?.defines ?? "";
  const plan = async () => {
    expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
    await settle(graph, camera);
    return graph.waterSceneCopyDiagnostics()?.renderPassId ?? null;
  };
  // High: Refraction and a 16-step Screen Space march, only where the asset asks and only in the copy's pass.
  const high = (await plan())!;
  expect(compiled(sampling, high)).toContain("#define SLATE_WATER_REFRACTION\n");
  expect(compiled(sampling, high)).toContain("#define SLATE_WATER_SSR\n");
  expect(compiled(sampling, high)).toContain("#define SLATE_WATER_SSR_STEPS 16\n");
  expect(compiled(plain, high)).not.toContain("SLATE_WATER_REFRACTION\n");
  expect(compiled(plain, high)).not.toContain("SLATE_WATER_SSR\n");
  // The main object pass (and any pass without a copy: captures, previews, classic frames) compiles neither.
  const objectsPass = () => scene.objectRenderers.filter((renderer) => renderer.name === "Forward objects").at(-1)!.renderPassId;
  const objects = objectsPass();
  expect(compiled(sampling, objects)).toContain("#define SLATE_WATER\n");
  expect(compiled(sampling, objects)).not.toContain("SLATE_WATER_REFRACTION\n");
  expect(compiled(sampling, objects)).not.toContain("SLATE_WATER_SSR\n");
  // Medium refracts and reflects the sky only; Low plans no copy, and the water compiles neither feature.
  quality("medium");
  const medium = (await plan())!;
  expect(compiled(sampling, medium)).toContain("#define SLATE_WATER_REFRACTION\n");
  expect(compiled(sampling, medium)).not.toContain("SLATE_WATER_SSR\n");
  expect(compiled(sampling, medium)).toContain("#define SLATE_WATER_SSR_STEPS 0\n");
  quality("low");
  expect(await plan()).toBeNull();
  for (const pass of [objectsPass(), camera.renderPassId]) {
    expect(compiled(sampling, pass)).not.toContain("SLATE_WATER_REFRACTION\n");
    expect(compiled(sampling, pass)).not.toContain("SLATE_WATER_SSR\n");
  }
  graph.dispose();
});

it("follows a backbuffer resize in place, keeping every task and render pass id", async () => {
  const options = new NullEngineOptions();
  options.renderWidth = 320;
  options.renderHeight = 200;
  const { engine, scene, camera } = host({ options });
  const water = lake(scene);
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  await settle(graph, camera);
  const tasks = graph.taskNames();
  const passes = () => scene.objectRenderers.filter((renderer) => renderer.name.startsWith("Forward "))
    .map((renderer) => [renderer.name, renderer.renderPassId]);
  const before = passes();
  const { renderPassId } = graph.waterSceneCopyDiagnostics()!;
  const { revision } = waterSceneCopyForPass(scene, renderPassId)!;
  // NullEngine owns no canvas; its options are the backbuffer boundary (a dynamic-resolution step).
  options.renderWidth = 256;
  options.renderHeight = 160;
  expect(graph.readiness(camera)).toEqual({ path: "frameGraph", ready: false, preparationRequired: true });
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  // Materials keep their draw wrappers and settled variants: no new pass needs a strict probe.
  expect(graph.taskNames()).toEqual(tasks);
  expect(passes()).toEqual(before);
  expect(graph.waterSceneCopyDiagnostics()!.renderPassId).toBe(renderPassId);
  const copy = waterSceneCopyForPass(scene, renderPassId)!;
  expect(copy.invSize).toEqual([1 / 256, 1 / 160]);
  expect(copy.revision).not.toBe(revision);
  expect(copy.texture.getSize()).toEqual({ width: 128, height: 80 });
  // The resized copy and own pair replace the previous charge.
  expect(managedRenderReservations(engine)).toMatchObject({ pendingBytes: 0 });
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(128 * 80 * 8 + 256 * 160 * 8);
  // Water reads the copy's size on every draw, so its refraction and march follow the resize without recompiling.
  const binds = vi.spyOn((water.material as unknown as { _uniformBuffer: UniformBuffer })._uniformBuffer, "updateFloat4");
  await settle(graph, camera);
  const screens = binds.mock.calls.filter(([name]) => name === "slateWaterScreen");
  expect(screens.length).toBeGreaterThan(0);
  expect(screens.at(-1)!.slice(1, 3)).toEqual([1 / 256, 1 / 160]);
  graph.dispose();
});

it("charges the copy and own pair to the water ledger and releases them with the graph", async () => {
  const { engine, scene, camera } = host();
  lake(scene);
  const width = engine.getRenderWidth(true), height = engine.getRenderHeight(true);
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  const copyBytes = Math.round(width * 0.5) * Math.round(height * 0.5) * 8;
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(copyBytes + width * height * 8);
  graph.dispose();
  await graph.whenReleased();
  expect(managedRenderReservations(engine)).toMatchObject({ resourceBytes: 0, pendingBytes: 0 });
});

it("degrades to the plain graph with a warning when the shared budget refuses the copy", async () => {
  const { engine, scene, camera } = host();
  lake(scene);
  limitManagedRenderBytes(engine, 1024);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Water scene copy disabled"));
  expect(graph.taskNames()).toEqual(DEFAULT_TASKS);
  // The refusal is part of the prepared plan: frames keep rendering without re-planning.
  await settle(graph, camera);
  expect(graph.readiness(camera)).toEqual({ path: "frameGraph", ready: true });
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  expect(warn).toHaveBeenCalledTimes(1);
  graph.dispose();
});
