import {
  FreeCamera,
  MeshBuilder,
  NullEngine,
  Scene,
  StandardMaterial,
  Vector3,
  type Mesh,
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
function host({ sharedDepth = true } = {}) {
  const engine = new NullEngine();
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

/** Name of the object renderer each draw of `mesh` happened in, by its render pass id. */
function drawnBy(scene: Scene, mesh: Mesh): string[] {
  const passes: string[] = [];
  mesh.onBeforeRenderObservable.add(() => {
    const id = scene.getEngine().currentRenderPassId;
    passes.push(scene.objectRenderers.find((renderer) => renderer.renderPassId === id)?.name ?? `pass ${id}`);
  });
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
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  // The split switches the output clear too, so it decides before that clear runs.
  expect(graph.taskNames()).toEqual([
    "Forward admitted shadows", "Clustered light mask", "Forward cull", "Water split", "Forward clear",
    "Forward objects", "Water clear", "Water opaque", "Water scene copy", "Forward transparent", "Water output",
  ]);
  await settle(graph, camera);
  // Exactly one scene clear per frame, including frames where the split swaps paths.
  const clears = vi.spyOn(FrameGraphRenderContext.prototype, "clearAttachments");
  let work = frames(graph, () => {
    waterDraws.length = opaqueDraws.length = glassDraws.length = 0;
    for (let frame = 0; frame < 3; frame += 1) expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  expect(work).toEqual({ frames: 3, visibleFrames: 3, copies: 3 });
  expect(clears).toHaveBeenCalledTimes(3);
  expect(graph.waterSceneCopyDiagnostics()).toMatchObject({ ownTargets: true, scale: 0.5 });
  // Water draws after the copy, with its depth pre-pass, in the registered pass only.
  expect(new Set(waterDraws)).toEqual(new Set(["Forward transparent"]));
  expect(opaqueDraws).toEqual(["Water opaque", "Water opaque", "Water opaque"]);
  expect(glassDraws).toEqual(["Forward transparent", "Forward transparent", "Forward transparent"]);

  // Without such water in view the direct path draws everything; the split passes stay empty.
  water.setEnabled(false);
  work = frames(graph, () => {
    waterDraws.length = opaqueDraws.length = glassDraws.length = 0;
    for (let frame = 0; frame < 3; frame += 1) expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  expect(work).toEqual({ frames: 3, visibleFrames: 0, copies: 0 });
  expect(clears).toHaveBeenCalledTimes(6);
  expect(waterDraws).toEqual([]);
  expect(opaqueDraws).toEqual(["Forward objects", "Forward objects", "Forward objects"]);
  expect(glassDraws).toEqual(["Forward objects", "Forward objects", "Forward objects"]);

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
    glassDraws.length = 0;
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  expect(work).toEqual({ frames: 1, visibleFrames: 1, copies: 1 });
  expect(glassDraws).toEqual(["Forward transparent"]);
  // Enabled water outside the view frustum is not in the cull output: nothing is deferred or copied.
  water.position.x = 500;
  // Moving a surface rebuilds its contact field.
  await settle(graph, camera);
  work = frames(graph, () => {
    glassDraws.length = 0;
    expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  expect(work).toEqual({ frames: 1, visibleFrames: 0, copies: 0 });
  expect(glassDraws).toEqual(["Forward objects"]);
  graph.dispose();
});

it("never copies for water whose asset samples neither refraction nor reflections", async () => {
  const { scene, camera } = host();
  const water = lake(scene, { ...createDefaultWaterDefinition(), refraction: 0, objectReflections: false });
  const waterDraws = drawnBy(scene, water);
  const graph = new ForwardSceneFrameGraph(scene);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  await settle(graph, camera);
  const work = frames(graph, () => {
    waterDraws.length = 0;
    for (let frame = 0; frame < 3; frame += 1) expect(graph.render(camera)).toEqual({ path: "frameGraph" });
  });
  expect(work).toEqual({ frames: 3, visibleFrames: 0, copies: 0 });
  expect(new Set(waterDraws)).toEqual(new Set(["Forward objects"]));
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
