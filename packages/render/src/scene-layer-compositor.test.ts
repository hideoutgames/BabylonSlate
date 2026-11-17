import { Camera } from "@babylonjs/core/Cameras/camera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sceneLayerCanvasToLayer } from "@haptic/core";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { PreparationTimedOut, SceneRenderCoordinator } from "./scene-render-coordinator";
import { SCENE_PREPARATION_CEILING_MS } from "./stall-deadline";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import * as scenePerf from "./scene-perf";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { RenderingManager } from "@babylonjs/core/Rendering/renderingManager";
import { layerDrawableMeshes } from "./layer-drawable-meshes";
import { sceneShadowController } from "./shadow-controller";
import { applyOverlayUnlitMaterial } from "./overlay-texture-quad";

/** A Custom canvas of `width` × `height` layer units centred on the origin, fitted to the screen (`sceneLayerCreate.canvas`). */
function layerCanvas(width: number, height: number) {
  return {
    design: { sizeMode: "custom" as const, customSizePx: { width: width * 100, height: height * 100 }, rootAnchor: "center" as const, scaling: "fitToScreen" as const },
    rect: { width, height, center: [0, 0] as [number, number] },
  };
}


describe("SceneLayerCompositor", () => {
  const engines: NullEngine[] = [];

  afterEach(() => {
    while (engines.length > 0) {
      engines.pop()?.dispose();
    }
    vi.restoreAllMocks();
  });

  function world(): { engine: NullEngine; scene: Scene; compositor: SceneLayerCompositor } {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    scene.skipPointerMovePicking = true;
    scene.autoClear = true;
    const compositor = new SceneLayerCompositor({
      engine,
      postProcessingEnabled: () => true,
    });
    return { engine, scene, compositor };
  }

  it("creates unlit orthographic overlay scenes that do not clear the world color", () => {
    const { scene, compositor } = world();
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 2,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    const layers = compositor.layers();
    expect(layers).toHaveLength(1);
    expect(layers[0]?.zOrder).toBe(2);
    expect(layers[0]?.scene.lightsEnabled).toBe(false);
    expect(layers[0]?.scene.autoClear).toBe(false);
    expect(layers[0]?.scene.autoClearDepthAndStencil).toBe(true);
    expect(layers[0]?.scene.skipPointerMovePicking).toBe(false);
    expect(layers[0]?.camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(scene.skipPointerMovePicking).toBe(true);
    expect(scene.autoClear).toBe(true);
  });

  it("leaves depth and stencil uncleared before a layer drawn over the world only while its clears are switched off", () => {
    const { compositor } = world();
    const layer = compositor.create({
      type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud-asset", zOrder: 0, ownerSceneGuid: null, postProcessStack: [],
    });
    compositor.render();
    expect(layer.scene.autoClearDepthAndStencil).toBe(true);
    compositor.depthClears = false;
    compositor.render();
    // The colour beneath is never cleared; now neither are depth and stencil.
    expect([layer.scene.autoClear, layer.scene.autoClearDepthAndStencil]).toEqual([false, false]);
    compositor.depthClears = true;
    compositor.render();
    expect(layer.scene.autoClearDepthAndStencil).toBe(true);
  });

  it("lists each layer's own renderer work in draw order, with its mesh count", () => {
    const { compositor } = world();
    const create = (layerId: string, zOrder: number) =>
      compositor.create({ type: "sceneLayerCreate", layerId, assetGuid: `${layerId}-asset`, zOrder, ownerSceneGuid: null, postProcessStack: [] });
    const menu = create("menu", 5);
    create("hud", 1);
    MeshBuilder.CreateBox("button", {}, menu.scene);
    MeshBuilder.CreateBox("label", {}, menu.scene);
    const work = compositor.diagnostics();
    expect(work.map((layer) => [layer.layerId, layer.meshes])).toEqual([["hud", 0], ["menu", 2]]);
    // The counters a view's own diagnostics hold for its world, for a layer that has drawn nothing yet.
    expect(work[0]!.work).toMatchObject({ graphBuilds: 0, strictReadinessChecks: 0, failedReadinessProbes: 0, readinessBlockers: [] });
  });

  it.each([false, true])("keeps GPU HUD matrices independent after world rendering (post-process=%s)", (postProcess) => {
    const engine = new NullEngine();
    engines.push(engine);
    // Match the real WebGL2 renderer: floating origin and scene uniform buffers.
    vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
    vi.spyOn(engine, "getCreationOptions").mockReturnValue({ useLargeWorldRendering: true });
    const compositor = new SceneLayerCompositor({ engine });
    const layer = compositor.create({
      type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud", zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: postProcess ? [{ materialGuid: "pass", enabled: true }] : [],
    });
    const checkHudUniforms = () => {
      const uploaded = layer.scene.getSceneUniformBuffer().getData();
      const expected = layer.camera.getProjectionMatrix().asArray();
      // In floating-origin coordinates the fixed HUD camera has identity view.
      for (let i = 0; i < 16; i++) expect(uploaded[i], `viewProjection[${i}]`).toBeCloseTo(expected[i]!, 5);
    };
    compositor.render();
    checkHudUniforms();
    // The layer exists first, as it can during asynchronous Play world loading.
    const worldScene = new Scene(engine);
    const camera = new UniversalCamera("world", new Vector3(2000, 4, -8), worldScene);
    camera.setTarget(new Vector3(2000, 0, 0));
    worldScene.activeCamera = camera;
    for (const x of [2000, 20000]) {
      camera.position.x = x;
      worldScene.render();
      compositor.render();
      checkHudUniforms();
      compositor.resize();
      compositor.pickHits(256, 128);
    }
    compositor.dispose();
  });

  it("frames a Fit To Screen canvas widened to the output aspect, never stretched", () => {
    const { engine, compositor } = world();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(1920);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(1080);
    const hud = compositor.create({
      type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud-asset", zOrder: 0,
      ownerSceneGuid: null, postProcessStack: [], canvas: layerCanvas(32, 18),
    });
    const camera = hud.camera;
    expect(camera.orthoLeft).toBeCloseTo(-16);
    expect(camera.orthoRight).toBeCloseTo(16);
    expect(camera.orthoTop).toBeCloseTo(9);
    expect(camera.orthoBottom).toBeCloseTo(-9);

    const wide = compositor.create({
      type: "sceneLayerCreate", layerId: "wide", assetGuid: "wide-asset", zOrder: 1,
      ownerSceneGuid: null, postProcessStack: [], canvas: layerCanvas(20, 10),
    });
    // A 2:1 canvas on 16:9 output keeps its width and gains height.
    expect(wide.camera.orthoLeft).toBeCloseTo(-10);
    expect(wide.camera.orthoRight).toBeCloseTo(10);
    expect(wide.camera.orthoTop).toBeCloseTo(5.625);
    expect(wide.camera.orthoBottom).toBeCloseTo(-5.625);

    // Ultra-wide output: the 16:9 canvas keeps its height and gains width.
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(3440);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(1440);
    compositor.resize();
    expect(camera.orthoTop).toBeCloseTo(9);
    expect(camera.orthoRight).toBeCloseTo(9 * 3440 / 1440);
    expect(hud.viewBounds).toEqual({ width: 18 * 3440 / 1440, height: 18, center: [0, 0] });
  });

  it("frames the host's design-pixel screen for Fullscreen and shows True Pixel Size at its Root", () => {
    const engine = new NullEngine();
    engines.push(engine);
    let screen = { width: 6.4, height: 3.6 };
    const compositor = new SceneLayerCompositor({ engine, screen: () => screen });
    const fullscreen = compositor.create({
      type: "sceneLayerCreate", layerId: "full", assetGuid: "full-asset", zOrder: 0, ownerSceneGuid: null, postProcessStack: [],
      canvas: {
        design: { sizeMode: "fullscreen", customSizePx: { width: 400, height: 300 }, rootAnchor: "center", scaling: "fitToScreen" },
        rect: { width: 6.4, height: 3.6, center: [0, 0] },
      },
    });
    expect(fullscreen.camera.orthoTop).toBeCloseTo(1.8);
    expect(fullscreen.camera.orthoRight).toBeCloseTo(3.2);
    // Pixelated without Black Bars extended the framebuffer: one design pixel per framebuffer pixel still.
    screen = { width: 6.5, height: 4 };
    compositor.resize(true);
    expect(fullscreen.camera.orthoTop).toBeCloseTo(2);
    expect(fullscreen.camera.orthoRight).toBeCloseTo(3.25);

    screen = { width: 19.2, height: 10.8 };
    const panel = compositor.create({
      type: "sceneLayerCreate", layerId: "panel", assetGuid: "panel-asset", zOrder: 1, ownerSceneGuid: null, postProcessStack: [],
      canvas: {
        design: { sizeMode: "custom", customSizePx: { width: 400, height: 300 }, rootAnchor: "topLeft", scaling: "truePixelSize" },
        rect: { width: 4, height: 3, center: [2, -1.5] },
      },
    });
    // The canvas's top left, the layer's origin, is the screen's top left at one design pixel per pixel.
    expect(panel.camera.position.x).toBeCloseTo(9.6);
    expect(panel.camera.position.y).toBeCloseTo(-5.4);
    expect(panel.camera.orthoRight).toBeCloseTo(9.6);
    const corner = sceneLayerCanvasToLayer(0, 0, 1920, 1080, panel.viewBounds, panel.cameraState);
    expect(corner.x).toBeCloseTo(0);
    expect(corner.y).toBeCloseTo(0);
  });

  it("measures a Desired layer's drawn content, follows its changes and reports its view", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const views: Array<{ width: number; height: number; center: readonly [number, number] }> = [];
    const compositor = new SceneLayerCompositor({
      engine, screen: () => ({ width: 19.2, height: 10.8 }), onLayerView: (_id, view) => views.push(view),
    });
    const layer = compositor.create({
      type: "sceneLayerCreate", layerId: "badge", assetGuid: "badge-asset", zOrder: 0, ownerSceneGuid: null, postProcessStack: [],
      canvas: {
        design: { sizeMode: "desired", customSizePx: { width: 400, height: 300 }, rootAnchor: "center", scaling: "fitToScreen" },
        rect: { width: 19.2, height: 10.8, center: [0, 0] },
      },
    });
    const root = new Mesh("actor-1", layer.scene);
    root.isVisible = false;
    const quad = MeshBuilder.CreatePlane("badge-quad", { width: 4, height: 1 }, layer.scene);
    quad.position.set(3, 2, 0);
    // Babylon reuses a mesh's matrix within a render id, as a snapshot's move lands between frames.
    quad.computeWorldMatrix(true);
    compositor.render();
    // The 4 × 1 content fitted to 16:9 keeps its width; the hidden root and its empty geometry are not content.
    expect(layer.viewBounds.width).toBeCloseTo(4);
    expect(layer.viewBounds.height).toBeCloseTo(2.25);
    expect(layer.viewBounds.center[0]).toBeCloseTo(3);
    expect(layer.viewBounds.center[1]).toBeCloseTo(2);
    expect(views).toHaveLength(1);
    compositor.render();
    compositor.render();
    expect(views).toHaveLength(1);

    quad.scaling.x = 2;
    quad.computeWorldMatrix(true);
    compositor.render();
    expect(layer.viewBounds.width).toBeCloseTo(8);
    expect(views).toHaveLength(2);
  });

  it("leaves an untouched HUD camera and its matrices alone each frame, and restores one another owner moved", () => {
    const { compositor } = world();
    const layer = compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [],
      canvas: layerCanvas(20, 10),
    });
    const { camera, scene } = layer;
    compositor.render();
    const view = camera.getViewMatrix().updateFlag;
    const projection = camera.getProjectionMatrix().updateFlag;
    compositor.render();
    compositor.render();
    expect(camera.getViewMatrix().updateFlag).toBe(view);
    expect(camera.getProjectionMatrix().updateFlag).toBe(projection);

    camera.position.x = 3;
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    camera.orthoRight = 99;
    scene.activeCamera = new UniversalCamera("other", Vector3.Zero(), scene);
    compositor.render();
    expect(camera.position.asArray()).toEqual([0, 0, -10]);
    expect(camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(camera.orthoRight).toBe(10);
    expect(scene.activeCamera).toBe(camera);
    expect(camera.getViewMatrix().m[12]).toBeCloseTo(0);
    expect(camera.getViewMatrix().m[14]).toBeCloseTo(10);
  });

  it("poses the HUD camera at the layer camera's centre, roll and zoom, and restores that pose", () => {
    const { compositor } = world();
    const layer = compositor.create({
      type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud-asset", zOrder: 0,
      ownerSceneGuid: null, postProcessStack: [], canvas: layerCanvas(20, 10),
    });
    const { camera } = layer;
    compositor.setCamera("hud", { x: 3, y: -2, rotation: 90, zoom: 2 });
    expect(camera.position.asArray()).toEqual([3, -2, -10]);
    expect(camera.orthoRight).toBe(layer.viewBounds.width / 4);
    expect(camera.orthoTop).toBe(layer.viewBounds.height / 4);
    // Turned 90° counter-clockwise, the point one unit above the centre is on the view's right.
    const above = Vector3.TransformCoordinates(new Vector3(3, -1, 0), camera.getViewMatrix());
    expect(above.x).toBeCloseTo(1);
    expect(above.y).toBeCloseTo(0);

    camera.position.set(0, 0, -10);
    camera.rotation.z = 0;
    camera.orthoRight = 99;
    compositor.render();
    expect(camera.position.asArray()).toEqual([3, -2, -10]);
    expect(camera.rotation.z).toBeCloseTo(Math.PI / 2);
    expect(camera.orthoRight).toBe(layer.viewBounds.width / 4);
  });

  it("picks through a moved and turned layer camera where the canvas maps into the layer", () => {
    const { engine, compositor } = world();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(256);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(256);
    const layer = compositor.create({
      type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud-asset", zOrder: 0,
      ownerSceneGuid: null, postProcessStack: [], canvas: layerCanvas(9, 9),
    });
    const mesh = MeshBuilder.CreatePlane("actor-1", { width: 1, height: 1 }, layer.scene);
    mesh.position.set(5, 3, 0);
    // Babylon reuses a mesh's matrix within a render id; no frame renders here.
    mesh.computeWorldMatrix(true);
    mesh.isPickable = true;
    mesh.metadata = { overlayActorGuid: "card", overlayHitTest: "block" };
    // 3 units right of the canvas centre: layer (3, 0) under the default camera, so nothing is there.
    const canvasX = 128 + 3 * 256 / 9;
    expect(compositor.pickHits(canvasX, 128)).toEqual([]);
    compositor.setCamera("hud", { x: 5, y: 0, rotation: 90, zoom: 1 });
    const point = sceneLayerCanvasToLayer(canvasX, 128, 256, 256, layer.viewBounds, layer.cameraState);
    expect(point.x).toBeCloseTo(5);
    expect(point.y).toBeCloseTo(3);
    expect(compositor.pickHits(canvasX, 128)).toEqual([{ layerId: "hud", actorGuid: "card", hitTest: "block", hasButton: false }]);
  });

  it("sorts overlay draw order by zOrder and stable layer id on ties", () => {
    const { compositor } = world();
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "b",
      assetGuid: "hud",
      zOrder: 1,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "a",
      assetGuid: "hud",
      zOrder: 1,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "front",
      assetGuid: "hud",
      zOrder: 4,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    expect(compositor.sortedLayers().map((layer) => layer.layerId)).toEqual([
      "a",
      "b",
      "front",
    ]);
  });

  it("maps spawned slots onto the overlay scene and drops them on remove", () => {
    const { scene, compositor } = world();
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    compositor.noteSpawn(7, "hud");
    expect(compositor.slotIdsForLayer("hud")).toEqual([7]);
    expect(compositor.sceneForSlot(7)).toBe(compositor.layers()[0]?.scene);
    expect(compositor.sceneForSlot(7)).not.toBe(scene);
    compositor.remove("hud");
    expect(compositor.layers()).toHaveLength(0);
    expect(compositor.sceneForSlot(7)).toBeNull();
  });

  it("disposes the attached overlay post-process stack when the layer stack is cleared", () => {
    const engine = new NullEngine();
    engines.push(engine);
    let disposed = 0;
    const compositor = new SceneLayerCompositor({
      engine,
      attachLayerPostProcess: () => ({
        dispose: () => {
          disposed += 1;
        },
      }),
    });
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [{ materialGuid: "bloom", enabled: true }],
    });
    expect(disposed).toBe(0);
    compositor.setPostProcess("hud", []);
    expect(disposed).toBe(1);
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [{ materialGuid: "bloom", enabled: true }],
    });
    compositor.remove("hud");
    expect(disposed).toBe(2);
  });

  it("uses an output render target when a layer has post-process", () => {
    const { compositor } = world();
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [{ materialGuid: "bloom", enabled: true }],
    });
    const layer = compositor.layers()[0]!;
    expect(layer.camera.outputRenderTarget).not.toBeNull();
    compositor.setPostProcess("hud", []);
    expect(layer.camera.outputRenderTarget).toBeNull();
    expect(layer.scene.autoClear).toBe(false);
  });

  it("resizes layer targets at the frame boundary and waits for every retired graph before Scene disposal", async () => {
    const { engine } = world();
    engine.getCaps().depthTextureExtension = true;
    const depthTextures = vi.spyOn(engine, "createDepthStencilTexture");
    const renderers: SceneRenderCoordinator[] = [];
    const compositor = new SceneLayerCompositor({
      engine,
      attachLayerPostProcess: (_layer, _stack, renderer) => {
        renderers.push(renderer);
        return { dispose() {} };
      },
    });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: [{ materialGuid: "effect", enabled: true }] });
    const first = layer.camera.outputRenderTarget!;
    // Colour only: the layer's graph draws through its chain's scene depth, so the target has no depth texture or
    // renderbuffer of the canvas's size.
    expect(first.depthStencilTexture).toBeNull();
    expect(first.renderTarget!._generateDepthBuffer).toBe(false);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const retire = SceneRenderCoordinator.prototype.retire;
    // Preserve native cancellation/disposal, holding only completion of one owner.
    vi.spyOn(SceneRenderCoordinator.prototype, "retire").mockImplementation(function (this: SceneRenderCoordinator) {
      const retired = retire.call(this);
      return this === renderers[0] ? retired.then(() => held) : retired;
    });
    const disposeFirst = vi.spyOn(first, "dispose");
    const draw = vi.spyOn(layer.scene, "render");
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(first.getSize().width + 16);
    // A scaling controller may resize the engine without a host resize event.
    // Admission can hold drawing while replacement resources are prepared.
    compositor.render(new Set(), () => {});
    const next = layer.camera.outputRenderTarget!;
    expect(next).not.toBe(first);
    expect(next.getSize().width).toBe(first.getSize().width + 16);
    compositor.render(new Set(), () => {});
    expect(layer.camera.outputRenderTarget).toBe(next);
    expect(next.depthStencilTexture).toBeNull();
    // Only the shadow atlas's placeholder makes a depth texture.
    const depthOwners = depthTextures.mock.calls.map(([, , wrapper]) => wrapper);
    expect(depthOwners).not.toContain(first.renderTarget);
    expect(depthOwners).not.toContain(next.renderTarget);
    expect(renderers[1]).not.toBe(renderers[0]);
    expect(draw).not.toHaveBeenCalled();
    expect(disposeFirst).not.toHaveBeenCalled();
    compositor.remove("overlay");
    const completed = compositor.dispose();
    expect(compositor.layers()).toEqual([]);
    expect(layer.scene.isDisposed).toBe(false);
    await Promise.resolve();
    expect(disposeFirst).not.toHaveBeenCalled();
    release();
    await completed;
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(layer.scene.isDisposed).toBe(true);
  });

  it("keeps the removed layer's Scene and target until actual release confirms", async () => {
    const { engine } = world();
    const renderers: SceneRenderCoordinator[] = [];
    const compositor = new SceneLayerCompositor({
      engine,
      attachLayerPostProcess: (_layer, _stack, renderer) => {
        renderers.push(renderer);
        return { dispose() {} };
      },
    });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: [{ materialGuid: "effect", enabled: true }] });
    const target = layer.camera.outputRenderTarget!;
    const disposal = vi.spyOn(target, "dispose");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const whenReleased = SceneRenderCoordinator.prototype.whenReleased;
    // Hold only the actual-release boundary; bounded cleanup still completes.
    vi.spyOn(SceneRenderCoordinator.prototype, "whenReleased").mockImplementation(function (this: SceneRenderCoordinator) {
      return this === renderers[0] ? held : whenReleased.call(this);
    });
    compositor.remove("overlay");
    await compositor.dispose();
    await Promise.resolve();
    expect(compositor.layers()).toEqual([]);
    expect(layer.scene.isDisposed).toBe(false);
    expect(disposal).not.toHaveBeenCalled();
    release();
    await compositor.whenReleased();
    expect(disposal).toHaveBeenCalledOnce();
    expect(layer.scene.isDisposed).toBe(true);
  });

  it("disposes the removed layer after actual release even when the bounded report is uncertain", async () => {
    const { engine } = world();
    const compositor = new SceneLayerCompositor({ engine });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: [{ materialGuid: "effect", enabled: true }] });
    const target = layer.camera.outputRenderTarget!;
    const disposal = vi.spyOn(target, "dispose");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const retire = SceneRenderCoordinator.prototype.retire;
    // Bounded reporting rejects as uncertain, but actual release still confirms.
    vi.spyOn(SceneRenderCoordinator.prototype, "retire").mockImplementation(async function (this: SceneRenderCoordinator) {
      await retire.call(this);
      throw new Error("Native task cleanup failed.");
    });
    // Hold actual release so an uncertain bounded report cannot free the layer.
    vi.spyOn(SceneRenderCoordinator.prototype, "whenReleased").mockReturnValue(held);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    compositor.remove("overlay");
    await expect(compositor.dispose()).rejects.toThrow(/retirement failed/);
    expect(layer.scene.isDisposed).toBe(false);
    release();
    await compositor.whenReleased();
    expect(disposal).toHaveBeenCalledOnce();
    expect(layer.scene.isDisposed).toBe(true);
  });

  it("quarantines a removed layer's target and Scene when actual release never confirms", async () => {
    const { engine } = world();
    const compositor = new SceneLayerCompositor({ engine });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: [{ materialGuid: "effect", enabled: true }] });
    const target = layer.camera.outputRenderTarget!;
    const disposal = vi.spyOn(target, "dispose");
    const whenReleased = SceneRenderCoordinator.prototype.whenReleased;
    vi.spyOn(SceneRenderCoordinator.prototype, "whenReleased").mockImplementation(async function (this: SceneRenderCoordinator) {
      await whenReleased.call(this);
      throw new Error("Native release never confirmed.");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compositor.remove("overlay");
    // Bounded cleanup still completes; only the release boundary quarantines.
    await compositor.dispose();
    await expect(compositor.whenReleased()).rejects.toThrow();
    expect(compositor.layers()).toEqual([]);
    expect(layer.scene.isDisposed).toBe(false);
    expect(disposal).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes("quarantined")).length,
    ).toBeGreaterThan(0);
  });

  it("keeps only the last presented layer image while replacement graphs prepare without acknowledging it", async () => {
    const { engine } = world();
    adaptNullEngineFrameGraph(engine);
    // NullEngine omits the raw upload-ready flag that a WebGL2 Engine sets.
    // Preserve actual texture ownership and the production readiness checks.
    const upload = engine.createRawTexture.bind(engine);
    vi.spyOn(engine, "createRawTexture").mockImplementation((...args) => {
      const texture = upload(...args); texture.isReady = true; return texture;
    });
    const renderers: SceneRenderCoordinator[] = [];
    const compositor = new SceneLayerCompositor({ engine, attachLayerPostProcess: (_layer, _stack, renderer) => {
      renderers.push(renderer); return { dispose() {} };
    } });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: [{ materialGuid: "first", enabled: true }] });
    await compositor.prepare("overlay", () => {});
    await vi.waitFor(() => { expect(compositor.isReady("overlay")).toBe(true); });
    let acknowledged = false;
    compositor.render(new Set(), (_id, draw) => { acknowledged = draw(); });
    expect(acknowledged).toBe(true);
    const first = layer.camera.outputRenderTarget!;
    const oldBlit = engine.scenes.find((scene) => scene.getMeshByName("sceneLayerBlitPlane"))!;
    const plane = oldBlit.getMeshByName("sceneLayerBlitPlane")!;
    expect(plane.material!.needAlphaBlendingForMesh(plane)).toBe(true);
    const disposeFirst = vi.spyOn(first, "dispose");
    const fallbackDraw = vi.spyOn(oldBlit, "render");
    compositor.setPostProcess("overlay", [{ materialGuid: "second", enabled: true }]);
    const unrendered = layer.camera.outputRenderTarget!;
    const disposeUnrendered = vi.spyOn(unrendered, "dispose");
    // The held output and the layer's own Scene both belong to the compositor, so a leak check never takes them for editor Scenes.
    expect(compositor.ownedScenes()).toEqual(expect.arrayContaining([layer.scene, oldBlit]));
    vi.spyOn(renderers[1]!, "render").mockReturnValue({ path: "frameGraph", reason: "Waiting for native upload.", rendered: false, readyForPresentation: false });
    compositor.render(new Set(), (_id, draw) => { acknowledged = draw(); });
    expect(acknowledged).toBe(false);
    expect(fallbackDraw).toHaveBeenCalledOnce();
    expect(disposeFirst).not.toHaveBeenCalled();
    // A host pending-presentation gate may reject the new render before the
    // draw closure runs. It must still be able to compose the retained image.
    compositor.render(new Set(["overlay"]), (_id, _draw, fallback) => {
      acknowledged = false;
      fallback();
    });
    expect(acknowledged).toBe(false);
    expect(fallbackDraw).toHaveBeenCalledTimes(2);
    compositor.setPostProcess("overlay", [{ materialGuid: "third", enabled: true }]);
    await vi.waitFor(() => { expect(disposeUnrendered).toHaveBeenCalledOnce(); });
    expect(disposeFirst).not.toHaveBeenCalled();
    await compositor.prepare("overlay", () => {});
    await vi.waitFor(() => { expect(compositor.isReady("overlay")).toBe(true); });
    compositor.render(new Set(), (_id, draw) => { acknowledged = draw(); });
    expect(acknowledged).toBe(true);
    await vi.waitFor(() => { expect(disposeFirst).toHaveBeenCalledOnce(); });
    expect(fallbackDraw).toHaveBeenCalledTimes(2);
    expect(oldBlit.isDisposed).toBe(true);
    expect(compositor.ownedScenes()).not.toContain(oldBlit);
    await compositor.dispose();
    expect(compositor.ownedScenes()).toEqual([]);
  });

  it("follows a post-process rebuild during preparation and resolves for a layer removed while it prepares", async () => {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engines.push(engine);
    const renderers: SceneRenderCoordinator[] = [];
    const compositor = new SceneLayerCompositor({ engine, attachLayerPostProcess: (_layer, _stack, renderer) => {
      renderers.push(renderer); return { dispose() {} };
    } });
    compositor.create({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: [{ materialGuid: "first", enabled: true }] });
    // A script's sceneLayerPostProcess (or a resize) replaces the renderer the pending preparation awaits.
    const assertCurrent = () => {};
    const rebuilt = compositor.prepare("overlay", assertCurrent);
    compositor.setPostProcess("overlay", [{ materialGuid: "second", enabled: true }]);
    const followed = vi.spyOn(renderers[1]!, "prepare");
    await expect(rebuilt).resolves.toBeUndefined();
    // The caller's own preparation reached the replacement: the readiness probe's background preparation passes no `assertCurrent`.
    expect(followed).toHaveBeenCalledWith(assertCurrent);
    await vi.waitFor(() => { expect(compositor.isReady("overlay")).toBe(true); });
    const removed = compositor.prepare("overlay", () => {});
    compositor.remove("overlay");
    await expect(removed).resolves.toBeUndefined();
    await compositor.dispose();
  });

  it("keeps a layer's probes scoped to the changed visuals in the renderer a post-process rebuild makes", async () => {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engines.push(engine);
    const renderers: SceneRenderCoordinator[] = [];
    const compositor = new SceneLayerCompositor({ engine, attachLayerPostProcess: (_layer, _stack, renderer) => {
      renderers.push(renderer); return { dispose() {} };
    } });
    compositor.create({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: [{ materialGuid: "first", enabled: true }] });
    compositor.setPostProcess("overlay", [{ materialGuid: "second", enabled: true }]);
    expect(renderers).toHaveLength(2);
    expect(renderers[1]).not.toBe(renderers[0]);
    const scoped = (renderer: SceneRenderCoordinator) =>
      (renderer as unknown as { graph: { scopedStrictProbes: boolean } }).graph.scopedStrictProbes;
    expect(renderers.map(scoped)).toEqual([true, true]);
    await compositor.dispose();
  });

  it("stops following renderer replacements once the preparation ceiling has passed", async () => {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engines.push(engine);
    const renderers: SceneRenderCoordinator[] = [];
    const compositor = new SceneLayerCompositor({ engine, attachLayerPostProcess: (_layer, _stack, renderer) => {
      renderers.push(renderer); return { dispose() {} };
    } });
    compositor.create({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: [{ materialGuid: "first", enabled: true }] });
    const preparing = compositor.prepare("overlay", () => {});
    compositor.setPostProcess("overlay", [{ materialGuid: "second", enabled: true }]);
    // Each replacement's coordinator starts fresh bounds. A script keeps replacing the graph faster than it prepares:
    // once preparation follows the first replacement, the ceiling passes and the graph is replaced again.
    const follow = renderers[1]!.prepare.bind(renderers[1]);
    const now = performance.now.bind(performance);
    vi.spyOn(renderers[1]!, "prepare").mockImplementation((...args) => {
      const followed = follow(...args);
      vi.spyOn(performance, "now").mockImplementation(() => now() + SCENE_PREPARATION_CEILING_MS);
      compositor.setPostProcess("overlay", [{ materialGuid: "third", enabled: true }]);
      return followed;
    });
    await expect(preparing).rejects.toBeInstanceOf(PreparationTimedOut);
    await compositor.dispose();
  });

  it("inflates 2DButton picks to touchMinTargetPx without changing the visual", () => {
    const { engine, compositor } = world();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(256);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(256);
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [],
      canvas: layerCanvas(9, 9),
    });
    const layer = compositor.layers()[0]!;
    const mesh = MeshBuilder.CreatePlane(
      "actor-1",
      { width: 0.32, height: 0.32 },
      layer.scene,
    );
    mesh.isPickable = true;
    mesh.metadata = {
      overlayActorGuid: "btn",
      overlayHitTest: "block",
      overlayHasButton: true,
    };
    mesh.computeWorldMatrix(true);
    mesh.refreshBoundingInfo(false, false);

    const missX = 128 + 20;
    const exact = compositor.pickHits(missX, 128);
    expect(exact.some((hit) => hit.actorGuid === "btn")).toBe(false);

    const inflated = compositor.pickHits(missX, 128, {
      minTargetPx: 44,
      canvasCssHeight: 256,
    });
    expect(inflated).toEqual([
      {
        layerId: "hud",
        actorGuid: "btn",
        hitTest: "block",
        hasButton: true,
      },
    ]);
    mesh.refreshBoundingInfo(false, false);
    const extent = mesh.getBoundingInfo().boundingBox.extendSize;
    expect(extent.x * 2).toBeCloseTo(0.32);

    // The floor only widens eligible buttons; hidden or disabled ones stay inert.
    const floor = { minTargetPx: 44, canvasCssHeight: 256 };
    mesh.isVisible = false;
    expect(compositor.pickHits(missX, 128, floor)).toEqual([]);
    mesh.isVisible = true;
    mesh.setEnabled(false);
    expect(compositor.pickHits(missX, 128, floor)).toEqual([]);
  });

  it("maps the pointer through pick space when dynamic resolution raises the hardware scaling level", () => {
    const { engine, compositor } = world();
    // A 128 px drawing buffer at level 2 is picked like a 256 px canvas.
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(128);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(128);
    vi.spyOn(engine, "getHardwareScalingLevel").mockReturnValue(2);
    const layer = compositor.create({
      type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud-asset", zOrder: 0,
      ownerSceneGuid: null, postProcessStack: [], canvas: layerCanvas(9, 9),
    });
    const button = MeshBuilder.CreatePlane("actor-1", { width: 0.32, height: 0.32 }, layer.scene);
    button.metadata = { overlayActorGuid: "btn", overlayHitTest: "block", overlayHasButton: true };
    button.computeWorldMatrix(true);
    const floor = { minTargetPx: 44, canvasCssHeight: 256 };
    // 20 pick px right of the centre is 0.70 units: past the quad, inside the 44 px floor (0.77 units each side).
    expect(compositor.pickHits(148, 128, floor).map((hit) => hit.actorGuid)).toEqual(["btn"]);
    // 64 pick px is 2.25 units left of the centre; render size alone would read it as the centre.
    expect(compositor.pickHits(64, 128, floor)).toEqual([]);
  });

  describe("touch-target floor over a busy layer", () => {
    const floor = { minTargetPx: 44, canvasCssHeight: 256 };
    function busyLayer() {
      const { engine, compositor } = world();
      vi.spyOn(engine, "getRenderWidth").mockReturnValue(256);
      vi.spyOn(engine, "getRenderHeight").mockReturnValue(256);
      const layer = compositor.create({
        type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud-asset", zOrder: 0,
        ownerSceneGuid: null, postProcessStack: [], canvas: layerCanvas(9, 9),
      });
      const plane = (name: string, x: number, y: number, metadata: Record<string, unknown>) => {
        const mesh = MeshBuilder.CreatePlane(name, { width: 0.32, height: 0.32 }, layer.scene);
        mesh.position.set(x, y, 0);
        // Babylon reuses a mesh's matrix within a render id; no frame renders here.
        mesh.computeWorldMatrix(true);
        mesh.metadata = metadata;
        return mesh;
      };
      return { compositor, layer, plane };
    }

    it("returns inflated button, joystick and control hits in scene order among bystanders, before Babylon announces the meshes", () => {
      const { compositor, plane } = busyLayer();
      const block = { overlayHitTest: "block" };
      plane("first-button", -0.5, 0, { ...block, overlayActorGuid: "first", overlayHasButton: true });
      plane("panel-a", 3, 3, { ...block, overlayActorGuid: "panel-a" });
      plane("stick", 0.5, 0, { ...block, overlayActorGuid: "stick", overlayJoystickMeshName: "stick-mesh" });
      plane("panel-b", -3, 3, { ...block, overlayActorGuid: "panel-b" });
      plane("slider", 0, 0.5, { ...block, overlayActorGuid: "slider", overlayControlMeshName: "slider-mesh", overlayControlComponentId: "value" });
      plane("last-button", 0, -0.5, { ...block, overlayActorGuid: "last", overlayHasButton: true, overlayButtonComponentId: "press" });
      // The centre of the layer is half a unit from each target and misses all of their quads.
      expect(compositor.pickHits(128, 128)).toEqual([]);
      expect(compositor.pickHits(128, 128, floor)).toEqual([
        { layerId: "hud", actorGuid: "first", hitTest: "block", hasButton: true },
        { layerId: "hud", actorGuid: "stick", hitTest: "block", hasButton: false, joystickMeshName: "stick-mesh" },
        { layerId: "hud", actorGuid: "slider", hitTest: "block", hasButton: false, componentId: "value", controlMeshName: "slider-mesh" },
        { layerId: "hud", actorGuid: "last", hitTest: "block", hasButton: true, componentId: "press" },
      ]);
    });

    it("adds no per-mesh work to the ray pick when widening touch targets", () => {
      const { compositor, plane } = busyLayer();
      plane("button", 0, 0, { overlayHitTest: "block", overlayActorGuid: "button", overlayHasButton: true });
      const bystanders = Array.from({ length: 40 }, (_, index) =>
        plane(`panel-${index}`, 3 + (index % 5) * 0.2, 3 - Math.floor(index / 5) * 0.2, { overlayHitTest: "block", overlayActorGuid: `panel-${index}` }));
      const spies = bystanders.map((mesh) => vi.spyOn(mesh, "isEnabled"));
      const visits = () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
      // 20 px right of the button's centre misses its quad but lands inside the 44 px floor.
      compositor.pickHits(148, 128);
      const rayOnly = visits();
      // The ray pick must have examined the bystanders, or this comparison proves nothing.
      expect(rayOnly).toBeGreaterThan(0);
      spies.forEach((spy) => spy.mockClear());
      expect(compositor.pickHits(148, 128, floor).map((hit) => hit.actorGuid)).toEqual(["button"]);
      expect(visits()).toBe(rayOnly);
    });

    it("still finds touch targets when the ray pick does not offer every mesh", () => {
      const { compositor, layer, plane } = busyLayer();
      plane("button", 0, 0, { overlayHitTest: "block", overlayActorGuid: "button", overlayHasButton: true });
      plane("panel", 3, 3, { overlayHitTest: "block", overlayActorGuid: "panel" });
      vi.spyOn(layer.scene, "pick").mockReturnValue(new PickingInfo());
      expect(compositor.pickHits(148, 128, floor).map((hit) => hit.actorGuid)).toEqual(["button"]);
    });
  });

  it("keeps overlay NDC stable when the world camera translates", () => {
    const { scene, compositor, engine } = world();
    const worldCam = new UniversalCamera("world", new Vector3(0, 0, -10), scene);
    scene.activeCamera = worldCam;
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: "level",
      postProcessStack: [],
    });
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "pause",
      assetGuid: "pause-asset",
      zOrder: 1,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    expect(compositor.layers()).toHaveLength(2);
    const layer = compositor.layers()[0]!;
    expect(layer.scene.clearColor.a).toBe(0);
    const mesh = MeshBuilder.CreatePlane("overlay-quad", { size: 1 }, layer.scene);
    mesh.position.set(2, 1, 0);
    mesh.computeWorldMatrix(true);
    layer.scene.updateTransformMatrix();
    const viewport = layer.camera.viewport.toGlobal(
      engine.getRenderWidth(),
      engine.getRenderHeight(),
    );
    const before = Vector3.Project(
      mesh.getAbsolutePosition(),
      Matrix.Identity(),
      layer.scene.getTransformMatrix(),
      viewport,
    );
    worldCam.position.x += 12;
    worldCam.position.y -= 4;
    scene.updateTransformMatrix();
    layer.scene.updateTransformMatrix();
    const after = Vector3.Project(
      mesh.getAbsolutePosition(),
      Matrix.Identity(),
      layer.scene.getTransformMatrix(),
      viewport,
    );
    expect(mesh.parent).toBeNull();
    expect(layer.camera.parent).toBeNull();
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    const worldMesh = MeshBuilder.CreatePlane("world-quad", { size: 1 }, scene);
    worldMesh.position.set(2, 1, 0);
    worldMesh.computeWorldMatrix(true);
    const worldViewport = worldCam.viewport.toGlobal(
      engine.getRenderWidth(),
      engine.getRenderHeight(),
    );
    scene.updateTransformMatrix();
    const worldBefore = Vector3.Project(
      worldMesh.getAbsolutePosition(),
      Matrix.Identity(),
      scene.getTransformMatrix(),
      worldViewport,
    );
    worldCam.position.x += 12;
    worldCam.position.y -= 4;
    scene.updateTransformMatrix();
    const worldAfter = Vector3.Project(
      worldMesh.getAbsolutePosition(),
      Matrix.Identity(),
      scene.getTransformMatrix(),
      worldViewport,
    );
    expect(worldAfter.x).not.toBeCloseTo(worldBefore.x);
    expect(compositor.layers().map((entry) => entry.layerId).sort()).toEqual([
      "hud",
      "pause",
    ]);
  });

  it("restores the HUD ortho camera before each overlay render", () => {
    const { compositor, engine } = world();
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    const layer = compositor.layers()[0]!;
    const mesh = MeshBuilder.CreatePlane("overlay-quad", { size: 1 }, layer.scene);
    mesh.position.set(2, 1, 0);
    mesh.computeWorldMatrix(true);
    layer.scene.updateTransformMatrix();
    const viewport = layer.camera.viewport.toGlobal(
      engine.getRenderWidth(),
      engine.getRenderHeight(),
    );
    const before = Vector3.Project(
      mesh.getAbsolutePosition(),
      Matrix.Identity(),
      layer.scene.getTransformMatrix(),
      viewport,
    );

    layer.camera.mode = Camera.PERSPECTIVE_CAMERA;
    layer.camera.fov = 1.2;
    layer.camera.position.set(8, -3, 4);
    layer.scene.activeCamera = null;

    compositor.render();

    expect(layer.scene.activeCamera).toBe(layer.camera);
    expect(layer.camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(layer.camera.position.x).toBeCloseTo(0);
    expect(layer.camera.position.y).toBeCloseTo(0);
    expect(layer.camera.position.z).toBeCloseTo(-10);
    expect(layer.camera.parent).toBeNull();
    layer.scene.updateTransformMatrix();
    const after = Vector3.Project(
      mesh.getAbsolutePosition(),
      Matrix.Identity(),
      layer.scene.getTransformMatrix(),
      viewport,
    );
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("keeps overlay NDC stable when the world camera rotates or changes FOV", () => {
    const { scene, compositor, engine } = world();
    const worldCam = new UniversalCamera("world", new Vector3(0, 2, -8), scene);
    worldCam.mode = Camera.PERSPECTIVE_CAMERA;
    worldCam.fov = 0.8;
    scene.activeCamera = worldCam;
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    const layer = compositor.layers()[0]!;
    const mesh = MeshBuilder.CreatePlane("overlay-quad", { size: 1 }, layer.scene);
    mesh.position.set(1.5, 0.5, 0);
    mesh.computeWorldMatrix(true);
    compositor.render();
    layer.scene.updateTransformMatrix();
    const viewport = layer.camera.viewport.toGlobal(
      engine.getRenderWidth(),
      engine.getRenderHeight(),
    );
    const before = Vector3.Project(
      mesh.getAbsolutePosition(),
      Matrix.Identity(),
      layer.scene.getTransformMatrix(),
      viewport,
    );

    worldCam.rotation.y += 0.7;
    worldCam.fov = 1.4;
    worldCam.position.x += 6;
    scene.updateTransformMatrix();
    compositor.render();
    layer.scene.updateTransformMatrix();
    const after = Vector3.Project(
      mesh.getAbsolutePosition(),
      Matrix.Identity(),
      layer.scene.getTransformMatrix(),
      viewport,
    );
    expect(layer.camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  /** A prepared layer on a NullEngine that runs the real graph, with a hidden actor root, its drawn label and a disabled part. */
  async function preparedHud() {
    const engine = adaptNullEngineFrameGraph(new NullEngine({
      renderWidth: 640, renderHeight: 360, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1,
    }));
    engines.push(engine);
    const compositor = new SceneLayerCompositor({ engine });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud", zOrder: 0, ownerSceneGuid: null, postProcessStack: [], canvas: layerCanvas(32, 18) });
    const quad = (name: string, x: number) => {
      const mesh = MeshBuilder.CreatePlane(name, { size: 1 }, layer.scene);
      applyOverlayUnlitMaterial(mesh);
      mesh.position.x = x;
      return mesh;
    };
    const root = new Mesh("actor-1", layer.scene);
    root.isVisible = false;
    const label = quad("label", -2);
    label.parent = root;
    const caret = quad("caret", 0);
    caret.parent = root;
    caret.setEnabled(false);
    const icon = quad("icon", 2);
    await compositor.prepare("hud", () => {});
    return { engine, compositor, layer, scene: layer.scene, root, label, caret, icon, quad };
  }

  /** The meshes one compositor frame dispatched to its passes, by name in dispatch order. */
  function dispatched(engine: NullEngine, compositor: SceneLayerCompositor): string[] {
    const meshes: string[] = [];
    const dispatch = RenderingManager.prototype.dispatch;
    const spy = vi.spyOn(RenderingManager.prototype, "dispatch").mockImplementation(function (this: RenderingManager, subMesh, mesh, material) {
      meshes.push((mesh ?? subMesh.getMesh()).name);
      return dispatch.call(this, subMesh, mesh, material);
    });
    try {
      engine.beginFrame();
      compositor.render();
      engine.endFrame();
    } finally {
      spy.mockRestore();
    }
    return meshes;
  }

  it("admits a layer's lights and shadows only on frames with something to admit", async () => {
    const { engine, compositor, scene, icon } = await preparedHud();
    // Play's visual factory gives every Scene with visuals a shadow controller, a layer's included.
    const shadows = sceneShadowController(scene);
    const admissions = () => compositor.diagnostics()[0]!.work.shadowAdmissions;
    admissions();
    dispatched(engine, compositor);
    const steady = admissions();
    dispatched(engine, compositor);
    dispatched(engine, compositor);
    expect(admissions()).toBe(steady);
    // A mesh whose shadow participation changes is classified by the next admission.
    shadows.setParticipation(icon, { castShadows: false, receiveShadows: true });
    dispatched(engine, compositor);
    expect(admissions()).toBeGreaterThan(steady);
    const classified = admissions();
    dispatched(engine, compositor);
    expect(admissions()).toBe(classified);
    const steadyAgain = admissions();
    // A Material joining changes what the light block's next sync writes: that frame admits.
    new StandardMaterial("joined", scene);
    dispatched(engine, compositor);
    expect(admissions()).toBeGreaterThan(steadyAgain);
    const settled = admissions();
    dispatched(engine, compositor);
    expect(admissions()).toBe(settled);
    // So does a light, on the frame it appears.
    new HemisphericLight("sun", Vector3.Up(), scene);
    dispatched(engine, compositor);
    expect(admissions()).toBeGreaterThan(settled);
    const lit = admissions();
    dispatched(engine, compositor);
    expect(admissions()).toBeGreaterThan(lit);
  });

  it.each<[string, (hud: Awaited<ReturnType<typeof preparedHud>>) => void, string[]]>([
    ["nothing changes", () => {}, ["label", "icon"]],
    ["a disabled part is enabled before the frame's draw", ({ scene, caret }) => {
      scene.onBeforeRenderObservable.addOnce(() => caret.setEnabled(true));
    }, ["label", "caret", "icon"]],
    ["the hidden root gains a drawable child", ({ quad, root }) => { quad("badge", 4).parent = root; }, ["label", "icon", "badge"]],
    ["a mesh is hidden", ({ label }) => { label.isVisible = false; }, ["icon"]],
    ["a mesh is removed", ({ icon }) => icon.dispose(), ["label"]],
    ["a text's geometry is redrawn", ({ label }) => {
      MeshBuilder.CreatePlane("glyphs", { width: 3, height: 1 }, label.getScene()).geometry!.applyToMesh(label);
      label.getScene().getMeshByName("glyphs")!.dispose();
    }, ["label", "icon"]],
    ["the layer's camera and output size change", ({ compositor, engine }) => {
      compositor.setCamera("hud", { x: 3, y: 1, rotation: 20, zoom: 2 });
      engine.setSize(320, 360);
    }, ["label", "icon"]],
  ])("draws what can draw on the frame %s", async (_name, change, expected) => {
    const hud = await preparedHud();
    dispatched(hud.engine, hud.compositor);
    change(hud);
    expect(dispatched(hud.engine, hud.compositor)).toEqual(expected);
    expect(hud.compositor.diagnostics()[0]!.drawable).toMatchObject({ mismatches: 0 });
  });

  it("keeps a layer's drawable meshes from its creation until its Scene is released", async () => {
    const { compositor, scene } = await preparedHud();
    expect(layerDrawableMeshes(scene)?.map((mesh) => mesh.name)).toEqual(["label", "icon"]);
    compositor.remove("hud");
    await compositor.whenReleased();
    expect(layerDrawableMeshes(scene)).toBeUndefined();
  });

  it("does not re-probe strict layer readiness on unchanged frames", async () => {
    const engine = new NullEngine();
    engines.push(engine);
    // NullEngine omits the raw upload-ready flag that a WebGL2 Engine sets.
    const upload = engine.createRawTexture.bind(engine);
    vi.spyOn(engine, "createRawTexture").mockImplementation((...args) => {
      const texture = upload(...args); texture.isReady = true; return texture;
    });
    // NullEngine lacks the MRT driver boundary; keep the real graph and tasks.
    vi.spyOn(engine, "buildTextureLayout").mockImplementation((enabled, backbuffer) =>
      backbuffer ? [0x0405] : enabled.map((value, index) => (value ? 0x8ce0 + index : 0)));
    vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
    vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
    vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(() => {});
    const compositor = new SceneLayerCompositor({ engine });
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    await compositor.prepare("hud", () => {});
    expect(compositor.isReady("hud")).toBe(true);
    const probe = vi.spyOn(scenePerf, "isSceneFrameReady");
    expect(compositor.isReady("hud")).toBe(true);
    expect(compositor.isReady("hud")).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    MeshBuilder.CreateBox("added", {}, compositor.layers()[0]!.scene);
    compositor.isReady("hud");
    expect(probe).toHaveBeenCalled();
    compositor.dispose();
  });
});
