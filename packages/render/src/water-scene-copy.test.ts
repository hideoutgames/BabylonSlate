import {
  FreeCamera,
  Mesh,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  ParticleSystem,
  PBRMaterial,
  Scene,
  ScenePerformancePriority,
  StandardMaterial,
  TransformNode,
  type Effect,
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
} from "@haptic/core";
import { COMPILE_AHEAD_LIMIT } from "./driver-compile";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";
import { limitManagedRenderBytes, managedRenderReservations } from "./managed-render-resources";
import { updateSceneRenderingSettings } from "./render-settings";
import { prewarmSceneMaterials } from "./scene-perf";
import { configureEditorRenderingGroups } from "./sorting";
import type { WaterMaterialPlugin } from "./water-material";
import { createWaterMesh, isBuiltInWaterMesh, setWaterGpuWaves } from "./water-mesh";
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
  // Babylon 9.29 graph clears go through the extension's clearAttachments,
  // which reads the absent WebGL context. NullEngine.clear draws nothing either.
  vi.spyOn(engine, "clearAttachments").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(() => {});
  // Babylon 9.29 NullEngine has no FrameGraph allocation overrides. Adapt only
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

/**
 * The object renderer (by render pass id; a depth pre-pass by its pass name) and the bound target, output or an
 * offscreen texture, of the current draw.
 */
function currentPass(scene: Scene): string {
  const engine = scene.getEngine();
  const id = engine.currentRenderPassId;
  const renderer = scene.objectRenderers.find((candidate) => candidate.renderPassId === id)?.name ?? engine.getCurrentRenderPassName();
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
  // Opaques draw into the own pair; water, transparents and particles after the copy, in the registered pass only
  // (water's depth pre-pass under that pass's own pre-pass id).
  expect(new Set(waterDraws)).toEqual(new Set(["Forward transparent depth pre-pass → texture", "Forward transparent → texture"]));
  expect(opaqueDraws).toEqual(Array(3).fill("Forward objects → texture"));
  expect(glassDraws).toEqual(Array(3).fill("Forward transparent → texture"));
  expect(sparkDraws).toEqual(Array(3).fill("Forward transparent → texture"));

  // Without such water in view (culled; disabled water would also drop its copy intent and re-plan the graph) the
  // direct path draws everything; the split passes stay empty.
  water.isVisible = false;
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

  water.isVisible = true;
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

it("jitters the transparent pass like the opaque draw under temporal anti-aliasing", async () => {
  const { engine, scene, camera } = host();
  // The spatial chain (its geometry pass feeds the resolve's velocity) needs four float targets and depth sampling.
  Object.assign(engine.getCaps(), { maxDrawBuffers: 4, drawBuffersExtension: true, depthTextureExtension: true, textureFloatRender: true, texelFetch: true });
  updateSceneRenderingSettings(scene, { effects: { ...DEFAULT_RENDER_EFFECTS, temporalAntiAliasing: { enabled: true, samples: 8, blend: 0.1 } } });
  lake(scene);
  const wall = box(scene, "wall"), glass = box(scene, "glass", 0.5);
  // The projection each box draws with in the view's object passes, and the pass it draws in.
  const draws = new Map<string, { pass: string; projection: number[] }>();
  for (const mesh of [wall, glass]) {
    mesh.onBeforeRenderObservable.add(() => {
      const pass = currentPass(scene);
      if (pass.startsWith("Forward")) draws.set(mesh.name, { pass, projection: [...scene.getProjectionMatrix().m] });
    });
  }
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toContain("Forward transparent");
  await settle(graph, camera);
  draws.clear();
  expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  expect(draws.get("wall")?.pass).toBe("Forward objects → texture");
  expect(draws.get("glass")?.pass).toBe("Forward transparent → texture");
  // Both draws use this frame's sub-pixel jitter; the camera's own projection stays unjittered.
  expect(draws.get("wall")!.projection).not.toEqual([...camera.getProjectionMatrix().m]);
  expect(draws.get("glass")!.projection).toEqual(draws.get("wall")!.projection);
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
  expect(new Set(waterDraws)).toEqual(new Set(["Forward objects depth pre-pass → output", "Forward objects → output"]));
  // Screen Space reflections march the copy: the same water now plans it.
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "high" } }) });
  expect(graph.readiness(camera)).toEqual({ path: "frameGraph", ready: false, preparationRequired: true });
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toContain("Water scene copy");
  graph.dispose();
});

it("plans no copy for disabled copy-sampling water, authored off or under a deactivated actor, and re-plans when it is enabled", async () => {
  const { engine, scene, camera } = host();
  createWaterMesh(scene, "authored off", normalizeWaterBody({ width: 4, length: 4, resolution: 8, enabled: false }), createDefaultWaterDefinition());
  const actor = new TransformNode("actor", scene);
  actor.setEnabled(false);
  lake(scene).parent = actor;
  /** One frame, then NullEngine's never-completing raw uploads (the water fields) stand in as uploaded. */
  const frame = (render: () => unknown) => {
    render();
    for (const texture of scene.textures) {
      const internal = texture.getInternalTexture();
      if (internal) internal.isReady = true;
    }
  };
  // The water update follows each surface's enabled state, its own and its ancestors', every frame.
  frame(() => scene.render());
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toEqual(DEFAULT_TASKS);
  expect(managedRenderReservations(engine).categoryBytes.water).toBe(0);
  actor.setEnabled(true);
  frame(() => graph.render(camera));
  expect(graph.readiness(camera)).toMatchObject({ ready: false, preparationRequired: true });
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toContain("Water scene copy");
  expect(managedRenderReservations(engine).categoryBytes.water).toBeGreaterThan(0);
  actor.setEnabled(false);
  frame(() => graph.render(camera));
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(graph.taskNames()).toEqual(DEFAULT_TASKS);
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
  // The main object pass never draws copy-sampling water (the transparent pass does): it compiles nothing for it, and
  // neither feature for water that samples no copy.
  const objectsPass = () => scene.objectRenderers.filter((renderer) => renderer.name === "Forward objects").at(-1)!.renderPassId;
  const objects = objectsPass();
  expect(compiled(sampling, objects)).toBe("");
  expect(compiled(plain, objects)).toContain("#define SLATE_WATER\n");
  expect(compiled(plain, objects)).not.toContain("SLATE_WATER_REFRACTION\n");
  expect(compiled(plain, objects)).not.toContain("SLATE_WATER_SSR\n");
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

/** The kind of a water effect, from its defines: depth pre-pass, or colour with or without the scene copy's features. */
function waterVariant(defines: string): string {
  if (defines.includes("#define DEPTHPREPASS\n")) return "depth";
  return defines.includes("#define SLATE_WATER_REFRACTION\n") ? "colour with copy" : "colour without copy";
}

/** Every water variant the engine has compiled. */
function compiledWaterVariants(engine: NullEngine): string[] {
  const effects = (engine as unknown as { _compiledEffects: Record<string, { defines: string }> })._compiledEffects;
  return Object.values(effects).filter((effect) => /#define SLATE_WATER\n/.test(effect.defines ?? ""))
    .map((effect) => waterVariant(effect.defines)).sort();
}

it("compiles the water variants the view draws before its first frame, and none it never draws", async () => {
  const { engine, scene, camera } = host();
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "ultra" } }) });
  const water = lake(scene, { ...createDefaultWaterDefinition(), refraction: 0.35 });
  const drawn = new Set<string>();
  water.onAfterRenderObservable.add(() => drawn.add(waterVariant(water.subMeshes[0]!.effect?.defines ?? "")));
  // The load's order: the shader warm-up first, then the view's graph is prepared.
  await prewarmSceneMaterials(scene, undefined, isBuiltInWaterMesh);
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  // Water the view draws through its scene copy: the drawn colour variant and its depth pre-pass, nothing else.
  expect(compiledWaterVariants(engine)).toEqual(["colour with copy", "depth"]);
  await settle(graph, camera);
  expect([...drawn].sort()).toEqual(["colour with copy", "depth"]);
  expect(compiledWaterVariants(engine)).toEqual(["colour with copy", "depth"]);
  // A stale plan (a Refraction Resolution change) is probed by the render loop until the re-plan: it still draws
  // through a copy, so the probe compiles no copy-less variant.
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "ultra", refractionScale: 0.75 } }) });
  expect(graph.readiness(camera)).toMatchObject({ ready: false, preparationRequired: true });
  graph.sceneStrictlyReady(camera);
  expect(compiledWaterVariants(engine)).toEqual(["colour with copy", "depth"]);
  // Low plans no copy: the re-plan compiles the variant the main pass then draws before the next frame.
  drawn.clear();
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "low" } }) });
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  const replanned = compiledWaterVariants(engine);
  expect(replanned).toContain("colour without copy");
  await settle(graph, camera);
  expect([...drawn].sort()).toEqual(["colour without copy", "depth"]);
  expect(compiledWaterVariants(engine)).toEqual(replanned);
  graph.dispose();
});

it("leaves a view without a scene copy's water to the graph's probe, which compiles the variant it draws", async () => {
  const { engine, scene, camera } = host();
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "low" } }) });
  const water = lake(scene, { ...createDefaultWaterDefinition(), refraction: 0.35 });
  const drawn = new Set<string>();
  water.onAfterRenderObservable.add(() => drawn.add(waterVariant(water.subMeshes[0]!.effect?.defines ?? "")));
  await prewarmSceneMaterials(scene, undefined, isBuiltInWaterMesh);
  const graph = new ForwardSceneFrameGraph(scene);
  expect(graph.sceneStrictlyReady(camera)).toBe(true);
  expect(compiledWaterVariants(engine)).toEqual([]);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(compiledWaterVariants(engine)).toEqual(["colour without copy", "depth"]);
  await settle(graph, camera);
  expect([...drawn].sort()).toEqual(["colour without copy", "depth"]);
  expect(compiledWaterVariants(engine)).toEqual(["colour without copy", "depth"]);
  graph.dispose();
});

it("compiles no pass-less water variant when the view's scene copy cannot be planned during the warm-up", async () => {
  const { engine, scene, camera } = host();
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "ultra" } }) });
  const water = lake(scene, { ...createDefaultWaterDefinition(), refraction: 0.35 });
  const drawn = new Set<string>();
  water.onAfterRenderObservable.add(() => drawn.add(waterVariant(water.subMeshes[0]!.effect?.defines ?? "")));
  // With no camera the plan has no demand yet; the load's camera arrives before the graph prepares.
  scene.activeCamera = null;
  await prewarmSceneMaterials(scene, undefined, isBuiltInWaterMesh);
  scene.activeCamera = camera;
  const graph = new ForwardSceneFrameGraph(scene);
  expect(graph.sceneStrictlyReady(camera)).toBe(true);
  expect(compiledWaterVariants(engine)).toEqual([]);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(compiledWaterVariants(engine)).toEqual(["colour with copy", "depth"]);
  await settle(graph, camera);
  expect([...drawn].sort()).toEqual(["colour with copy", "depth"]);
  expect(compiledWaterVariants(engine)).toEqual(["colour with copy", "depth"]);
  graph.dispose();
});

/**
 * A parallel-compile driver (KHR_parallel_shader_compile) that keeps each water link pending until released: the
 * driver reports a link's completion only, so its effect stays unready while the graph goes on probing. `requested`
 * lists the water variants asked for so far, in order.
 */
function holdWaterLinks(engine: NullEngine) {
  engine.getCaps().parallelShaderCompile = { COMPLETION_STATUS_KHR: 0x91b1 };
  const held: Effect[] = [];
  const released = new Set<Effect>();
  let holding = true;
  const createEffect = engine.createEffect.bind(engine);
  vi.spyOn(engine, "createEffect").mockImplementation((...args) => {
    const effect = createEffect(...args);
    if (!held.includes(effect) && /#define SLATE_WATER\n/.test(effect.defines)) {
      held.push(effect);
      if (!holding) released.add(effect);
      const isReady = effect.isReady.bind(effect);
      vi.spyOn(effect, "isReady").mockImplementation(() => released.has(effect) && isReady());
    }
    return effect;
  });
  return {
    requested: () => held.map((effect) => effect.defines.includes("#define PREPASS\n") ? "geometry" : waterVariant(effect.defines)),
    /** The defines of every link requested so far. */
    requestedDefines: () => held.map((effect) => effect.defines),
    /** Finish the first `count` links requested. */
    release: (count: number) => { for (const effect of held.slice(0, count)) released.add(effect); },
    /** Finish every link, and later ones as they are requested. */
    releaseAll: () => { holding = false; for (const effect of held) released.add(effect); },
    /** Hold the links requested from now on. */
    hold: () => { holding = true; },
  };
}

/**
 * A body that refracts and reflects objects, one that only refracts with CPU-displaced vertices and one that only
 * refracts, side by side, warmed as a load warms: three bodies whose variants all differ and all sample the scene copy.
 */
async function threeWaterBodies(scene: Scene): Promise<Mesh[]> {
  const refracting = { ...createDefaultWaterDefinition(), objectReflections: false };
  const looks = [createDefaultWaterDefinition(), refracting, refracting];
  const bodies = looks.map((water, index) => {
    const mesh = createWaterMesh(scene, `water-${index}`, normalizeWaterBody({ width: 4, length: 4, resolution: 8 }), { ...water });
    mesh.position.x = (index - 1) * 4;
    return mesh;
  });
  setWaterGpuWaves(bodies[1]!, false);
  // The switch holds the material's previous program back until its next bind (its vertex layout changed); nothing has
  // drawn the previous one here, so it keeps hot swapping like the others.
  bodies[1]!.material!.allowShaderHotSwapping = true;
  await prewarmSceneMaterials(scene, undefined, isBuiltInWaterMesh);
  return bodies;
}

/** Time for the graph's readiness loop, which probes every 16 ms, to probe several more times. */
const moreProbes = () => new Promise((resolve) => setTimeout(resolve, 100));

it("links the next water bodies' variants while the first still links, a bounded number at a time", async () => {
  const { engine, scene, camera } = host();
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "ultra" } }) });
  await threeWaterBodies(scene);
  const links = holdWaterLinks(engine);
  const graph = new ForwardSceneFrameGraph(scene);
  const prepared = graph.prepare(camera);
  // Each body draws a colour variant and a depth pre-pass: more links than may be pending at once.
  expect(COMPILE_AHEAD_LIMIT + 1).toBeLessThan(6);
  // The probe waits on the first body's colour variant; its depth pre-pass and the next body link meanwhile.
  await vi.waitFor(() => expect(links.requested().length).toBeGreaterThan(2));
  expect(links.requested().slice(0, 2)).toEqual(["colour with copy", "depth"]);
  await moreProbes();
  const pending = links.requested().length;
  expect(pending).toBeLessThanOrEqual(COMPILE_AHEAD_LIMIT + 1);
  // While none finishes, none more starts; as one finishes, the next start.
  await moreProbes();
  expect(links.requested()).toHaveLength(pending);
  links.release(1);
  await vi.waitFor(() => expect(links.requested().length).toBeGreaterThan(pending));
  links.releaseAll();
  expect(await prepared).toEqual({ path: "frameGraph" });
  // Each body's two variants, once each: nothing linked that no pass draws.
  expect(compiledWaterVariants(engine)).toEqual(["colour with copy", "colour with copy", "colour with copy", "depth", "depth", "depth"]);
  // The next readiness episode links ahead again: fog changes every body's variants (outside Scene observables, so
  // the change marks readiness dirty itself).
  const episode = links.requested().length;
  links.hold();
  scene.fogMode = Scene.FOGMODE_EXP2;
  graph.markReadinessDirty();
  expect(graph.readiness(camera).ready).toBe(false);
  expect(links.requested().length - episode).toBeGreaterThan(2);
  links.releaseAll();
  await vi.waitFor(() => expect(graph.readiness(camera).ready).toBe(true));
  graph.dispose();
});

it("links the transparent pass's water while an earlier geometry pass still links its own", async () => {
  const { engine, scene, camera } = host();
  // The spatial chain (its geometry pass feeds the resolve's velocity) needs four float targets and depth sampling.
  Object.assign(engine.getCaps(), { maxDrawBuffers: 4, drawBuffersExtension: true, depthTextureExtension: true, textureFloatRender: true, texelFetch: true });
  updateSceneRenderingSettings(scene, {
    quality: normalizeRenderingQuality({ water: { profile: "ultra" } }),
    effects: { ...DEFAULT_RENDER_EFFECTS, temporalAntiAliasing: { enabled: true, samples: 8, blend: 0.1 } },
  });
  await threeWaterBodies(scene);
  const links = holdWaterLinks(engine);
  const graph = new ForwardSceneFrameGraph(scene);
  const prepared = graph.prepare(camera);
  // The geometry pass, which runs before the object passes, waits on the first body; the other bodies' geometry
  // variants and the transparent pass's first variant link meanwhile.
  await vi.waitFor(() => expect(links.requested()).toContain("colour with copy"));
  expect(links.requested()[0]).toBe("geometry");
  expect(links.requested().filter((variant) => variant === "geometry").length).toBeGreaterThan(1);
  links.releaseAll();
  expect(await prepared).toEqual({ path: "frameGraph" });
  graph.dispose();
});

it.each([["transparent", false], ["geometry", true]] as const)(
  "links ahead again, in the %s pass, the water it already linked ahead once a change mid-load gives it new variants",
  async (_pass, geometry) => {
    const { engine, scene, camera } = host();
    // The spatial chain (its geometry pass feeds the resolve's velocity) needs four float targets and depth sampling.
    if (geometry) Object.assign(engine.getCaps(), { maxDrawBuffers: 4, drawBuffersExtension: true, depthTextureExtension: true, textureFloatRender: true, texelFetch: true });
    updateSceneRenderingSettings(scene, {
      quality: normalizeRenderingQuality({ water: { profile: "ultra" } }),
      ...(geometry ? { effects: { ...DEFAULT_RENDER_EFFECTS, temporalAntiAliasing: { enabled: true, samples: 8, blend: 0.1 } } } : {}),
    });
    const [first, second] = await threeWaterBodies(scene);
    const links = holdWaterLinks(engine);
    const graph = new ForwardSceneFrameGraph(scene);
    const prepared = graph.prepare(camera);
    // The pass's probe waits on the first body and has linked the second body's variants ahead.
    await vi.waitFor(() => expect(links.requested().length).toBeGreaterThan(2));
    const pass = geometry
      ? scene.objectRenderers.find((renderer) => renderer.name === "Spatial Geometry")!.renderPassId
      : graph.waterSceneCopyDiagnostics()!.renderPassId;
    /** Whether the pass holds `mesh`'s fog variant. */
    const fogged = (mesh: Mesh) => /#define FOG\n/.test(mesh.subMeshes[0]!._getDrawWrapper(pass)?.effect?.defines ?? "");
    expect([fogged(first!), fogged(second!)]).toEqual([false, false]);
    /** Whether the pass's fog variant of a GPU-displaced body (first) or the CPU-displaced second body was requested. */
    const fogLinked = (second: boolean) => links.requestedDefines().some((defines) =>
      defines.includes("#define FOG\n") && defines.includes("#define PREPASS\n") === geometry
      && !defines.includes("#define DEPTHPREPASS\n") && defines.includes("#define SLATE_WATER_GPU_WAVES\n") === !second);
    // Fog gives every body new variants before the load is ready (outside Scene observables, so the change marks
    // readiness dirty itself) and the links requested so far finish. The probe waits on the first body's new
    // variant, and the second body's link ahead again meanwhile; both keep their previous variants until then.
    scene.fogMode = Scene.FOGMODE_EXP2;
    graph.markReadinessDirty();
    links.release(links.requested().length);
    await vi.waitFor(() => expect([fogLinked(false), fogLinked(true)]).toEqual([true, true]));
    expect([fogged(first!), fogged(second!)]).toEqual([false, false]);
    links.releaseAll();
    expect(await prepared).toEqual({ path: "frameGraph" });
    expect([fogged(first!), fogged(second!)]).toEqual([true, true]);
    graph.dispose();
  },
);

it("names only water with the built-in material as built-in, so a Custom Material water mesh is still warmed", () => {
  const { scene } = host();
  const custom = createWaterMesh(scene, "custom", normalizeWaterBody({ width: 4, length: 4, resolution: 8 }), createDefaultWaterDefinition(), new StandardMaterial("custom", scene));
  expect(isBuiltInWaterMesh(lake(scene))).toBe(true);
  expect(isBuiltInWaterMesh(custom)).toBe(false);
  expect(isBuiltInWaterMesh(box(scene, "crate"))).toBe(false);
});

it("keeps frozen Play water's colour draw on its full variant when a tilt re-prepares it without a readiness probe", async () => {
  const { engine, scene, camera } = host();
  scene.performancePriority = ScenePerformancePriority.Intermediate;
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { profile: "ultra" } }) });
  const water = lake(scene, { ...createDefaultWaterDefinition(), refraction: 0.35, objectReflections: true });
  const material = water.material as PBRMaterial;
  const plugin = material.pluginManager!.getPlugin<WaterMaterialPlugin>("SlateWater")!;
  /** Each completed water draw: colour writes, whether the effect is the depth-only variant, and the planar define. */
  const draws: string[] = [];
  water.onAfterRenderObservable.add(() => {
    const defines = water.subMeshes[0]!.effect?.defines ?? "";
    const variant = defines.includes("#define DEPTHPREPASS\n") ? "depth-only" : "full";
    draws.push(`${engine.getColorWrite() ? "colour" : "depth"}:${variant}:${defines.includes("#define SLATE_WATER_PLANAR\n") ? "planar" : "no planar"}`);
  });
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  await settle(graph, camera);
  const frame = () => {
    draws.length = 0;
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
    return [...draws];
  };
  expect(frame()).toEqual(["depth:depth-only:planar", "colour:full:planar"]);
  expect(material.isFrozen).toBe(true);
  // A volume tilted out of level drops the planar reflection (water-mesh sets `flat`): the defines change and the
  // frozen material is marked dirty with no readiness probe. Each draw re-prepares its own variant.
  plugin.flat = false;
  for (let i = 0; i < 3; i++) expect(frame()).toEqual(["depth:depth-only:no planar", "colour:full:no planar"]);
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
