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
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RENDER_EFFECTS, normalizeRenderingQuality, normalizeShadowSettings, parseMirrorProperties } from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { createMirrorSurfaceMesh, mirrorDiagnostics, verifyMirrorContentPolls, verifyMirrorFootprintCrops } from "./mirrors";
import { ReflectedContent } from "./reflected-content";
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
import { updateUnlitBinding } from "./unlit-material-blocks";
import { setSceneHonoursUpdateRates } from "./update-rate-gate";

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
  updateUnlitBinding(binding, { color: [1, 0, 0] });
  expect(drawsOver(10)).toBe(1);
  applyOverlayVisualStyle(text, { opacity: 0.5 });
  expect(drawsOver(10)).toBe(1);
  // A Sprite Animation frame resizes the quad in place.
  setSpriteQuadSize(sprite, 0.5, 1, { x: 0.5, y: 0.5 });
  expect(drawsOver(10)).toBe(1);
  atlas.uOffset = 0.25;
  expect(drawsOver(10)).toBe(1);
  // A texture another pass draws into changes without the binding: every render redraws.
  updateUnlitBinding(binding, { texture: new RenderTargetTexture("capture", 4, scene) });
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

/** The Feature Test's Ripple Mirror Material (`mirrorRippleMaterial` in the editor's rendering starter): two drifting noises × 0.012. */
function rippleMaterialDocument(offsetScale = 0.012) {
  const doc = createDefaultMaterialDocument("ripple");
  doc.shadingModel = "unlit";
  doc.nodes.push(
    { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
    { id: "time", type: "input.time", position: { x: 0, y: 0 }, properties: {} },
    { id: "split", type: "vector.split", position: { x: 0, y: 0 }, properties: {} },
    { id: "u", type: "math.multiply", position: { x: 0, y: 0 }, properties: { "default:b": [6] } },
    { id: "v", type: "math.multiply", position: { x: 0, y: 0 }, properties: { "default:b": [9] } },
    { id: "drift", type: "math.multiply", position: { x: 0, y: 0 }, properties: { "default:b": [0.8] } },
    { id: "coordsA", type: "vector.combine", position: { x: 0, y: 0 }, properties: {} },
    { id: "coordsB", type: "vector.combine", position: { x: 0, y: 0 }, properties: {} },
    { id: "noiseA", type: "noise.perlin", position: { x: 0, y: 0 }, properties: {} },
    { id: "noiseB", type: "noise.perlin", position: { x: 0, y: 0 }, properties: {} },
    { id: "rippleX", type: "math.multiply", position: { x: 0, y: 0 }, properties: { "default:b": [offsetScale] } },
    { id: "rippleY", type: "math.multiply", position: { x: 0, y: 0 }, properties: { "default:b": [offsetScale] } },
    { id: "offset", type: "vector.combine", position: { x: 0, y: 0 }, properties: {} },
    { id: "reflection", type: "input.mirrorReflection", position: { x: 0, y: 0 }, properties: {} },
    { id: "tint", type: "math.multiply", position: { x: 0, y: 0 }, properties: { "default:b": [0.75, 0.9, 1] } },
  );
  const wires: [string, string, string, string][] = [
    ["uv", "uv", "split", "value"], ["split", "x", "u", "a"], ["split", "y", "v", "a"], ["time", "time", "drift", "a"],
    ["u", "out", "coordsA", "x"], ["v", "out", "coordsA", "y"], ["drift", "out", "coordsA", "z"],
    ["v", "out", "coordsB", "x"], ["u", "out", "coordsB", "y"], ["drift", "out", "coordsB", "z"],
    ["coordsA", "xyz", "noiseA", "coordinates"], ["coordsB", "xyz", "noiseB", "coordinates"],
    ["noiseA", "out", "rippleX", "a"], ["noiseB", "out", "rippleY", "a"],
    ["rippleX", "out", "offset", "x"], ["rippleY", "out", "offset", "y"],
    ["offset", "xy", "reflection", "offset"], ["reflection", "color", "tint", "a"], ["tint", "out", "output", "baseColor"],
  ];
  doc.edges = wires.map(([from, fromPin, to, toPin]) => ({
    id: `${from}:${fromPin}:${to}:${toPin}`, sourceNodeId: from, sourcePinId: fromPin, targetNodeId: to, targetPinId: toPin,
  }));
  return doc;
}

it("crops a Mirror whose Offset a graph drives by the bound on that graph, and checks the crop when verifying", async () => {
  const { scene, surface, passes, frame } = settledMirror();
  const side = MeshBuilder.CreateBox("side", { size: 0.4 }, scene);
  side.position.set(3, 1, 1.5);
  const reflected = () => { scene.activeCamera!.position.y += 1e-3; frame(); return passes.at(-1)![0]!.meshes; };
  // A mesh created since the last render is culled by the world matrix it was created with (at the origin) until one.
  frame();
  const use = async (doc: ReturnType<typeof createDefaultMaterialDocument>) => {
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: doc.name });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(await compiled.ready).toEqual([]);
    surface.material = compiled.material;
    return compiled;
  };
  // The ripples reach at most 0.012 × the noise's bound: the side box stays beyond them.
  const ripple = await use(rippleMaterialDocument());
  verifyMirrorFootprintCrops(true);
  try {
    expect(reflected()).toEqual(["box"]);
    expect(mirrorDiagnostics(scene)).toMatchObject({ cropChecks: 1, cropMisses: 0 });
  } finally {
    verifyMirrorFootprintCrops(false);
  }
  // Ripples ten times as strong reach it.
  const strong = await use(rippleMaterialDocument(0.12));
  expect(reflected()).toEqual(expect.arrayContaining(["box", "side"]));
  // An Offset driven through a node without a rule is not bounded: the whole mirrored frustum draws.
  const doc = rippleMaterialDocument();
  doc.nodes.find((node) => node.id === "rippleX")!.type = "math.divide";
  const divided = await use(doc);
  expect(reflected()).toEqual(expect.arrayContaining(["box", "side"]));
  ripple.dispose(); strong.dispose(); divided.dispose();
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

describe("a moved view skips asking what its reflection's pass draws changed", () => {
  afterEach(() => verifyMirrorContentPolls(false));

  it("draws on every render while the view moves without asking, and keeps the image once it stops", () => {
    verifyMirrorContentPolls(true);
    const { scene, camera, drawsOver } = settledMirror();
    const changed = vi.spyOn(ReflectedContent.prototype, "changed");
    for (let i = 0; i < 4; i++) {
      camera.position.x += 0.1;
      expect(drawsOver(1)).toBe(1);
    }
    expect(mirrorDiagnostics(scene)).toMatchObject({ skippedPolls: 4, pollMismatches: 0 });
    // Each moved render asked once, at the draw, and the verifier once more each time it would have asked.
    expect(changed).toHaveBeenCalledTimes(4 * 3);
    expect(drawsOver(10)).toBe(0);
    expect(mirrorDiagnostics(scene)).toMatchObject({ skippedPolls: 4, pollMismatches: 0 });
  });

  it("draws once more when what it reflects changes in the render the view stops", () => {
    verifyMirrorContentPolls(true);
    const { scene, camera, box, drawsOver } = settledMirror();
    camera.position.x += 0.1;
    expect(drawsOver(1)).toBe(1);
    // Asked again now that the view is as drawn: the box it showed is gone.
    box.isVisible = false;
    expect(drawsOver(1)).toBe(1);
    expect(drawsOver(10)).toBe(0);
    // A move is seen once the scene's render has placed it, as for any still view.
    camera.position.x += 0.1;
    expect(drawsOver(1)).toBe(1);
    box.position.x += 0.1;
    expect(drawsOver(10)).toBe(0);
    box.isVisible = true;
    expect(drawsOver(10)).toBe(1);
    box.position.x += 0.1;
    expect(drawsOver(10)).toBe(1);
    expect(mirrorDiagnostics(scene)!.pollMismatches).toBe(0);
  });

  it("draws a reflection the budget left out when what it reflects changed while the view moved and came back", () => {
    verifyMirrorContentPolls(true);
    const { scene, camera, frame } = host();
    MeshBuilder.CreateBox("box", { size: 0.5 }, scene).position.set(0, 1, 1.5);
    mirror(scene, "near", new Vector3(0, 1, 3));
    mirror(scene, "middle", new Vector3(-2, 1, 5));
    mirror(scene, "far", new Vector3(2, 1, 8));
    for (let i = 0; i < 4; i++) frame();
    expect(frame()).toEqual([]);
    // Moving, the two nearest draw on every render; the far one keeps the image it drew from here, unasked.
    camera.position.x += 0.1;
    expect(frame()).toEqual(["mirror:near", "mirror:middle"]);
    scene.fogMode = Scene.FOGMODE_EXP;
    camera.position.x += 0.1;
    expect(frame()).toEqual(["mirror:near", "mirror:middle"]);
    // Back where the far one was drawn: its view is as drawn, but the fog changed since, so it is due after the others.
    camera.position.x -= 0.2;
    expect(frame()).toEqual(["mirror:near", "mirror:middle"]);
    expect(frame()).toEqual(["mirror:far"]);
    expect(frame()).toEqual([]);
    expect(mirrorDiagnostics(scene)!.pollMismatches).toBe(0);
  });

  it("still asks for a reflection whose last draw was empty, which any view keeps", () => {
    verifyMirrorContentPolls(true);
    const { scene, camera, mover, frame } = reflectedPair("movingActors");
    mover.setEnabled(false);
    expect(frame()).toEqual(["mirror:mirror"]);
    camera.position.x = 0.4;
    expect(frame()).toEqual([]);
    mover.setEnabled(true);
    camera.position.x = 0.2;
    expect(frame()).toEqual(["mirror:mirror"]);
    expect(mirrorDiagnostics(scene)).toMatchObject({ skippedPolls: 0, pollMismatches: 0 });
  });

  it("counts a render whose decision an ask on every render would have made otherwise", () => {
    verifyMirrorContentPolls(true);
    const { scene, camera, drawsOver } = settledMirror();
    camera.position.x += 0.1;
    drawsOver(1);
    // The verifier's own record (the second one asked) reports a change the surface's record does not see.
    const seen: ReflectedContent[] = [];
    const changed = ReflectedContent.prototype.changed;
    vi.spyOn(ReflectedContent.prototype, "changed").mockImplementation(function (this: ReflectedContent, ...args) {
      if (!seen.includes(this)) seen.push(this);
      const result = changed.apply(this, args);
      return seen.indexOf(this) === 1 ? true : result;
    });
    expect(drawsOver(1)).toBe(0);
    expect(mirrorDiagnostics(scene)!.pollMismatches).toBe(1);
  });
});

describe("Update Rate", () => {
  /** A box in front of the surfaces, which are `rate` Mirrors (2 × 2, facing the view) at the given places. */
  function ratedHost(rate: string, places: Record<string, Vector3>, play = true) {
    const view = host();
    if (play) setSceneHonoursUpdateRates(view.scene);
    MeshBuilder.CreateBox("box", { size: 0.5 }, view.scene).position.set(0, 1, 1.5);
    const surfaces = Object.fromEntries(Object.entries(places).map(([name, at]) => {
      const mesh = createMirrorSurfaceMesh(view.scene, name, parseMirrorProperties({ width: 2, height: 2, updateRate: rate }));
      mesh.position.copyFrom(at);
      return [name, mesh];
    }));
    /** Renders with the view moving: each must draw, so only the rate (and the budget) holds a surface back. */
    const moving = () => {
      view.camera.position.x += 0.05;
      return view.frame();
    };
    return { ...view, surfaces, moving };
  }

  /** Settles the owner's first eight renders with a still view: its next render is the 9th. */
  function settle(frame: () => string[]) {
    for (let i = 0; i < 7; i++) frame();
    expect(frame()).toEqual([]);
  }

  it.each([
    ["every2ndFrame", [false, true, false, true, false, true, false, true]],
    ["every4thFrame", [false, false, false, true, false, false, false, true]],
  ])("draws a Mirror at %s only on its rate's renders in Play, and culls, asks and draws nothing on the others", (rate, due) => {
    const { scene, frame, moving } = ratedHost(rate, { mirror: new Vector3(0, 1, 3) });
    settle(frame);
    const before = mirrorDiagnostics(scene)!;
    for (const drawn of due) {
      const culls = walks.count;
      const asks = vi.spyOn(ReflectedContent.prototype, "changed");
      expect(moving()).toEqual(drawn ? ["mirror:mirror"] : []);
      // A skipped render does not cull the pass's list or ask what it draws; a drawn one culls once (the draw reuses it).
      expect(walks.count - culls).toBe(drawn ? 1 : 0);
      expect(asks.mock.calls.length > 0).toBe(drawn);
      asks.mockRestore();
    }
    const draws = due.filter(Boolean).length;
    expect(mirrorDiagnostics(scene)).toMatchObject({
      draws: before.draws + draws, rateSkips: before.rateSkips + due.length - draws,
      // Only the drawn renders were moved views asked about; none kept a current image.
      skippedPolls: before.skippedPolls + draws, reuses: before.reuses,
    });
  });

  it("draws every Mirror on every render in the editor viewport, whatever its rate", () => {
    const { scene, frame, moving } = ratedHost("every4thFrame", { mirror: new Vector3(0, 1, 3) }, false);
    settle(frame);
    for (let i = 0; i < 6; i++) expect(moving()).toEqual(["mirror:mirror"]);
    expect(mirrorDiagnostics(scene)!.rateSkips).toBe(0);
  });

  it("staggers Mirrors on the same rate so they take turns instead of drawing on the same render", () => {
    const { frame, moving } = ratedHost("every2ndFrame", { left: new Vector3(-1.5, 1, 3), right: new Vector3(1.5, 1, 3) });
    settle(frame);
    // The first registered takes the even renders, the second the odd ones.
    for (let i = 0; i < 3; i++) {
      expect(moving()).toEqual(["mirror:right"]);
      expect(moving()).toEqual(["mirror:left"]);
    }
  });

  it("draws at once off its rate's renders when it first draws, comes into view, needs another target or reflects otherwise", () => {
    const { scene, camera, surfaces, frame, moving } = ratedHost("every4thFrame", { mirror: new Vector3(0, 1, 3) });
    settle(frame);
    // Renders 9 to 11 are off the first surface's phase.
    const late = createMirrorSurfaceMesh(scene, "late", parseMirrorProperties({ width: 2, height: 2, updateRate: "every4thFrame" }));
    late.position.set(-2.5, 1, 5);
    expect(frame()).toEqual(["mirror:late"]);
    // Out of view the surface asks nothing; the render it is back in view draws it from where the view moved meanwhile.
    surfaces.mirror!.isVisible = false;
    late.isVisible = false;
    expect(frame()).toEqual([]);
    camera.position.x += 0.2;
    surfaces.mirror!.isVisible = true;
    expect(frame()).toEqual(["mirror:mirror"]);
    expect(moving()).toEqual(["mirror:mirror"]); // Render 12, on its phase.
    expect(moving()).toEqual([]);
    // A still view off its phase: a smaller view resizes its target, and a quality level that caps what it reflects.
    updateSceneRenderingSettings(scene, { effects: { ...DEFAULT_RENDER_EFFECTS, upscaling: { enabled: true, renderScale: 0.5, sharpness: 0.2 } } });
    expect(frame()).toEqual(["mirror:mirror"]);
    expect(frame()).toEqual([]);
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ geometry: { mirrorReflections: "movingActors" } }) });
    expect(frame()).toEqual(["mirror:mirror"]);
  });

  it("leaves the budget to choose among due Mirrors, and keeps one it passed over due on the renders after", () => {
    const { scene, frame, moving } = ratedHost("every2ndFrame", {
      // Phases by registration: a, c and e on the even renders, b and d on the odd ones.
      a: new Vector3(0, 1, 3), b: new Vector3(-3, 1, 9), c: new Vector3(-2, 1, 4), d: new Vector3(3, 1, 10), e: new Vector3(2, 1, 6),
    });
    for (let i = 0; i < 9; i++) frame();
    expect(frame()).toEqual([]);
    expect(moving()).toEqual(["mirror:b", "mirror:d"]);
    // Three are due and two may draw: the nearest two do, the third keeps its image and stays due.
    expect(moving()).toEqual(["mirror:a", "mirror:c"]);
    // Off its phase, the one passed over is a candidate beside the two now due, and is nearer than both.
    expect(moving()).toEqual(["mirror:e", "mirror:b"]);
    expect(mirrorDiagnostics(scene)!.lastRenderDraws).toBe(2);
  });
});
