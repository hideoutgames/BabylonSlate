import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Constants } from "@babylonjs/core/Engines/constants";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_RENDER_EFFECTS, normalizeRenderingQuality, normalizeShadowSettings, parseMirrorProperties } from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { createMirrorSurfaceMesh, mirrorDiagnostics } from "./mirrors";
import { setPlanarFootprintCulling } from "./planar-mirror";
import { isReflectionCamera } from "./reflection-camera";
import { updateSceneRenderingSettings } from "./render-settings";
import { sceneShadowController } from "./shadow-controller";
import { mirrorReflectionBinding } from "./mirror-surface-state";
import { setSceneStaticMeshes } from "./scene-static-meshes";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import { createSpriteQuad, setSpriteQuadSize } from "./sprite-quad";
import { createText3DMesh } from "./text3d-mesh";
import { setUnlitMaterial, type UnlitBinding } from "./unlit-material";

/** Scene walks for mirror passes, counted through the real culling. */
const walks = vi.hoisted(() => ({ count: 0 }));
vi.mock("./planar-mirror", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./planar-mirror")>();
  return {
    ...actual,
    collectPlanarMirrorMeshes: (...args: Parameters<typeof actual.collectPlanarMirrorMeshes>) => {
      walks.count++;
      actual.collectPlanarMirrorMeshes(...args);
    },
  };
});

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });

/**
 * NullEngine has no GPU: keep the real owner, leases, cameras and targets; record each mirror pass instead of drawing
 * (and whether its camera was the scene's active camera), and draw no shadow map.
 */
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  // NullEngine does not record the allocator's format metadata the ledger reconciles.
  const allocate = engine.createRenderTargetTexture.bind(engine);
  vi.spyOn(engine, "createRenderTargetTexture").mockImplementation((size, options) => {
    const target = allocate(size, options);
    target.texture!.format = Constants.TEXTUREFORMAT_RGBA;
    return target;
  });
  const passes: { target: string; meshes: string[]; eye: Vector3; active: boolean; size: [number, number]; clear: number[]; blend: number[] | null }[][] = [];
  vi.spyOn(RenderTargetTexture.prototype, "isReadyForRendering").mockReturnValue(true);
  vi.spyOn(RenderTargetTexture.prototype, "render").mockImplementation(function (this: RenderTargetTexture) {
    const camera = this.activeCamera;
    if (!camera) return;
    const { width, height } = this.getSize();
    passes.at(-1)!.push({
      target: this.name, meshes: (this.renderList ?? []).map((mesh) => mesh.name), eye: camera.globalPosition.clone(),
      active: this.getScene()!.activeCamera === camera, size: [width, height], clear: this.clearColor.asArray(),
      // The blend factors in force while the pass draws, when it blends at all.
      blend: engine._alphaState.alphaBlend ? Array.from((engine._alphaState as unknown as { _blendFunctionParameters: number[] })._blendFunctionParameters.slice(0, 4)) : null,
    });
  });
  const scene = new Scene(engine);
  const camera = new FreeCamera("View", new Vector3(0, 1, 0), scene);
  camera.setTarget(new Vector3(0, 1, 10));
  const frame = () => {
    passes.push([]);
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    return passes.at(-1)!.map((pass) => pass.target);
  };
  return { engine, scene, camera, passes, frame };
}

function mirror(scene: Scene, name: string, at: Vector3, yaw = 0) {
  const mesh = createMirrorSurfaceMesh(scene, name, parseMirrorProperties({ width: 2, height: 2 }));
  mesh.position.copyFrom(at);
  mesh.rotation.y = yaw;
  return mesh;
}

it("draws at most two visible, facing mirrors per render, an imageless one first, and the rest keep their image", () => {
  const { scene, passes, frame } = host();
  const box = MeshBuilder.CreateBox("box", { size: 0.5 }, scene);
  box.position.set(0, 1, 1.5);
  mirror(scene, "near", new Vector3(0, 1, 3));
  mirror(scene, "middle", new Vector3(-2, 1, 5));
  const far = mirror(scene, "far", new Vector3(2, 1, 8));
  // Its reflective side faces away from the eye, and the last one is behind the view.
  mirror(scene, "turned away", new Vector3(0, 1, 4.5), Math.PI);
  mirror(scene, "behind the view", new Vector3(0, 1, -4), Math.PI);

  expect(frame()).toEqual(["mirror:near", "mirror:middle"]);
  expect(frame()).toEqual(["mirror:far", "mirror:near"]);
  // A draw made before the scene's first render placed its meshes is drawn once more (the near mirror's, the only one
  // whose footprint shows the box); then the static view draws nothing, and every mirror keeps its image.
  expect(frame()).toEqual([]);
  expect(frame()).toEqual([]);
  // Skipped this render, the far mirror still shows its first reflection.
  expect(mirrorReflectionBinding(far)?.texture).not.toBeNull();
  expect(mirrorDiagnostics(scene)).toMatchObject({ surfaces: 5, targets: 3, draws: 4 });

  // Each pass sees the scene from the eye reflected through its mirror and never draws a mirror surface.
  const near = passes[0]![0]!;
  expect(near.eye.subtract(new Vector3(0, 1, 6)).length()).toBeLessThan(1e-6);
  expect(near.meshes).toContain("box");
  for (const pass of passes.flat()) expect(pass.meshes.filter((name) => name !== "box")).toEqual([]);
});

it("sizes each reflection by Resolution Scale of the size the view draws at, which FSR Upscaling lowers", () => {
  const { scene, passes, frame } = host();
  mirror(scene, "full", new Vector3(0, 1, 3));
  const half = createMirrorSurfaceMesh(scene, "half", parseMirrorProperties({ width: 2, height: 2, resolutionScale: 0.5 }));
  half.position.set(-2, 1, 5);
  const sizes = () => Object.fromEntries(passes.at(-1)!.map((pass) => [pass.target, pass.size]));
  // The NullEngine view draws at its 512 × 256 output.
  frame();
  expect(sizes()).toEqual({ "mirror:full": [512, 256], "mirror:half": [256, 128] });
  updateSceneRenderingSettings(scene, { effects: { ...DEFAULT_RENDER_EFFECTS, upscaling: { enabled: true, renderScale: 0.5, sharpness: 0.2 } } });
  // The view's scene now draws at 256 × 128 and upscales: each reflection resizes and draws again.
  frame();
  expect(sizes()).toEqual({ "mirror:full": [256, 128], "mirror:half": [128, 64] });
  expect(frame()).toEqual([]);
});

/** A static view of one mirror reflecting a box, its first draw settled. */
function settledMirror() {
  const view = host();
  const box = MeshBuilder.CreateBox("box", { size: 0.5 }, view.scene);
  box.position.set(0, 1, 1.5);
  const surface = mirror(view.scene, "mirror", new Vector3(0, 1, 3));
  /** Mirror draws over `renders` more renders. */
  const drawsOver = (renders: number) => {
    let draws = 0;
    for (let i = 0; i < renders; i++) draws += view.frame().length;
    return draws;
  };
  expect(drawsOver(4)).toBe(2);
  return { ...view, box, surface, drawsOver };
}

it("keeps a static view's reflection instead of drawing it again, and redraws it on every render while the view moves", () => {
  const { scene, camera, surface, passes, drawsOver } = settledMirror();
  const image = mirrorReflectionBinding(surface)!.texture;
  expect(drawsOver(20)).toBe(0);
  expect(mirrorReflectionBinding(surface)!.texture).toBe(image);
  expect(mirrorDiagnostics(scene)).toMatchObject({ draws: 2, reuses: 22 });
  for (let i = 0; i < 4; i++) {
    camera.position.x += 0.1;
    expect(drawsOver(1)).toBe(1);
    // Each draw sees the scene from the moved eye reflected through the mirror.
    expect(passes.at(-1)![0]!.eye.x).toBeCloseTo(camera.position.x, 6);
  }
  expect(drawsOver(10)).toBe(0);
});

it("redraws a static view's reflection once when what it reflects changes, then keeps it again", () => {
  const { scene, box, drawsOver } = settledMirror();
  box.position.x += 0.1;
  expect(drawsOver(10)).toBe(1);
  box.isVisible = false;
  expect(drawsOver(10)).toBe(1);
  box.isVisible = true;
  expect(drawsOver(10)).toBe(1);
  const paint = new StandardMaterial("paint", scene);
  box.material = paint;
  expect(drawsOver(10)).toBe(1);
  paint.diffuseColor = new Color3(1, 0, 0);
  expect(drawsOver(10)).toBe(1);
  const sun = new DirectionalLight("sun", new Vector3(0, -1, 0.5), scene);
  expect(drawsOver(10)).toBe(1);
  sun.intensity = 2;
  expect(drawsOver(10)).toBe(1);
  scene.fogMode = Scene.FOGMODE_EXP;
  expect(drawsOver(10)).toBe(1);
  // Something the pass does not draw changes nothing: a mesh behind the mirror, past its plane, once its first render
  // has settled where it is.
  const behind = MeshBuilder.CreateBox("behind", { size: 0.5 }, scene);
  behind.position.set(0, 1, 20);
  drawsOver(10);
  behind.position.y += 1;
  behind.material = paint;
  expect(drawsOver(10)).toBe(0);
});

it("walks the scene once for a due reflection, and again for a second one drawn after another pass in the same render", () => {
  const { scene, camera, box, passes, drawsOver } = settledMirror();
  // Moving the view makes the reflection due: the list it was found due with is the one it draws.
  camera.position.x += 0.1;
  walks.count = 0;
  expect(drawsOver(1)).toBe(1);
  expect(walks.count).toBe(1);
  // A second due mirror draws after the first one's pass, which may change what the scene holds (here it hides the
  // box), so it lists again and draws what is there now.
  mirror(scene, "far", new Vector3(0, 1, 5));
  drawsOver(4);
  const listed = () => passes.at(-1)!.map((pass) => [pass.target, pass.meshes]);
  camera.position.x += 0.1;
  expect(drawsOver(1)).toBe(2);
  expect(listed()).toEqual([["mirror:mirror", ["box"]], ["mirror:far", ["box"]]]);
  const render = vi.spyOn(RenderTargetTexture.prototype, "render");
  const record = render.getMockImplementation()!;
  render.mockImplementation(function (this: RenderTargetTexture, ...args) {
    record.apply(this, args);
    if (this.name === "mirror:mirror") box.isVisible = false;
  });
  camera.position.x += 0.1;
  expect(drawsOver(1)).toBe(2);
  expect(listed()).toEqual([["mirror:mirror", ["box"]], ["mirror:far", []]]);
});

it("keeps the reflection of unlit Text 3D and sprites, and redraws it once when what an unlit mesh binds changes", () => {
  const { scene, box, drawsOver } = settledMirror();
  box.dispose();
  const text = createText3DMesh(scene, "text", { text: "Hi", size: 0.5 });
  text.position.set(-0.5, 1, 1.5);
  const sprite = createSpriteQuad(scene, "sprite", { pivot: { x: 0.5, y: 0.5 } });
  sprite.position.set(0.5, 1, 1.5);
  const atlas = new Texture(null, scene);
  const binding: UnlitBinding = { texture: atlas, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: false, textureAlpha: true, twoSided: false };
  setUnlitMaterial(sprite, { textured: true, backFaceCulling: false, fog: false, role: "world" }, binding);
  // The unlit Materials finish building over the first renders; then the reflection is reused.
  drawsOver(10);
  expect(drawsOver(20)).toBe(0);
  // Owners edit a binding in place.
  binding.color = [1, 0, 0];
  expect(drawsOver(10)).toBe(1);
  applyOverlayVisualStyle(text, { opacity: 0.5 });
  expect(drawsOver(10)).toBe(1);
  // A Sprite Animation frame resizes the quad in place.
  setSpriteQuadSize(sprite, 0.5, 1, { x: 0.5, y: 0.5 });
  expect(drawsOver(10)).toBe(1);
  atlas.uOffset = 0.25;
  expect(drawsOver(10)).toBe(1);
  // A texture another pass draws into changes without the binding: every render redraws.
  binding.texture = new RenderTargetTexture("capture", 4, scene);
  expect(drawsOver(10)).toBe(10);
});

it("draws and follows only what the surface's footprint can show, widened by a Mirror Reflection node's Offset", async () => {
  const { scene, surface, passes, frame, drawsOver } = settledMirror();
  // Inside the mirrored view, but beside what the 2 × 2 mirror reflects (about ±1.5 across at this depth).
  const side = MeshBuilder.CreateBox("side", { size: 0.4 }, scene);
  side.position.set(2.2, 1, 1.5);
  drawsOver(10);
  const reflected = () => { scene.activeCamera!.position.y += 1e-3; frame(); return passes.at(-1)![0]!.meshes; };
  expect(reflected()).toEqual(["box"]);
  // Moving it, while it stays beside the footprint, keeps the reflection.
  drawsOver(10);
  side.position.y += 0.2;
  expect(drawsOver(10)).toBe(0);
  // The whole mirrored frustum would draw it.
  setPlanarFootprintCulling(scene, false);
  expect(reflected()).toEqual(expect.arrayContaining(["box", "side"]));
  setPlanarFootprintCulling(scene, true);
  expect(reflected()).toEqual(["box"]);
  // An Offset of 0.15 texture units samples 0.3 of the view's half-width further out: the side box can show.
  const doc = createDefaultMaterialDocument("offset");
  doc.shadingModel = "unlit";
  doc.nodes.push({ id: "reflection", type: "input.mirrorReflection", position: { x: 0, y: 0 }, properties: { "default:offset": [0.15, 0] } });
  doc.edges = [{ id: "reflection-output", sourceNodeId: "reflection", sourcePinId: "color", targetNodeId: "output", targetPinId: "baseColor" }];
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "offset" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  surface.material = compiled.material;
  expect(reflected()).toEqual(expect.arrayContaining(["box", "side"]));
  compiled.dispose();
});

it("redraws a reflection on every render while a time-driven Material it reflects animates", async () => {
  const { scene, box, drawsOver } = settledMirror();
  const doc = createDefaultMaterialDocument("pulse");
  doc.nodes.push(
    { id: "time", type: "input.time", position: { x: 0, y: 0 }, properties: {} },
    { id: "sin", type: "math.sin", position: { x: 0, y: 0 }, properties: {} },
    { id: "combine", type: "vector.combine", position: { x: 0, y: 0 }, properties: {} },
  );
  doc.edges.push(
    { id: "time-sin", sourceNodeId: "time", sourcePinId: "time", targetNodeId: "sin", targetPinId: "value" },
    { id: "sin-combine", sourceNodeId: "sin", sourcePinId: "out", targetNodeId: "combine", targetPinId: "y" },
    { id: "combine-emissive", sourceNodeId: "combine", sourcePinId: "xyz", targetNodeId: "output", targetPinId: "emissive" },
  );
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "pulse" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  box.material = compiled.material;
  await compiled.material.forceCompilationAsync(box);
  expect(drawsOver(10)).toBe(10);
  // Back on a still graph Material, it draws the change once and keeps its image.
  const stillPlan = lowerMaterialDocument(createDefaultMaterialDocument("still"));
  if (!stillPlan.ok) throw new Error(JSON.stringify(stillPlan.diagnostics));
  const still = compileMaterialPlan(stillPlan.plan, { scene, name: "still" });
  if (!still.ok) throw new Error(JSON.stringify(still.diagnostics));
  expect(await still.ready).toEqual([]);
  box.material = still.material;
  await still.material.forceCompilationAsync(box);
  expect(drawsOver(10)).toBe(1);
  expect(drawsOver(10)).toBe(0);
  compiled.dispose();
  still.dispose();
});

it("gives each drawing mirror the sun's cascades of its own under Reflection Shadows, and gives them back when off or removed", () => {
  const { scene, passes, frame } = host();
  const engine = scene.getEngine();
  Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16, maxTextureSize: 4096, maxCubemapTextureSize: 4096 });
  engine._features.supportCSM = true;
  engine._features.supportShadowSamplers = true;
  const reflectionShadows = (on: boolean) => {
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ profile: "high", cascades: 2, mapSize: 512, localMapSize: 256, maxLocalLights: 1, reflections: on }),
    });
    controller.sync();
  };
  const controller = sceneShadowController(scene);
  reflectionShadows(false);
  const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.2), scene);
  controller.register(sun, true);
  controller.sync();
  mirror(scene, "near", new Vector3(0, 1, 3));
  mirror(scene, "middle", new Vector3(-2, 1, 5));
  mirror(scene, "far", new Vector3(2, 1, 8));
  /** The cameras the sun holds maps for: null for the scene view's. */
  const sunViews = () => [...sun.getShadowGenerators()!.keys()].map((camera) => camera && [camera.getClassName(), isReflectionCamera(camera)]);
  // Off: no mirror holds a map of its own. Each pass draws with its mirror camera active, so the light block writes
  // the sun's shadow for it (none).
  expect(frame()).toEqual(["mirror:near", "mirror:middle"]);
  expect(passes.at(-1)!.map((pass) => pass.active)).toEqual([true, true]);
  expect(mirrorDiagnostics(scene)!.sunShadowViews).toBe(0);
  expect(sunViews()).toEqual([null]);
  // On: the mirrors that draw this render claim their own, keyed to their mirror cameras; the third waits its turn.
  reflectionShadows(true);
  expect(frame()).toEqual(["mirror:far", "mirror:near"]);
  expect(mirrorDiagnostics(scene)!.sunShadowViews).toBe(2);
  expect(sunViews()).toEqual([null, ["PlanarMirrorCamera", true], ["PlanarMirrorCamera", true]]);
  // Off again: every mirror gives its maps back at once.
  reflectionShadows(false);
  frame();
  expect(mirrorDiagnostics(scene)!.sunShadowViews).toBe(0);
  expect(sunViews()).toEqual([null]);
  // A removed mirror's go with it.
  reflectionShadows(true);
  frame();
  expect(mirrorDiagnostics(scene)!.sunShadowViews).toBe(2);
  scene.getMeshByName(passes.at(-1)![0]!.target.slice("mirror:".length))!.dispose();
  expect(mirrorDiagnostics(scene)!.sunShadowViews).toBe(1);
  expect(sunViews()).toEqual([null, ["PlanarMirrorCamera", true]]);
});

it("hides a disabled mirror and frees a removed mirror's reflection", () => {
  const { scene, frame } = host();
  const disabled = createMirrorSurfaceMesh(scene, "disabled", parseMirrorProperties({ enabled: false }));
  disabled.position.set(0, 1, 3);
  const removed = mirror(scene, "removed", new Vector3(0, 1, 4));
  expect(disabled.isEnabled()).toBe(false);
  expect(frame()).toEqual(["mirror:removed"]);
  expect(mirrorDiagnostics(scene)).toMatchObject({ surfaces: 2, targets: 1 });
  removed.dispose();
  expect(frame()).toEqual([]);
  expect(mirrorDiagnostics(scene)).toMatchObject({ surfaces: 1, targets: 0 });
});

it("restores the built-in surface when a Material override is cleared", () => {
  const { scene } = host();
  const mesh = mirror(scene, "mirror", new Vector3(0, 1, 3));
  const builtIn = mesh.material;
  mesh.material = null;
  expect(mesh.material).toBe(builtIn);
});

it("compiles a Mirror Reflection Material that reads the reflection on a Mirror surface and nothing elsewhere", async () => {
  const { scene, frame } = host();
  const doc = createDefaultMaterialDocument();
  doc.shadingModel = "unlit";
  doc.nodes.push({ id: "reflection", type: "input.mirrorReflection", position: { x: 0, y: 0 }, properties: {} });
  doc.edges = [{ id: "reflection-output", sourceNodeId: "reflection", sourcePinId: "color", targetNodeId: "output", targetPinId: "baseColor" }];
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "mirror-override" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  const surface = mirror(scene, "mirror", new Vector3(0, 1, 3));
  const box = MeshBuilder.CreateBox("box", { size: 0.5 }, scene);
  box.position.set(0, 1, 1.5);
  for (const mesh of [surface, box]) {
    mesh.material = compiled.material;
    await compiled.material.forceCompilationAsync(mesh);
  }
  expect(frame()).toEqual(["mirror:mirror"]);
  const reflection = mirrorReflectionBinding(surface)!.texture;
  expect(reflection).not.toBeNull();
  const sampled = (mesh: typeof box) => {
    const subMesh = mesh.subMeshes[0]!;
    const textures = vi.spyOn(subMesh.effect!, "setTexture");
    scene.resetCachedMaterial();
    compiled.material.bindForSubMesh(mesh.computeWorldMatrix(true), mesh, subMesh);
    return { defines: subMesh.materialDefines!.toString(), textures: textures.mock.calls.map(([, texture]) => texture) };
  };
  const onSurface = sampled(surface), elsewhere = sampled(box);
  expect(onSurface.defines).toContain("SLATE_MIRROR_REFLECTION");
  expect(onSurface.textures).toContain(reflection);
  expect(elsewhere.defines).not.toContain("SLATE_MIRROR_REFLECTION");
  expect(elsewhere.textures).not.toContain(reflection);
  compiled.dispose();
});

/** A Mirror at z = 3 facing the view, with a box in front of it that an actor that never moves owns, and one that moves. */
function reflectedPair(reflects: string) {
  const fixture = host();
  const { scene } = fixture;
  const surface = createMirrorSurfaceMesh(scene, "mirror", parseMirrorProperties({ width: 2, height: 2, reflects }));
  surface.position.set(0, 1, 3);
  const wall = MeshBuilder.CreateBox("wall", { size: 0.5 }, scene);
  wall.position.set(0.6, 1, 1.5);
  const mover = MeshBuilder.CreateBox("mover", { size: 0.5 }, scene);
  mover.position.set(-0.6, 1, 1.5);
  // The sky follows the camera, as a skybox does.
  const sky = MeshBuilder.CreateBox("sky", { size: 50 }, scene);
  sky.infiniteDistance = true;
  setSceneStaticMeshes(scene, (mesh) => mesh === wall);
  return { ...fixture, surface, wall, mover, sky };
}

it("draws everything into a Mirror that reflects everything, cleared as the view is and unblended", () => {
  const { scene, passes, frame } = reflectedPair("everything");
  scene.clearColor.set(0.2, 0.3, 0.4, 1);
  expect(frame()).toEqual(["mirror:mirror"]);
  expect(passes.at(-1)![0]).toMatchObject({ meshes: ["wall", "mover", "sky"], clear: [0.2, 0.3, 0.4, 1], blend: null });
});

it("draws only the actors that move into a Moving Actors Mirror, over a clear its alpha marks as open", () => {
  const { engine, scene, surface, passes, frame } = reflectedPair("movingActors");
  scene.clearColor.set(0.2, 0.3, 0.4, 1);
  // Known from the start: a readiness probe before the first render compiles the surface's own variant.
  expect(mirrorReflectionBinding(surface)!.reflects).toBe("movingActors");
  expect(frame()).toEqual(["mirror:mirror"]);
  // Not the wall (its actor never moves) nor the sky: the surface's Material shows the environment there. A drawn
  // fragment keeps its colour (one, zero) and writes alpha 0 (zero, zero) over the cleared 1.
  expect(passes.at(-1)![0]).toMatchObject({ meshes: ["mover"], clear: [0, 0, 0, 1], blend: [1, 0, 0, 0] });
  // The pass leaves no blending behind.
  expect(engine._alphaState.alphaBlend).toBe(false);
  expect(mirrorReflectionBinding(surface)).toMatchObject({ reflects: "movingActors" });
  expect(mirrorReflectionBinding(surface)!.normal.asArray()).toEqual([0, 0, -1]);
  expect(mirrorReflectionBinding(surface)!.texture).not.toBeNull();
});

it("draws every mesh into a Moving Actors Mirror while no host has said which actors never move", () => {
  const { scene, passes, frame } = reflectedPair("movingActors");
  setSceneStaticMeshes(scene, null);
  frame();
  expect(passes.at(-1)![0]!.meshes).toEqual(["wall", "mover"]);
});

it("keeps a Moving Actors image that drew nothing until something that moves comes into it, whatever the view", () => {
  const { scene, camera, mover, frame } = reflectedPair("movingActors");
  mover.setEnabled(false);
  // Drawn once, empty: open everywhere.
  expect(frame()).toEqual(["mirror:mirror"]);
  expect(frame()).toEqual([]);
  // Another view of nothing is the same image.
  camera.position.x = 0.4;
  expect(frame()).toEqual([]);
  expect(mirrorDiagnostics(scene)!.reuses).toBe(2);
  mover.setEnabled(true);
  expect(frame()).toEqual(["mirror:mirror"]);
  // With something in it the view matters again.
  camera.position.x = 0;
  expect(frame()).toEqual(["mirror:mirror"]);
});

it("draws no reflection for an Environment Mirror, and holds no storage for one", () => {
  const { scene, surface, frame } = reflectedPair("environment");
  expect(frame()).toEqual([]);
  expect(frame()).toEqual([]);
  expect(mirrorDiagnostics(scene)).toMatchObject({ surfaces: 1, targets: 0, draws: 0 });
  expect(mirrorReflectionBinding(surface)).toMatchObject({ reflects: "environment", texture: null });
  expect(mirrorReflectionBinding(surface)!.normal.asArray()).toEqual([0, 0, -1]);
  // Its Material looks the environment up across the plane as it stands now.
  surface.rotation.y = Math.PI / 2;
  frame();
  const normal = mirrorReflectionBinding(surface)!.normal;
  expect([normal.x, normal.y, normal.z].map((value) => Math.round(value * 1000) / 1000 + 0)).toEqual([-1, 0, 0]);
});

it("compiles the environment into a surface that does not reflect everything, and binds the cube that lights it", async () => {
  const { scene, surface, frame } = reflectedPair("movingActors");
  const plain = createMirrorSurfaceMesh(scene, "plain", parseMirrorProperties({ width: 2, height: 2 }));
  plain.position.set(1.5, 1, 6);
  const material = surface.material as NodeMaterial;
  expect(plain.material).toBe(material);
  // A Reflection Probe's cube: its box is what the lookup is projected onto.
  const probe = new RenderTargetTexture("probe", 16, scene, { isCube: true });
  probe.boundingBoxSize = new Vector3(4, 3, 4);
  probe.boundingBoxPosition = new Vector3(0, 1.5, 2);
  // NullEngine never draws it, and makes its storage no cube; a cube that cannot be sampled yet is not read.
  vi.spyOn(probe, "isReady").mockReturnValue(true);
  vi.spyOn(probe, "isCube", "get").mockReturnValue(true);
  scene.environmentTexture = probe;
  scene.clearColor.set(0.2, 0.3, 0.4, 1);
  for (const mesh of [surface, plain]) await material.forceCompilationAsync(mesh);
  // A frame draws both surfaces, each with its own variant.
  frame();
  const bound = (mesh: AbstractMesh) => {
    const subMesh = mesh.subMeshes[0]!, effect = subMesh.effect!;
    const floats = [vi.spyOn(effect, "setFloat3"), vi.spyOn(effect, "setFloat4")];
    const textures = vi.spyOn(effect, "setTexture");
    scene.resetCachedMaterial();
    material.bindForSubMesh(mesh.computeWorldMatrix(true), mesh as never, subMesh);
    const values = new Map<string, number[]>();
    // Sums with zero: a difference of equal coordinates may be a negative zero.
    for (const spy of floats) for (const [name, ...value] of spy.mock.calls) values.set(name.replace(/\d+$/, ""), (value as number[]).map((entry) => entry + 0));
    const sampled = new Map(textures.mock.calls.map(([name, texture]) => [name.replace(/\d+$/, ""), texture]));
    for (const spy of [...floats, textures]) spy.mockRestore();
    return { defines: subMesh.materialDefines!.toString(), values, sampled };
  };
  const moving = bound(surface), everything = bound(plain);
  expect(moving.defines).toContain("SLATE_MIRROR_ENVIRONMENT");
  expect(everything.defines).toContain("SLATE_MIRROR_REFLECTION");
  expect(everything.defines).not.toContain("SLATE_MIRROR_ENVIRONMENT");
  // The eye (with a cube to read), the plane's normal, and the probe's box with the cube's sharpest level.
  expect(moving.values.get("slateMirrorEye")).toEqual([0, 1, 0, 1]);
  expect(moving.values.get("slateMirrorNormal")).toEqual([0, 0, -1]);
  expect(moving.values.get("slateMirrorEnvironmentBoxPosition")).toEqual([0, 1.5, 2, 0]);
  expect(moving.values.get("slateMirrorEnvironmentBoxSize")).toEqual([4, 3, 4]);
  expect(moving.values.get("slateMirrorEnvironmentForm")![0]).toBe(1);
  expect(moving.sampled.get("slateMirrorEnvironmentSampler")).toBe(probe);
  // A surface that reflects everything binds none of it.
  expect(everything.values.has("slateMirrorEye")).toBe(false);
  expect(everything.sampled.has("slateMirrorEnvironmentSampler")).toBe(false);
  // The Scene's own environment has no box to project onto.
  probe.boundingBoxSize = undefined as never;
  expect(bound(surface).values.get("slateMirrorEnvironmentForm")![0]).toBe(0);
  // Without any environment the surface shows the Scene's clear colour, and binds a placeholder cube.
  scene.environmentTexture = null;
  const bare = bound(surface);
  expect(bare.values.get("slateMirrorEye")).toEqual([0, 1, 0, 0]);
  expect(bare.values.get("slateMirrorBackdrop")!.map((value) => Math.round(value * 10) / 10)).toEqual([0.2, 0.3, 0.4]);
  expect((bare.sampled.get("slateMirrorEnvironmentSampler") as unknown as { name: string }).name).toBe("haptic:environmentPlaceholder");
});

it("draws no more into a Mirror than the quality level allows, and what the Mirror asks for when that is less", () => {
  const { scene, surface, passes, frame } = reflectedPair("everything");
  const cap = (mirrorReflections: "everything" | "movingActors" | "environment") =>
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ geometry: { mirrorReflections } }) });
  const material = surface.material!;
  // Its defines are prepared again, a frozen Material's too: once per change of what the surface shows.
  const dirtied = vi.spyOn(material, "markDirty");
  expect(frame()).toEqual(["mirror:mirror"]);
  expect(passes.at(-1)![0]!.meshes).toEqual(["wall", "mover", "sky"]);
  expect(dirtied).not.toHaveBeenCalled();
  // The level allows only the actors that move: the surface's Material compiles its other variant, and the image
  // drawn before is not kept.
  cap("movingActors");
  expect(frame()).toEqual(["mirror:mirror"]);
  expect(passes.at(-1)![0]).toMatchObject({ meshes: ["mover"], clear: [0, 0, 0, 1], blend: [1, 0, 0, 0] });
  expect(mirrorReflectionBinding(surface)!.reflects).toBe("movingActors");
  expect(dirtied).toHaveBeenCalledTimes(1);
  expect(frame()).toEqual([]);
  // The level allows no reflection: the surface gives its storage back.
  cap("environment");
  expect(frame()).toEqual([]);
  expect(mirrorDiagnostics(scene)).toMatchObject({ targets: 0 });
  expect(mirrorReflectionBinding(surface)).toMatchObject({ reflects: "environment", texture: null });
  // No cap again: everything, drawn anew.
  cap("everything");
  expect(frame()).toEqual(["mirror:mirror"]);
  expect(passes.at(-1)![0]).toMatchObject({ meshes: ["wall", "mover", "sky"], blend: null });
  expect(dirtied).toHaveBeenCalledTimes(3);
});

it("draws a Mirror again when the quality level changes what its image holds, though it lists the same meshes", () => {
  const { scene, wall, sky, passes, frame } = reflectedPair("everything");
  // Only the box that moves is left: both values list it alone.
  wall.dispose();
  sky.dispose();
  // The first draws settle (a draw follows its list from then on); after them the still view keeps its image.
  frame();
  frame();
  expect(frame()).toEqual([]);
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ geometry: { mirrorReflections: "movingActors" } }) });
  // The image of everything has no alpha that says where nothing drew.
  expect(frame()).toEqual(["mirror:mirror"]);
  expect(passes.at(-1)![0]).toMatchObject({ meshes: ["mover"], clear: [0, 0, 0, 1], blend: [1, 0, 0, 0] });
});

it("keeps a Mirror that asks for less than the quality level allows as it asks", () => {
  const { scene, surface, frame } = reflectedPair("environment");
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ geometry: { mirrorReflections: "movingActors" } }) });
  expect(frame()).toEqual([]);
  expect(mirrorReflectionBinding(surface)!.reflects).toBe("environment");
});
