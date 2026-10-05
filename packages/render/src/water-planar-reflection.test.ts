import {
  Constants, CreateLines, FreeCamera, MaterialPluginBase, Matrix, MeshBuilder, NullEngine, NullEngineOptions, RenderTargetTexture, Scene,
  StandardMaterial, Vector3, type AbstractMesh, type Camera, type Material, type Mesh,
} from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultWaterDefinition, normalizeRenderingQuality, normalizeWaterBody, qualityPresetPatch, type QualityLevel, type WaterDefinition,
} from "@babylonslate/core";
import { managedRenderReservations } from "./managed-render-resources";
import { updateSceneRenderingSettings } from "./render-settings";
import { renderTargetCaptureDrawing } from "./render-target-capture-state";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { createWaterMesh } from "./water-mesh";
import { retainWaterPlanarReflections, waterPlanarReflectionDiagnostics, waterPlanarReflectionForCamera } from "./water-planar-reflection";

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });

type Draw = { meshes: AbstractMesh[]; eye: Vector3; camera: Camera };

/** NullEngine has no GPU: keep the real owner, leases, cameras and targets; replace only shader readiness and the draw. */
function gpuBoundary(engine: NullEngine) {
  // NullEngine does not record the allocator's format metadata the ledger reconciles.
  const allocate = engine.createRenderTargetTexture.bind(engine);
  vi.spyOn(engine, "createRenderTargetTexture").mockImplementation((size, options) => {
    const target = allocate(size, options);
    target.texture!.format = Constants.TEXTUREFORMAT_RGBA;
    return target;
  });
  vi.spyOn(RenderTargetTexture.prototype, "isReadyForRendering").mockReturnValue(true);
  const draws: Draw[] = [];
  vi.spyOn(RenderTargetTexture.prototype, "render").mockImplementation(function (this: RenderTargetTexture) {
    draws.push({ meshes: [...(this.renderList ?? [])], eye: this.activeCamera!.globalPosition.clone(), camera: this.activeCamera! });
  });
  return draws;
}

function quality(scene: Scene, level: QualityLevel) {
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(level)) });
}

function host(options: { floatingOrigin?: boolean; eye?: Vector3; target?: Vector3 } = {}) {
  const engine = new NullEngine();
  engines.push(engine);
  const draws = gpuBoundary(engine);
  const scene = new Scene(engine, { useFloatingOrigin: options.floatingOrigin ?? false });
  quality(scene, "ultra");
  const camera = new FreeCamera("View", options.eye ?? new Vector3(0, 5, -10), scene);
  camera.setTarget(options.target ?? Vector3.Zero());
  const release = retainWaterPlanarReflections(scene);
  /** One engine frame; the water material's lookup happens while the view renders. */
  const frame = (lookup = true) => {
    engine.beginFrame();
    scene.render();
    const reflection = lookup ? waterPlanarReflectionForCamera(scene, camera) : null;
    engine.endFrame();
    return reflection;
  };
  return { engine, scene, camera, release, draws, frame };
}

function lake(scene: Scene, name: string, size: number, at: Vector3, definition: Partial<WaterDefinition> = {}): Mesh {
  const mesh = createWaterMesh(scene, name, normalizeWaterBody({ width: size, length: size, resolution: 8 }),
    { ...createDefaultWaterDefinition(), ...definition });
  mesh.position.copyFrom(at);
  mesh.computeWorldMatrix(true);
  return mesh;
}

/** The parts of WaterMaterialPlugin the planar owner reads. */
class WaterContract extends MaterialPluginBase {
  readonly water = createDefaultWaterDefinition();
  readonly body = normalizeWaterBody({ width: 40, length: 40 });
  constructor(material: Material) {
    super(material, "SlateWater", 180, {}, true, true);
  }
  override getClassName(): string { return "WaterContract"; }
}

const waterBytes = (engine: NullEngine) => managedRenderReservations(engine).categoryBytes.water;

/** Where an eye sees `object` mirrored in the plane y = planeY: the eye-to-reflected-object ray meets the plane. */
function seenAt(eye: Vector3, object: Vector3, planeY: number): Vector3 {
  const reflected = new Vector3(object.x, 2 * planeY - object.y, object.z);
  return Vector3.Lerp(eye, reflected, (eye.y - planeY) / (eye.y - reflected.y));
}

it("reflects the flat Object Reflections body covering most of the view, whatever the scene order", () => {
  const { scene, frame } = host();
  // Ineligible bodies, each covering more of the view than the winner.
  const river = createWaterMesh(scene, "river", normalizeWaterBody({ width: 30 }, "river"));
  const tilted = lake(scene, "tilted", 60, new Vector3(0, -0.5, 0));
  tilted.rotation.x = 0.2;
  lake(scene, "no object reflections", 60, new Vector3(0, -0.2, 0), { objectReflections: false });
  lake(scene, "behind the eye", 6, new Vector3(0, 0, -30));
  const small = lake(scene, "small", 4, new Vector3(6, 0, 4));
  const large = lake(scene, "large", 24, new Vector3(0, 1, 0));
  expect(frame()).toBeNull();
  const reflection = frame();
  expect(reflection?.mesh).toBe(large);
  expect(reflection?.planeY).toBe(1);
  expect([river, tilted]).not.toContain(reflection?.mesh);
  // A visible body above the eye gets no mirror; the remaining eligible one takes over.
  large.position.y = 6;
  expect(frame()?.mesh).toBe(small);
  // Equal coverage and height: the older body, not whichever the scene lists first.
  large.dispose();
  const twin = lake(scene, "twin", 4, new Vector3(6, 0, 4));
  scene.meshes.splice(scene.meshes.indexOf(twin), 1);
  scene.meshes.unshift(twin);
  expect(frame()?.mesh).toBe(small);
  small.dispose();
  expect(frame()?.mesh).toBe(twin);
});

it("mirrors the eye across the rest plane with the water plane as an oblique near plane", () => {
  const { scene, camera, draws, frame } = host();
  lake(scene, "lake", 40, new Vector3(0, 0, 0));
  frame();
  const reflection = frame()!;
  expect(reflection).not.toBeNull();
  // The mirror camera renders from the eye reflected across y = 0.
  expect(draws.at(-1)!.eye.subtract(new Vector3(0, -5, -10)).length()).toBeLessThan(1e-5);
  // An object at Q is seen in the water at P, where the eye-to-reflected-Q ray meets the plane.
  const q = new Vector3(0, 2, 10), p = seenAt(camera.globalPosition, q, 0);
  expect(p.z).toBeCloseTo(-10 + 20 * 5 / 7, 4);
  const object = Vector3.TransformCoordinates(q, reflection.viewProjection);
  const water = Vector3.TransformCoordinates(p, reflection.viewProjection);
  expect(object.x).toBeCloseTo(water.x, 5);
  expect(object.y).toBeCloseTo(water.y, 5);
  expect(Math.abs(object.y)).toBeLessThan(1);
  expect(object.z).toBeGreaterThan(-1);
  expect(object.z).toBeLessThan(1);
  // The near plane is the water: points on it sit at near depth, submerged points are clipped.
  expect(water.z).toBeCloseTo(-1, 4);
  expect(Vector3.TransformCoordinates(new Vector3(0, -0.5, 4), reflection.viewProjection).z).toBeLessThan(-1);
  // The rigid mirror flips the image horizontally: water points land at the view's x mirrored.
  const view = camera.getViewMatrix().multiply(camera.getProjectionMatrix());
  const point = new Vector3(3, 0, 4);
  const seen = Vector3.TransformCoordinates(point, view), mirrored = Vector3.TransformCoordinates(point, reflection.viewProjection);
  expect(mirrored.x).toBeCloseTo(-seen.x, 5);
  expect(mirrored.y).toBeCloseTo(seen.y, 5);
});

it("keeps the projection eye-relative under floating origin far from the world origin", () => {
  const far = new Vector3(100000, 0, -100000);
  const { scene, camera, frame } = host({ floatingOrigin: true, eye: far.add(new Vector3(0, 5, -10)), target: far });
  lake(scene, "lake", 40, far);
  frame();
  const reflection = frame()!;
  expect(scene.floatingOriginMode).toBe(true);
  // The water shader's positions are relative to the view's eye (the floating origin).
  const eye = camera.globalPosition.clone();
  const relative = (point: Vector3) => Vector3.TransformCoordinates(point.subtract(eye), reflection.viewProjection);
  const q = far.add(new Vector3(0, 2, 10));
  const object = relative(q), water = relative(seenAt(eye, q, 0));
  expect(object.x).toBeCloseTo(water.x, 4);
  expect(object.y).toBeCloseTo(water.y, 4);
  expect(water.z).toBeCloseTo(-1, 3);
});

it("draws a pre-culled opaque list: no water, helpers, lines, blended or submerged meshes", () => {
  const { scene, draws, frame } = host();
  const water = lake(scene, "lake", 40, Vector3.Zero());
  const other = lake(scene, "other", 4, new Vector3(8, 0, 8));
  const boat = MeshBuilder.CreateBox("boat", {}, scene);
  boat.position.set(0, 1, 10);
  const wreck = MeshBuilder.CreateBox("wreck", {}, scene);
  wreck.position.set(0, -3, 10);
  const glass = MeshBuilder.CreateBox("glass", {}, scene);
  glass.position.set(2, 1, 10);
  const glassMaterial = new StandardMaterial("glass", scene);
  glassMaterial.alpha = 0.5;
  glass.material = glassMaterial;
  const behind = MeshBuilder.CreateBox("behind the mirror", {}, scene);
  behind.position.set(0, 1, -40);
  const line = CreateLines("line", { points: [new Vector3(0, 1, 5), new Vector3(1, 1, 5)] }, scene);
  frame();
  frame();
  const meshes = draws.at(-1)!.meshes;
  expect(meshes).toContain(boat);
  for (const excluded of [water, other, wreck, glass, behind, line]) expect(meshes).not.toContain(excluded);
  // Raising an object out of the water brings it into the next draw (a static view redraws every other frame).
  wreck.position.y = 2;
  frame();
  frame();
  expect(draws.at(-1)!.meshes).toContain(wreck);
});

it("allocates nothing until a view's water asks for a reflection that can draw", async () => {
  const { engine, scene, camera, frame } = host();
  const observers = scene.onBeforeRenderObservable.observers.length;
  const reflective = lake(scene, "lake", 40, Vector3.Zero(), { objectReflections: false });
  for (let i = 0; i < 3; i++) frame(false);
  // Retained but unused: no observer, view, camera, target or charge.
  expect(scene.onBeforeRenderObservable.observers.length).toBe(observers + 1 /* the water mesh's own update */);
  expect(waterPlanarReflectionDiagnostics(scene)).toEqual({ views: 0, targets: 0, draws: 0, reusedFrames: 0 });
  // Asked for, but no eligible body: a view record only.
  for (let i = 0; i < 3; i++) expect(frame()).toBeNull();
  expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ views: 1, targets: 0, draws: 0 });
  expect(waterBytes(engine)).toBe(0);
  expect(scene.cameras).toEqual([camera]);
  // Sky Only / Screen Space quality: lookups neither record a view nor draw.
  reflective.dispose();
  lake(scene, "lake", 40, Vector3.Zero());
  quality(scene, "high");
  for (let i = 0; i < 3; i++) expect(frame()).toBeNull();
  expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ views: 0, targets: 0, draws: 0 });
  // Babylon defers removing an observer during its own notification by one task.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scene.onBeforeRenderObservable.observers.length).toBe(observers + 1);
  // Scenes nobody retained (previews, thumbnails) never get one, nor do Render Target Captures.
  const preview = new Scene(engine);
  quality(preview, "ultra");
  const previewCamera = new FreeCamera("Preview", new Vector3(0, 5, -10), preview);
  lake(preview, "lake", 40, Vector3.Zero());
  preview.render();
  expect(waterPlanarReflectionForCamera(preview, previewCamera)).toBeNull();
  expect(waterPlanarReflectionDiagnostics(preview)).toBeNull();
  quality(scene, "ultra");
  renderTargetCaptureDrawing.add(scene);
  expect(waterPlanarReflectionForCamera(scene, camera)).toBeNull();
  renderTargetCaptureDrawing.delete(scene);
  expect(waterPlanarReflectionDiagnostics(scene)?.views).toBe(0);
  expect(waterBytes(engine)).toBe(0);
});

it("leases its target under the water category, resizes in place and releases it when unused", () => {
  const { engine, scene, camera, frame, release } = host();
  const water = lake(scene, "lake", 40, Vector3.Zero());
  frame();
  const reflection = frame()!;
  const allocated = waterBytes(engine);
  // Ultra Planar Resolution 0.75 of the 512 × 256 view.
  expect(reflection.texture.getInternalTexture()).toMatchObject({ width: 384, height: 192 });
  expect(allocated).toBeGreaterThanOrEqual(384 * 192 * 4);
  expect(scene.cameras).toHaveLength(2);
  expect(scene.customRenderTargets).toEqual([]);
  // A smaller view resizes the same target and swaps its charge.
  camera.viewport.width = 0.5;
  const resized = frame()!;
  expect(resized.texture).toBe(reflection.texture);
  expect(resized.texture.getInternalTexture()).toMatchObject({ width: 192, height: 192 });
  expect(waterBytes(engine)).toBe(allocated / 2);
  // Leaving Planar releases everything at once.
  quality(scene, "high");
  frame();
  expect(waterBytes(engine)).toBe(0);
  expect(scene.cameras).toEqual([camera]);
  expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ views: 0, targets: 0 });
  // An unused target survives brief gaps, then is released.
  quality(scene, "ultra");
  frame();
  expect(frame()).not.toBeNull();
  water.setEnabled(false);
  for (let i = 0; i < 100; i++) frame();
  expect(waterBytes(engine)).toBeGreaterThan(0);
  for (let i = 0; i < 30; i++) frame();
  expect(waterBytes(engine)).toBe(0);
  expect(scene.cameras).toEqual([camera]);
  // Disposing the view camera or releasing the last holder drops the owner's state.
  water.setEnabled(true);
  frame();
  frame();
  expect(waterBytes(engine)).toBeGreaterThan(0);
  release();
  expect(waterBytes(engine)).toBe(0);
  expect(waterPlanarReflectionForCamera(scene, camera)).toBeNull();
  expect(waterPlanarReflectionDiagnostics(scene)).toBeNull();
});

it("redraws every frame while the view moves and every other frame while it is static", () => {
  const { scene, camera, draws, frame } = host();
  lake(scene, "lake", 40, Vector3.Zero());
  frame();
  for (let i = 0; i < 4; i++) {
    camera.position.x += 0.1;
    expect(frame()).not.toBeNull();
  }
  expect(draws).toHaveLength(4);
  for (let i = 0; i < 6; i++) expect(frame()).not.toBeNull();
  expect(draws).toHaveLength(7);
  expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ draws: 7, reusedFrames: 3 });
  // The camera never sees the mirror pass: the view's active camera and matrices are restored.
  expect(scene.activeCamera).toBe(camera);
  expect(draws.every((draw) => draw.camera !== camera)).toBe(true);
});

it("draws for a coordinated view without new strict readiness probes on steady frames", async () => {
  const options = new NullEngineOptions();
  options.renderWidth = 80;
  options.renderHeight = 64;
  const engine = new NullEngine(options);
  engines.push(engine);
  // NullEngine lacks this MRT driver boundary; keep the real graph, tasks and readiness.
  vi.spyOn(engine, "buildTextureLayout").mockImplementation((enabled, backbuffer) =>
    backbuffer ? [0x0405] : enabled.map((value, index) => value ? 0x8ce0 + index : 0));
  vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(() => {});
  const draws = gpuBoundary(engine);
  const scene = new Scene(engine);
  quality(scene, "ultra");
  const camera = new FreeCamera("View", new Vector3(0, 5, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  // Built-in water's PBR shaders never finish in NullEngine; a plain surface carries the same water contract
  // (the water marker and a "SlateWater" plugin with its asset and body), so the view really renders.
  const surface = MeshBuilder.CreateGround("lake", { width: 40, height: 40 }, scene);
  surface.metadata = { slateWater: true };
  surface.material = new StandardMaterial("lake", scene);
  new WaterContract(surface.material);
  MeshBuilder.CreateBox("boat", {}, scene).position.set(0, 1, 5);
  const renderer = new SceneRenderCoordinator(scene);
  let latest: ReturnType<typeof waterPlanarReflectionForCamera> = null;
  scene.onAfterRenderObservable.add(() => { latest = waterPlanarReflectionForCamera(scene, scene.activeCamera); });
  await renderer.prepare();
  const step = (steady = true) => {
    camera.position.x += 0.05;
    const ready = renderer.isReady(), result = renderer.render();
    if (steady) {
      expect(ready).toBe(true);
      expect(result).toMatchObject({ path: "frameGraph", rendered: true });
    }
    engine.endFrame();
  };
  // The first request allocates the mirror camera and target once (a membership change the view re-probes).
  for (let i = 0; i < 4; i++) step(false);
  expect(latest).not.toBeNull();
  const checks = renderer.strictReadinessChecks, drawn = draws.length;
  for (let i = 0; i < 10; i++) step();
  expect(draws.length).toBe(drawn + 10);
  expect(renderer.strictReadinessChecks).toBe(checks);
  expect(latest!.viewProjection).toBeInstanceOf(Matrix);
  renderer.dispose();
  expect(waterPlanarReflectionDiagnostics(scene)).toBeNull();
  expect(waterBytes(engine)).toBe(0);
});
