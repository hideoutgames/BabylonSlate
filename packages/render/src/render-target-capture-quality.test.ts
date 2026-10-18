import {
  CascadedShadowGenerator, Constants, DirectionalLight, FreeCamera, Mesh, MeshBuilder, NullEngine, NullEngineOptions, ParticleSystem,
  Scene, SpotLight, StandardMaterial, UniversalCamera, Vector3, type Camera, type ShadowGenerator,
} from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultRenderTargetCaptureProperties, createDefaultWaterDefinition, normalizeShadowSettings, normalizeWaterBody,
  outlineBindings, type RenderTargetCaptureQuality,
} from "@babylonslate/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { SceneOutlineHost } from "./scene-outline-host";
import { limitManagedRenderBytes, managedRenderReservations } from "./managed-render-resources";
import { RenderTargetCaptures } from "./render-target-capture";
import { updateSceneRenderingSettings } from "./render-settings";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { sceneShadowController } from "./shadow-controller";
import { enableHeadlessCascades } from "./shadow-test-fixtures";
import { configureEditorRenderingGroups } from "./sorting";
import { createWaterMesh } from "./water-mesh";
import { isMainWaterPass, waterSceneCopyForPass } from "./water-scene-copy";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/**
 * A scene view (the editor viewport or Play) over a lake, a pier box and an
 * editor helper, with one capture aimed at the lake. The capture renders from
 * the view's own frame, as in the editor and Play.
 */
function host(quality: RenderTargetCaptureQuality) {
  const options = new NullEngineOptions();
  options.renderWidth = 96;
  options.renderHeight = 64;
  const engine = adaptNullEngineFrameGraph(new NullEngine(options));
  engines.push(engine);
  // Refraction samples a half-float scene copy.
  engine.getCaps().textureHalfFloatRender = true;
  // NullEngine does not record the GPU allocator's format metadata.
  const allocate = engine.createRenderTargetTexture.bind(engine);
  vi.spyOn(engine, "createRenderTargetTexture").mockImplementation((size, creation) => {
    const target = allocate(size, creation);
    target.texture!.format = Constants.TEXTUREFORMAT_RGBA;
    return target;
  });
  const scene = new Scene(engine);
  configureEditorRenderingGroups(scene);
  const camera = new FreeCamera("Main Camera", new Vector3(0, 6, -12), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 4, length: 4, resolution: 8 }),
    { ...createDefaultWaterDefinition(), refraction: 0.35 });
  const pier = MeshBuilder.CreateBox("pier", {}, scene);
  pier.material = new StandardMaterial("pier", scene);
  pier.position.y = 0.5;
  const helper = MeshBuilder.CreateBox("helper", {}, scene);
  helper.metadata = { editorHelper: true };
  const view = new SceneRenderCoordinator(scene);
  const captures = new RenderTargetCaptures(scene);
  captures.setAssets(new Map([["target", { mode: "SceneColor", width: 32, height: 16 }]]),
    new Map([["texture", { renderTargetGuid: "target" }]]));
  const root = new Mesh("Capture Root", scene);
  root.position.set(0, 5, -6);
  root.lookAt(Vector3.Zero());
  const settings = { ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: "target", quality };
  captures.configure("capture", settings, () => root);
  const output = captures.acquireTexture("texture")!.resource;
  return { engine, scene, camera, lake, pier, helper, view, captures, root, settings, output };
}

/** Compiled defines of `mesh` in render pass `pass` ("" before that pass has an effect). */
function compiled(mesh: Mesh, pass: number): string {
  return mesh.subMeshes[0]!._getDrawWrapper(pass)?.effect?.defines ?? "";
}

/**
 * Render scene view frames until the capture publishes. NullEngine never
 * completes a raw upload, so stand in for the water field textures' GPU upload.
 */
async function untilPublished(scene: Scene, view: SceneRenderCoordinator, captures: RenderTargetCaptures): Promise<void> {
  await vi.waitFor(() => {
    for (const texture of scene.textures) {
      const internal = texture.getInternalTexture();
      if (internal) internal.isReady = true;
    }
    view.render();
    expect(captures.diagnostics()[0]?.published).toBe(true);
  }, { timeout: 5000 });
}

it("keeps Fast on the lightweight capture pass: no forward view and no water scene copy", async () => {
  const { scene, lake, view, captures, output } = host("fast");
  await untilPublished(scene, view, captures);
  expect(captures.diagnostics()).toEqual([{
    actorId: "capture", renderTargetGuid: "target", quality: "fast", published: true, taskNames: [], waterSceneCopyPass: null,
    strictReadinessChecks: 0,
  }]);
  const capturePass = scene.objectRenderers.find((renderer) => renderer.name === "renderTarget:target")!.renderPassId;
  expect(compiled(lake, capturePass)).toContain("#define SLATE_WATER\n");
  expect(compiled(lake, capturePass)).not.toContain("SLATE_WATER_REFRACTION\n");
  expect(isMainWaterPass(scene, capturePass)).toBe(false);
  expect(output.getInternalTexture()).toBe(scene.textures.find((texture) => texture.name === "renderTarget:target")!.getInternalTexture());
  view.dispose();
});

it("renders Full Quality through the forward pipeline with its own scene copy, without disturbing the scene view", async () => {
  const { scene, camera, lake, pier, helper, view, captures, output } = host("fullQuality");
  /** Cameras `mesh` was drawn for. */
  const drawnFor = (mesh: Mesh) => {
    const cameras = new Set<string>();
    mesh.onBeforeRenderObservable.add(() => cameras.add(scene.activeCamera?.name ?? ""));
    return cameras;
  };
  const pierCameras = drawnFor(pier), helperCameras = drawnFor(helper);
  await untilPublished(scene, view, captures);
  const [capture] = captures.diagnostics();
  expect(capture).toMatchObject({ quality: "fullQuality", published: true });
  expect(capture!.taskNames).toEqual(expect.arrayContaining([
    "Forward admitted shadows", "Forward objects", "Water scene copy", "Forward transparent", "Capture output",
  ]));
  // Water compiles refraction in the capture's own transparent pass, which samples the capture's own copy.
  const pass = capture!.waterSceneCopyPass!;
  expect(isMainWaterPass(scene, pass)).toBe(true);
  expect(waterSceneCopyForPass(scene, pass)!.invSize).toEqual([1 / 32, 1 / 16]);
  expect(compiled(lake, pass)).toContain("#define SLATE_WATER_REFRACTION\n");
  // The scene view keeps its own pass, camera and published output.
  const viewObjects = scene.objectRenderers.filter((renderer) => renderer.name === "Forward objects")
    .map((renderer) => renderer.renderPassId);
  expect(viewObjects).toHaveLength(2);
  expect(scene.activeCamera).toBe(camera);
  const captureCamera = scene.cameras.find((entry) => entry.name === "renderTargetCapture:capture")!;
  expect(output.getInternalTexture()).toBe(captureCamera.outputRenderTarget!.getInternalTexture());
  // The view draws into its own scene targets: the output holds colour only.
  expect(captureCamera.outputRenderTarget!.depthStencilTexture).toBeNull();
  // Editor helpers stay out of the capture, and the capture compiles nothing for them; world geometry draws in both views.
  expect(pierCameras).toEqual(new Set(["Main Camera", "renderTargetCapture:capture"]));
  expect(helperCameras).toEqual(new Set(["Main Camera"]));
  expect(compiled(helper, captureCamera.renderPassId)).toBe("");
  // Steady frames re-probe neither view: each view's camera swaps are not authored camera changes for the other.
  view.render();
  const checks = view.strictReadinessChecks;
  const captureChecks = captures.diagnostics()[0]!.strictReadinessChecks;
  for (let frame = 0; frame < 3; frame += 1) expect(view.render()).toMatchObject({ rendered: true, readyForPresentation: true });
  expect(view.strictReadinessChecks).toBe(checks);
  expect(captures.diagnostics()[0]).toMatchObject({ published: true, strictReadinessChecks: captureChecks });
  view.dispose();
});

it("draws a Full Quality capture after the frame's evaluation, so it shows this frame's particle step", async () => {
  const { scene, view, captures } = host("fullQuality");
  const emitter = new Mesh("particleEmitter:test", scene);
  emitter.alwaysSelectAsActiveMesh = true;
  const system = new ParticleSystem("sparks", 8, scene);
  system.emitter = emitter;
  system.start();
  vi.spyOn(system, "isReady").mockReturnValue(true);
  const events: string[] = [];
  const animate = system.animate.bind(system);
  vi.spyOn(system, "animate").mockImplementation((preWarm) => { events.push("step"); animate(preWarm); });
  vi.spyOn(system, "render").mockImplementation(() => {
    events.push(scene.activeCamera?.name === "renderTargetCapture:capture" ? "capture" : "view");
    return 0;
  });
  await untilPublished(scene, view, captures);
  events.length = 0;
  expect(view.render()).toMatchObject({ rendered: true });
  // The emitter mesh has no geometry, as the particle service builds them.
  expect(events).toEqual(["step", "capture", "view"]);
  view.dispose();
});

it("draws gameplay outlines in a Full Quality capture but never the editor selection", async () => {
  const { scene, pier, view, captures } = host("fullQuality");
  const outlines = new SceneOutlineHost(scene, view, () => {});
  captures.setOutlines((renderer) => outlines.attachCaptureView(renderer));
  outlines.replaceActors([{ id: "pier", meshes: [pier], bindings: [] }]);
  outlines.setSelection(["pier"]);
  await untilPublished(scene, view, captures);
  expect(view.taskNames()).toContain("Shared outlines");
  expect(captures.diagnostics()[0]!.taskNames).not.toContain("Shared outlines");
  // An Outline component is a game visual: the capture draws it as the view does.
  const ink = outlineBindings("pier", [{ id: "ink", classId: "OutlineComponent", properties: { color: [1, 0, 0], width: 2 } }]);
  outlines.replaceActors([{ id: "pier", meshes: [pier], bindings: ink }]);
  await vi.waitFor(() => {
    view.render();
    expect(captures.diagnostics()[0]!.taskNames).toContain("Shared outlines");
  }, { timeout: 5000 });
  outlines.dispose();
  view.dispose();
});

it("draws only the captured actors' outlines in a Capture Only Actors capture", async () => {
  const { scene, pier, view, captures, root, settings } = host("fullQuality");
  const post = MeshBuilder.CreateBox("post", {}, scene);
  post.position.x = 2;
  captures.registerActor("pier", () => pier);
  captures.registerActor("post", () => post);
  const outlines = new SceneOutlineHost(scene, view, () => {});
  captures.setOutlines((renderer, includes) => outlines.attachCaptureView(renderer, includes));
  const ink = outlineBindings("pier", [{ id: "ink", classId: "OutlineComponent", properties: { color: [1, 0, 0], width: 2 } }]);
  outlines.replaceActors([{ id: "pier", meshes: [pier], bindings: ink }, { id: "post", meshes: [post], bindings: [] }]);
  captures.configure("capture", { ...settings, captureOnlyActors: true, actorIds: ["post"] }, () => root);
  await untilPublished(scene, view, captures);
  for (let frame = 0; frame < 3; frame++) view.render();
  // The scene view outlines the pier; the capture, which leaves the pier out, does not.
  expect(view.taskNames()).toContain("Shared outlines");
  expect(captures.diagnostics()[0]!.taskNames).not.toContain("Shared outlines");
  // Capturing the pier as well brings its outline into the capture.
  captures.configure("capture", { ...settings, captureOnlyActors: true, actorIds: ["post", "pier"] }, () => root);
  await vi.waitFor(() => {
    view.render();
    expect(captures.diagnostics()[0]!.taskNames).toContain("Shared outlines");
  }, { timeout: 5000 });
  outlines.dispose();
  view.dispose();
});

it("keeps the scene view's frame and the capture's last image when a Full Quality capture fails to draw", async () => {
  const { scene, view, captures, output } = host("fullQuality");
  await untilPublished(scene, view, captures);
  const image = output.getInternalTexture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const render = ForwardSceneFrameGraph.prototype.render;
  vi.spyOn(ForwardSceneFrameGraph.prototype, "render").mockImplementation(
    function (this: ForwardSceneFrameGraph, camera: Camera, updateCameras?: boolean, reuseAdmission?: boolean) {
      if (camera.name.startsWith("renderTargetCapture:")) throw new Error("capture draw failed");
      return render.call(this, camera, updateCameras, reuseAdmission);
    });
  for (let frame = 0; frame < 3; frame++) expect(view.render()).toMatchObject({ rendered: true });
  expect(captures.diagnostics()[0]).toMatchObject({ published: true });
  expect(output.getInternalTexture()).toBe(image);
  expect(warn.mock.calls.filter(([message]) => String(message).includes("capture draw failed"))).toHaveLength(1);
  view.dispose();
});

it("retries a failed Full Quality preparation at most once a second and warns once", async () => {
  const { scene, view, captures } = host("fullQuality");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // A refused budget for the capture's own scene targets (only auxiliary views declare them).
  const refuse = vi.spyOn(ForwardSceneFrameGraph.prototype as unknown as { declareOwnSceneTargets: () => never }, "declareOwnSceneTargets")
    .mockImplementation(() => { throw new Error("Capture scene targets exceed the shared rendering budget."); });
  const frames = async (count: number) => {
    for (let frame = 0; frame < count; frame++) {
      view.render();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await vi.waitFor(() => { view.render(); expect(refuse).toHaveBeenCalled(); }, { timeout: 5000 });
  await frames(15);
  expect(refuse).toHaveBeenCalledTimes(1);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  await frames(3);
  expect(refuse).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls.filter(([message]) => String(message).includes("Full Quality capture"))).toHaveLength(1);
  expect(captures.diagnostics()[0]!.published).toBe(false);
  // Once the budget admits it, the next retry draws the capture.
  refuse.mockRestore();
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  await untilPublished(scene, view, captures);
  view.dispose();
}, 15_000);

/**
 * A scene view over a box on a floor under a cascaded, shadowed sun and an
 * unranged shadowed spot, with one Full Quality capture far from the scene
 * camera, with a different lens and clip range.
 */
function shadowedHost() {
  const options = new NullEngineOptions();
  options.renderWidth = 96;
  options.renderHeight = 64;
  const engine = adaptNullEngineFrameGraph(new NullEngine(options));
  engines.push(engine);
  Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16 });
  enableHeadlessCascades(engine);
  const allocate = engine.createRenderTargetTexture.bind(engine);
  engine.createRenderTargetTexture = (size, creation) => {
    const target = allocate(size, creation);
    // NullEngine does not record the requested format.
    target.texture!.format = typeof creation === "object" && creation.format !== undefined ? creation.format : Constants.TEXTUREFORMAT_RGBA;
    return target;
  };
  const scene = new Scene(engine);
  configureEditorRenderingGroups(scene);
  const camera = new UniversalCamera("Main Camera", new Vector3(0, 3, -12), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  updateSceneRenderingSettings(scene, {
    shadows: normalizeShadowSettings({ cascades: 2, distance: 40, mapSize: 256, localMapSize: 256, maxLocalLights: 1 }),
  });
  const material = new StandardMaterial("opaque", scene);
  const box = MeshBuilder.CreateBox("caster", {}, scene);
  box.position.y = 1;
  box.material = material;
  const floor = MeshBuilder.CreateGround("floor", { width: 20, height: 20 }, scene);
  floor.material = material;
  const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
  // Unbounded range: its depth range comes from the camera unless fitted explicitly.
  const spot = new SpotLight("spot", new Vector3(0, 4, -2), new Vector3(0, -1, 0.4), Math.PI / 2, 1, scene);
  const controller = sceneShadowController(scene);
  controller.register(sun, true);
  controller.register(spot, true);
  controller.sync();
  const view = new SceneRenderCoordinator(scene);
  const captures = new RenderTargetCaptures(scene);
  captures.setAssets(new Map([["target", { mode: "SceneColor", width: 32, height: 16 }]]),
    new Map([["texture", { renderTargetGuid: "target" }]]));
  const lens = new Mesh("Lens", scene);
  lens.position.set(30, 4, 30);
  lens.lookAt(new Vector3(30, 0, 40));
  // A visible geometry-less caster would keep the maps redrawing by itself.
  lens.isVisible = false;
  const settings = { ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: "target",
    quality: "fullQuality" as const, fieldOfView: 40, nearClip: 0.5, farClip: 60 };
  captures.configure("capture", settings, () => lens);
  captures.acquireTexture("texture");
  const captureCamera = () => scene.cameras.find((entry) => entry.name === "renderTargetCapture:capture");
  return { engine, scene, camera, sun, spot, controller, view, captures, lens, settings, captureCamera };
}

/** Actual passes (one per face or cascade) of a map; readiness probes do not clear. */
function passes(generator: ShadowGenerator): () => number {
  let count = 0;
  generator.getShadowMap()!.onClearObservable.add(() => { count++; });
  return () => count;
}

it("draws a Full Quality capture's own sun maps, fitted to its camera, and leaves the scene view's maps as they were", async () => {
  const { scene, camera, sun, spot, controller, view, captures, captureCamera } = shadowedHost();
  const main = controller.generator(sun) as CascadedShadowGenerator;
  const local = controller.generator(spot)!;
  const mainPasses = passes(main), localPasses = passes(local);
  // Each frame executes the scene view's graph and, inside its frame, the capture's.
  // (A render hook on a caster would make the maps redraw every frame by themselves.)
  const executes = vi.spyOn(FrameGraph.prototype, "execute");
  await untilPublished(scene, view, captures);
  const capture = captureCamera()!;
  // The capture's sun map is the controller's, keyed to the capture camera, with the scene map's allocation.
  const own = sun.getShadowGenerator(capture) as CascadedShadowGenerator;
  expect(own).toBeInstanceOf(CascadedShadowGenerator);
  expect(own).toBe(controller.viewBoundGenerator(sun, capture));
  expect(own.camera).toBe(capture);
  expect(own.numCascades).toBe(main.numCascades);
  expect(own.getShadowMap()!.getSize()).toEqual(main.getShadowMap()!.getSize());
  // The scene view keeps binding its own map; the spot map is shared.
  expect(sun.getShadowGenerator()).toBe(main);
  expect(spot.getShadowGenerators()?.size).toBe(1);
  // Settle: a map's first draws feed its next snapshot once.
  for (let frame = 0; frame < 5; frame++) view.render();
  const mainFit = Array.from({ length: main.numCascades }, (_, layer) => [...main.getCascadeTransformMatrix(layer)!.m]);
  const ownPasses = passes(own);
  const before = { main: mainPasses(), local: localPasses(), executes: executes.mock.calls.length };
  for (let frame = 0; frame < 4; frame++) expect(view.render()).toMatchObject({ rendered: true });
  expect(executes.mock.calls.length - before.executes).toBe(8);
  // The scene view's maps stay cached and keep their cascade fit; the capture redraws its own each captured frame.
  expect(mainPasses() - before.main).toBe(0);
  expect(localPasses() - before.local).toBe(0);
  expect(ownPasses()).toBe(4 * own.numCascades);
  expect(Array.from({ length: main.numCascades }, (_, layer) => [...main.getCascadeTransformMatrix(layer)!.m])).toEqual(mainFit);
  expect(sun.getShadowGenerator()).toBe(main);
  // The capture's cascades follow its own camera, far from the scene camera's.
  expect([...own.getCascadeTransformMatrix(0)!.m]).not.toEqual(mainFit[0]);
  // The capture's receivers bind the depth range its borrowed spot map was drawn with.
  expect([spot.getDepthMinZ(capture), spot.getDepthMaxZ(capture)])
    .toEqual([spot.getDepthMinZ(camera), spot.getDepthMaxZ(camera)]);
  view.dispose();
});

it("lets a Full Quality capture whose own sun map does not fit sample the scene view's, without rebuilding materials each frame", async () => {
  const { engine, scene, sun, controller, view, captures, captureCamera } = shadowedHost();
  // Room for the capture's own targets, not for a copy of the sun map (256² × 4 layers × 12 bytes while it builds).
  limitManagedRenderBytes(engine, managedRenderReservations(engine).reservedBytes + 2 * 1024 ** 2);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await untilPublished(scene, view, captures);
  const capture = captureCamera()!;
  expect(sun.getShadowGenerator(capture)).toBeNull();
  expect(controller.viewBoundGenerator(sun, capture)).toBe(controller.generator(sun));
  for (let frame = 0; frame < 3; frame++) view.render();
  const dirty = vi.spyOn(sun, "_markMeshesAsLightDirty");
  for (let frame = 0; frame < 4; frame++) expect(view.render()).toMatchObject({ rendered: true });
  expect(dirty).not.toHaveBeenCalled();
  expect(warn.mock.calls.filter(([message]) => String(message).includes("main camera's map"))).toHaveLength(1);
  view.dispose();
});

it("releases a Full Quality capture's own sun maps and their ledger charge on quality change, removal and scene change", async () => {
  const { engine, scene, sun, view, captures, lens, settings, captureCamera } = shadowedHost();
  const viewShadowBytes = () => managedRenderReservations(engine).categoryBytes.shadow;
  await untilPublished(scene, view, captures);
  let own = sun.getShadowGenerator(captureCamera()!)!;
  expect(own.getShadowMap()).not.toBeNull();
  expect(viewShadowBytes()).toBeGreaterThan(0);
  const released = async () => {
    await captures.whenReleased();
    expect(own.getShadowMap()).toBeNull();
    expect(sun.getShadowGenerator(captureCamera()!)).toBeNull();
    expect(viewShadowBytes()).toBe(0);
  };
  captures.configure("capture", { ...settings, quality: "fast" }, () => lens);
  await released();

  captures.configure("capture", settings, () => lens);
  await untilPublished(scene, view, captures);
  own = sun.getShadowGenerator(captureCamera()!)!;
  captures.removeActor("capture");
  await captures.whenReleased();
  expect(own.getShadowMap()).toBeNull();
  expect(viewShadowBytes()).toBe(0);

  captures.configure("capture", settings, () => lens);
  await untilPublished(scene, view, captures);
  own = sun.getShadowGenerator(captureCamera()!)!;
  view.dispose();
  await view.whenReleased();
  scene.dispose();
  await captures.whenReleased();
  expect(own.getShadowMap()).toBeNull();
  expect(managedRenderReservations(engine)).toMatchObject({ shadowBytes: 0, resourceBytes: 0, pendingBytes: 0 });
});

it("releases a Full Quality view's graph, output and ledger charge on disable, removal and scene close", async () => {
  const { engine, scene, view, captures, root, settings, output } = host("fullQuality");
  const fallback = output.getInternalTexture();
  const renderUntilPublished = () => untilPublished(scene, view, captures);
  const captureCamera = () => scene.cameras.find((entry) => entry.name === "renderTargetCapture:capture");

  await renderUntilPublished();
  let pass = captures.diagnostics()[0]!.waterSceneCopyPass!;
  captures.configure("capture", { ...settings, enabled: false }, () => root);
  // Materials fall back at once, before the native release completes.
  expect(output.getInternalTexture()).toBe(fallback);
  await captures.whenReleased();
  expect(waterSceneCopyForPass(scene, pass)).toBeNull();
  expect(captureCamera()!.outputRenderTarget).toBeNull();
  // What the scene view and the uncaptured fallback hold without the capture.
  const idle = managedRenderReservations(engine).reservedBytes;
  const expectReleased = async (pass: number) => {
    await captures.whenReleased();
    expect(managedRenderReservations(engine).reservedBytes).toBe(idle);
    expect(waterSceneCopyForPass(scene, pass)).toBeNull();
    expect(captureCamera()?.outputRenderTarget ?? null).toBeNull();
  };

  captures.configure("capture", settings, () => root);
  await renderUntilPublished();
  expect(managedRenderReservations(engine).reservedBytes).toBeGreaterThan(idle);
  pass = captures.diagnostics()[0]!.waterSceneCopyPass!;
  captures.configure("capture", { ...settings, enabled: false }, () => root);
  await expectReleased(pass);

  captures.configure("capture", settings, () => root);
  await renderUntilPublished();
  pass = captures.diagnostics()[0]!.waterSceneCopyPass!;
  // Switching to Fast retires the forward view too.
  captures.configure("capture", { ...settings, quality: "fast" }, () => root);
  await captures.whenReleased();
  expect(waterSceneCopyForPass(scene, pass)).toBeNull();
  captures.configure("capture", settings, () => root);
  await renderUntilPublished();
  pass = captures.diagnostics()[0]!.waterSceneCopyPass!;
  captures.removeActor("capture");
  await expectReleased(pass);

  captures.configure("capture", settings, () => root);
  await renderUntilPublished();
  view.dispose();
  await view.whenReleased();
  scene.dispose();
  await captures.whenReleased();
  expect(managedRenderReservations(engine)).toMatchObject({ resourceBytes: 0, pendingBytes: 0 });
});
