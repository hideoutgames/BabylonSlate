import {
  Constants, CreateLines, FreeCamera, MaterialPluginBase, Matrix, MeshBuilder, NullEngine, NullEngineOptions, ObjectRenderer, RenderTargetTexture,
  Scene, StandardMaterial, Vector3, Viewport, type AbstractMesh, type Camera, type Material, type Mesh,
} from "@babylonjs/core";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
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

/**
 * NullEngine has no GPU: keep the real owner, leases, cameras and targets. `mock` also replaces shader readiness
 * and the draw (recording each pass); `real` runs Babylon's own ObjectRenderer pass, which NullEngine can draw for
 * StandardMaterial meshes.
 */
function gpuBoundary(engine: NullEngine, gpu: "mock" | "real" = "mock") {
  // NullEngine does not record the allocator's format metadata the ledger reconciles.
  const allocate = engine.createRenderTargetTexture.bind(engine);
  vi.spyOn(engine, "createRenderTargetTexture").mockImplementation((size, options) => {
    const target = allocate(size, options);
    target.texture!.format = Constants.TEXTUREFORMAT_RGBA;
    return target;
  });
  const draws: Draw[] = [];
  if (gpu === "real") return draws;
  vi.spyOn(RenderTargetTexture.prototype, "isReadyForRendering").mockReturnValue(true);
  vi.spyOn(RenderTargetTexture.prototype, "render").mockImplementation(function (this: RenderTargetTexture) {
    draws.push({ meshes: [...(this.renderList ?? [])], eye: this.activeCamera!.globalPosition.clone(), camera: this.activeCamera! });
  });
  return draws;
}

function quality(scene: Scene, level: QualityLevel) {
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(level)) });
}

function host(options: { floatingOrigin?: boolean; eye?: Vector3; target?: Vector3; gpu?: "mock" | "real" } = {}) {
  const engine = new NullEngine();
  engines.push(engine);
  // Babylon's floating-origin matrix overrides run on the scene uniform buffer.
  if (options.floatingOrigin) vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
  const draws = gpuBoundary(engine, options.gpu);
  const scene = new Scene(engine, { useFloatingOrigin: options.floatingOrigin ?? false });
  quality(scene, "ultra");
  const camera = new FreeCamera("View", options.eye ?? new Vector3(0, 5, -10), scene);
  camera.setTarget(options.target ?? Vector3.Zero());
  const release = retainWaterPlanarReflections(scene);
  /** One scene render in its own engine frame; the water material's lookup happens while the view renders. */
  const frame = (lookup = true) => {
    engine.beginFrame();
    scene.render();
    const reflection = lookup ? waterPlanarReflectionForCamera(scene, camera) : null;
    engine.endFrame();
    return reflection;
  };
  /** Engine frames in which the scene does not render (a frame cap on a fast display, or a paused view). */
  const skip = (frames: number) => {
    for (let i = 0; i < frames; i++) { engine.beginFrame(); engine.endFrame(); }
  };
  return { engine, scene, camera, release, draws, frame, skip };
}

function lake(scene: Scene, name: string, size: number, at: Vector3, definition: Partial<WaterDefinition> = {}, material?: Material): Mesh {
  const mesh = createWaterMesh(scene, name, normalizeWaterBody({ width: size, length: size, resolution: 8 }),
    { ...createDefaultWaterDefinition(), ...definition }, material);
  mesh.position.copyFrom(at);
  mesh.computeWorldMatrix(true);
  return mesh;
}

/** The parts of WaterMaterialPlugin the planar owner reads, on a material NullEngine can draw. */
class WaterContract extends MaterialPluginBase {
  readonly water = createDefaultWaterDefinition();
  readonly body = normalizeWaterBody({ width: 40, length: 40 });
  constructor(material: Material) {
    super(material, "SlateWater", 180, {}, true, true);
  }
  override getClassName(): string { return "WaterContract"; }
}

/** A flat lake whose plain StandardMaterial carries the water contract, so NullEngine really draws the view. */
function drawableLake(scene: Scene, size: number, at: Vector3): Mesh {
  const material = new StandardMaterial("lake", scene);
  new WaterContract(material);
  return lake(scene, "lake", size, at, {}, material);
}

const waterBytes = (engine: NullEngine) => managedRenderReservations(engine).categoryBytes.water;

/** Where an eye sees `object` mirrored in the plane y = planeY: the eye-to-reflected-object ray meets the plane. */
function seenAt(eye: Vector3, object: Vector3, planeY: number): Vector3 {
  const reflected = new Vector3(object.x, 2 * planeY - object.y, object.z);
  return Vector3.Lerp(eye, reflected, (eye.y - planeY) / (eye.y - reflected.y));
}

it("reflects the flat Object Reflections body covering most of the view, whatever the scene order", () => {
  const { scene, frame } = host();
  // Overlapping bodies at different rest heights: blending them would make none flat, so it stays off here.
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch("ultra")), water: { blendDistance: 0 } });
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

it.each([
  { range: "full-range", half: false, reverse: false, near: -1, far: 1 },
  { range: "half-range (WebGPU)", half: true, reverse: false, near: 0, far: 1 },
  { range: "reverse full-range", half: false, reverse: true, near: 1, far: -1 },
  { range: "reverse half-range", half: true, reverse: true, near: 1, far: 0 },
])("mirrors the eye across the rest plane with the water plane as the oblique near plane for $range depth", ({ half, reverse, near, far }) => {
  const { engine, scene, camera, draws, frame } = host();
  Object.assign(engine, { isNDCHalfZRange: half });
  engine.useReverseDepthBuffer = reverse;
  lake(scene, "lake", 40, new Vector3(0, 0, 0));
  frame();
  const reflection = frame()!;
  expect(reflection).not.toBeNull();
  const depth = (point: Vector3) => Vector3.TransformCoordinates(point, reflection.viewProjection).z;
  const inRange = (z: number) => (z - near) * (z - far) <= 1e-9;
  // The mirror camera renders from the eye reflected across y = 0.
  const mirror = draws.at(-1)!.camera;
  expect(draws.at(-1)!.eye.subtract(new Vector3(0, -5, -10)).length()).toBeLessThan(1e-5);
  // An object at Q is seen in the water at P, where the eye-to-reflected-Q ray meets the plane.
  const q = new Vector3(0, 2, 10), p = seenAt(camera.globalPosition, q, 0);
  expect(p.z).toBeCloseTo(-10 + 20 * 5 / 7, 4);
  const object = Vector3.TransformCoordinates(q, reflection.viewProjection);
  const water = Vector3.TransformCoordinates(p, reflection.viewProjection);
  expect(object.x).toBeCloseTo(water.x, 5);
  expect(object.y).toBeCloseTo(water.y, 5);
  expect(Math.abs(object.y)).toBeLessThan(1);
  expect(inRange(object.z)).toBe(true);
  // The near plane is the water: points on it sit at this convention's near depth, submerged points are clipped.
  expect(water.z).toBeCloseTo(near, 4);
  expect(depth(new Vector3(3, 0, 25))).toBeCloseTo(near, 4);
  expect(inRange(depth(new Vector3(0, -0.5, 4)))).toBe(false);
  // The ordinary mirrored frustum's far corners above the water stay inside the oblique depth range, and the one
  // opposite the plane lands on the far plane, so nothing above the water is lost to the oblique far plane.
  const unproject = Matrix.Invert(mirror.getViewMatrix().multiply(camera.getProjectionMatrix()));
  const corners = [[-1, -1], [-1, 1], [1, -1], [1, 1]]
    .map(([x, y]) => Vector3.TransformCoordinates(new Vector3(x, y, far), unproject))
    .filter((corner) => corner.y > 0);
  expect(corners.length).toBeGreaterThan(0);
  for (const corner of corners) expect(inRange(depth(corner))).toBe(true);
  expect(Math.min(...corners.map((corner) => Math.abs(depth(corner) - far)))).toBeLessThan(1e-4);
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
  // Raising an object out of the water brings it into the next draw (a static view redraws every other render).
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

it("leases its target under the water category, resizes in place and frees idle storage without scene membership", () => {
  const { engine, scene, camera, frame, release } = host();
  const water = lake(scene, "lake", 40, Vector3.Zero());
  // The material's field placeholder joins on its first bind, which Babylon
  // 9.29's process-wide shader imports can place before or after this count.
  const sceneTextures = () => scene.textures.filter((texture) => texture.name !== "water-field-placeholder").length;
  const textures = sceneTextures();
  frame();
  const reflection = frame()!;
  const allocated = waterBytes(engine);
  // Ultra Planar Resolution 0.75 of the 512 × 256 view.
  expect(reflection.texture.getInternalTexture()).toMatchObject({ width: 384, height: 192 });
  expect(allocated).toBeGreaterThanOrEqual(384 * 192 * 4);
  expect(scene.customRenderTargets).toEqual([]);
  // The mirror camera and target never join the scene: no readiness-relevant membership change.
  const membership = () => ({ cameras: scene.cameras.length, textures: sceneTextures() });
  expect(membership()).toEqual({ cameras: 1, textures });
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
  expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ views: 0, targets: 0 });
  // An unused target survives brief gaps, then frees its storage; the view keeps its (storage-free) target.
  quality(scene, "ultra");
  frame();
  const texture = frame()!.texture;
  water.setEnabled(false);
  for (let i = 0; i < 100; i++) frame();
  expect(waterBytes(engine)).toBeGreaterThan(0);
  for (let i = 0; i < 30; i++) frame();
  expect(waterBytes(engine)).toBe(0);
  expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ views: 1, targets: 0 });
  // Returning to the water reallocates storage in place: same texture wrapper, still outside the scene.
  water.setEnabled(true);
  frame();
  expect(frame()?.texture).toBe(texture);
  expect(waterBytes(engine)).toBeGreaterThan(0);
  expect(membership()).toEqual({ cameras: 1, textures });
  // Releasing the last holder drops the owner's state.
  release();
  expect(waterBytes(engine)).toBe(0);
  expect(waterPlanarReflectionForCamera(scene, camera)).toBeNull();
  expect(waterPlanarReflectionDiagnostics(scene)).toBeNull();
});

it("redraws on every render while the view moves and every other render while it is static", () => {
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
});

it("counts its windows in the view's own renders, so frame-capped and paused views keep their reflection", () => {
  const { engine, scene, camera, draws, frame, skip } = host();
  lake(scene, "lake", 40, Vector3.Zero());
  frame();
  // A 30 fps cap on a 144 Hz display: about five engine frames per scene render.
  for (let i = 0; i < 6; i++) {
    skip(4);
    camera.position.x += 0.1;
    expect(frame()).not.toBeNull();
  }
  expect(draws).toHaveLength(6);
  const bytes = waterBytes(engine);
  // A paused view keeps its target through hundreds of engine frames and reflects on its next render.
  skip(500);
  camera.position.x += 0.1;
  expect(frame()).not.toBeNull();
  expect(draws).toHaveLength(7);
  expect(waterBytes(engine)).toBe(bytes);
  // A static view under the cap still redraws every other render, not every other engine frame.
  for (let i = 0; i < 4; i++) {
    skip(4);
    expect(frame()).not.toBeNull();
  }
  expect(draws).toHaveLength(9);
});

it.each(["readiness", "draw"] as const)("restores the view's rendering state after a real mirror pass, and after one that throws during %s", async (stage) => {
  const { engine, scene, camera, frame } = host({ floatingOrigin: true, gpu: "real", eye: new Vector3(1000, 5, -10), target: new Vector3(1000, 0, 0) });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  drawableLake(scene, 40, new Vector3(1000, 0, 0));
  const boat = MeshBuilder.CreateBox("boat", {}, scene);
  boat.material = new StandardMaterial("boat", scene);
  boat.position.set(1000, 1, 8);
  // NullEngine compiles effects asynchronously; the mirror pass reuses the view's compiled variants.
  await scene.whenReadyAsync();
  const borrowed = engine.createRenderTargetTexture(8, {});
  const interrupted = engine.createRenderTargetTexture(4, {});
  const viewport = new Viewport(0.2, 0.1, 0.6, 0.7);
  // The view's state as the planar owner finds it in onBeforeRender, and as it must leave it.
  const capture = () => ({
    camera: scene.activeCamera, transform: scene.getTransformMatrix().clone(), ubo: scene.getSceneUniformBuffer(),
    renderPass: engine.currentRenderPassId, viewport: engine.currentViewport, framebuffer: engine._currentRenderTarget,
    floatingOrigin: FloatingOriginCurrentScene.getScene, eyeAtCamera: FloatingOriginCurrentScene.eyeAtCamera,
    depth: engine.getDepthBuffer(), depthWrite: engine.getDepthWrite(), alpha: engine.getAlphaMode(), colorWrite: engine.getColorWrite(),
    exempt: renderTargetCaptureDrawing.has(scene),
  });
  let before: ReturnType<typeof capture> | undefined, after: ReturnType<typeof capture> | undefined;
  let restore = () => {}, pending = false;
  // Before every other onBeforeRender observer: a distinctive view state for the owner to preserve.
  scene.onBeforeRenderObservable.add(() => {
    pending = true;
    const renderPass = engine.currentRenderPassId, eyeAtCamera = FloatingOriginCurrentScene.eyeAtCamera;
    const framebuffer = engine._currentRenderTarget;
    scene.setTransformMatrix(camera.getViewMatrix(), camera.getProjectionMatrix());
    engine.bindFramebuffer(borrowed);
    engine.setViewport(viewport, 8, 8);
    engine.currentRenderPassId = 3;
    engine.setDepthBuffer(false); engine.setDepthWrite(false);
    engine.setAlphaMode(Constants.ALPHA_ADD);
    engine.setColorWrite(false);
    FloatingOriginCurrentScene.eyeAtCamera = false;
    before = capture();
    restore = () => {
      engine.currentRenderPassId = renderPass;
      FloatingOriginCurrentScene.eyeAtCamera = eyeAtCamera;
      engine.setDepthBuffer(true); engine.setDepthWrite(true); engine.setColorWrite(true);
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      if (framebuffer) engine.bindFramebuffer(framebuffer);
      else engine.restoreDefaultFramebuffer();
    };
  }, undefined, true);
  // Babylon notifies this right after every onBeforeRender observer, the planar owner's included (and again
  // later for the camera's own targets).
  scene.onBeforeRenderTargetsRenderObservable.add(() => {
    if (!pending) return;
    pending = false;
    after = capture();
    restore();
  });
  const expectRestored = () => {
    const state = after!, expected = before!;
    expect(state.camera).toBe(camera);
    expect(state.transform.equals(expected.transform)).toBe(true);
    expect(state.ubo).toBe(expected.ubo);
    expect(state.renderPass).toBe(3);
    expect(state.viewport).toBe(viewport);
    expect(state.framebuffer).toBe(borrowed);
    expect(state.floatingOrigin).toBe(expected.floatingOrigin);
    expect(state.eyeAtCamera).toBe(false);
    expect(state).toMatchObject({ depth: false, depthWrite: false, alpha: Constants.ALPHA_ADD, colorWrite: false, exempt: false });
  };
  const succeed = () => {
    const draws = waterPlanarReflectionDiagnostics(scene)!.draws;
    // A real ObjectRenderer pass draws the boat into the mirror target and leaves the view as it found it.
    expect(frame()).not.toBeNull();
    expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ draws: draws + 1, targets: 1 });
    expectRestored();
    // Level of detail follows the view: no mirror camera enters a mesh's per-camera LOD cache.
    const lod = (boat as unknown as { _internalAbstractMeshDataInfo: { _currentLOD: Map<Camera, unknown> } })._internalAbstractMeshDataInfo._currentLOD;
    expect([...lod.keys()]).toEqual([camera]);
  };
  frame();
  if (stage === "draw") {
    succeed();
    // A moving view redraws (a static one may reuse its last draw).
    camera.position.x += 0.1;
  }
  const fail = () => {
    expect(scene.activeCamera).not.toBe(camera);
    expect(FloatingOriginCurrentScene.eyeAtCamera).toBe(true);
    expect(renderTargetCaptureDrawing.has(scene)).toBe(true);
    engine.bindFramebuffer(interrupted);
    engine.setDepthBuffer(false); engine.setDepthWrite(false);
    engine.currentRenderPassId = 47;
    throw new Error("GPU mirror pass failed");
  };
  const cleanup: (() => void)[] = [];
  const initialize = ObjectRenderer.prototype.initRender;
  // The first draw of a target waits for readiness, which initializes the pass; later draws only render.
  const initialization = vi.spyOn(ObjectRenderer.prototype, "initRender").mockImplementation(function (this: ObjectRenderer, width, height) {
    initialize.call(this, width, height);
    if (stage === "readiness") fail();
    else if (!cleanup.length) {
      const observer = this.onBeforeRenderingManagerRenderObservable.add(fail);
      cleanup.push(() => { this.onBeforeRenderingManagerRenderObservable.remove(observer); });
    }
  });
  expect(frame()).toBeNull();
  initialization.mockRestore();
  for (const remove of cleanup) remove();
  expectRestored();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("GPU mirror pass failed"));
  expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ views: 0, targets: 0 });
  expect(waterBytes(engine)).toBe(0);
  // Off until Water quality changes; lookups meanwhile create no view, observer or target.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const observers = scene.onBeforeRenderObservable.observers.length;
  for (let i = 0; i < 3; i++) expect(frame()).toBeNull();
  expect(scene.onBeforeRenderObservable.observers.length).toBe(observers);
  expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ views: 0, targets: 0, draws: stage === "draw" ? 1 : 0 });
  quality(scene, "high");
  quality(scene, "ultra");
  frame();
  succeed();
  borrowed.dispose(); interrupted.dispose();
});

it("draws for a coordinated view without readiness probes or dropped frames as it allocates, idles and returns", async () => {
  const options = new NullEngineOptions();
  options.renderWidth = 80;
  options.renderHeight = 64;
  const engine = new NullEngine(options);
  engines.push(engine);
  // NullEngine lacks this MRT driver boundary; keep the real graph, tasks, readiness and mirror pass.
  vi.spyOn(engine, "buildTextureLayout").mockImplementation((enabled, backbuffer) =>
    backbuffer ? [0x0405] : enabled.map((value, index) => value ? 0x8ce0 + index : 0));
  vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(() => {});
  gpuBoundary(engine, "real");
  const scene = new Scene(engine);
  quality(scene, "ultra");
  const camera = new FreeCamera("View", new Vector3(0, 5, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  drawableLake(scene, 40, Vector3.Zero());
  const boat = MeshBuilder.CreateBox("boat", {}, scene);
  boat.material = new StandardMaterial("boat", scene);
  boat.position.set(0, 1, 5);
  const renderer = new SceneRenderCoordinator(scene);
  let latest: ReturnType<typeof waterPlanarReflectionForCamera> = null;
  // Built-in water looks the reflection up while it draws; this lake's plain material stands in for it.
  let lookups = true;
  scene.onAfterRenderObservable.add(() => { latest = lookups ? waterPlanarReflectionForCamera(scene, scene.activeCamera) : null; });
  await renderer.prepare();
  const step = () => {
    camera.position.x += 0.01;
    expect(renderer.isReady()).toBe(true);
    expect(renderer.render()).toMatchObject({ path: "frameGraph", rendered: true, readyForPresentation: true });
    engine.endFrame();
  };
  step();
  const checks = renderer.strictReadinessChecks;
  // The first request allocates the mirror camera and target outside scene membership: no re-probe, no dropped frame.
  for (let i = 0; i < 10; i++) step();
  expect(latest).not.toBeNull();
  expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ targets: 1, draws: 10 });
  // Water out of sight for longer than the release window frees storage, and returning reallocates it.
  lookups = false;
  for (let i = 0; i < 130; i++) step();
  expect(waterPlanarReflectionDiagnostics(scene)).toMatchObject({ targets: 0 });
  expect(waterBytes(engine)).toBe(0);
  lookups = true;
  for (let i = 0; i < 3; i++) step();
  expect(latest).not.toBeNull();
  expect(waterBytes(engine)).toBeGreaterThan(0);
  expect(renderer.strictReadinessChecks).toBe(checks);
  renderer.dispose();
  expect(waterPlanarReflectionDiagnostics(scene)).toBeNull();
  expect(waterBytes(engine)).toBe(0);
});
