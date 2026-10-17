import { Constants, FreeCamera, Mesh, MeshBuilder, NullEngine, NullEngineOptions, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultRenderTargetCaptureProperties, createDefaultWaterDefinition, normalizeWaterBody,
  type RenderTargetCaptureQuality,
} from "@babylonslate/core";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { managedRenderReservations } from "./managed-render-resources";
import { RenderTargetCaptures } from "./render-target-capture";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
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
