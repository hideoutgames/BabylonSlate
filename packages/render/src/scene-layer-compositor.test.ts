import { Camera } from "@babylonjs/core/Cameras/camera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { Scene } from "@babylonjs/core/scene";
import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sceneLayerCanvasToLayer } from "@haptic/core";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { sceneDrawBatcher } from "./draw-batching";
import { PreparationTimedOut, SceneRenderCoordinator } from "./scene-render-coordinator";
import { SCENE_PREPARATION_CEILING_MS } from "./stall-deadline";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import * as scenePerf from "./scene-perf";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { layerDrawableMeshes } from "./layer-drawable-meshes";
import { sceneShadowController } from "./shadow-controller";
import { applyOverlayUnlitMaterial } from "./overlay-texture-quad";
import { layerCanvas } from "./scene-layer-canvas-fixtures";
import { isTargetedLayerScene } from "./layer-composite";
import { Constants } from "@babylonjs/core/Engines/constants";
import { sceneGlyphAtlas } from "./text2d-glyph-atlas";
import { LayerImageAtlas } from "./layer-image-atlas";
import { copyLayerFrameStats } from "./layer-frame-stats";
import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";


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
      canvas: layerCanvas(32, 18),
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
      type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud-asset", zOrder: 0, ownerSceneGuid: null, canvas: layerCanvas(32, 18),
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
      compositor.create({ type: "sceneLayerCreate", layerId, assetGuid: `${layerId}-asset`, zOrder, ownerSceneGuid: null, canvas: layerCanvas(32, 18) });
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
    compositor.setPostProcess(postProcess ? [{ id: "pass", materialGuid: "pass", enabled: true }] : []);
    const layer = compositor.create({
      type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud", zOrder: 0,
      ownerSceneGuid: null, canvas: layerCanvas(32, 18),
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
      ownerSceneGuid: null, canvas: layerCanvas(32, 18),
    });
    const camera = hud.camera;
    expect(camera.orthoLeft).toBeCloseTo(-16);
    expect(camera.orthoRight).toBeCloseTo(16);
    expect(camera.orthoTop).toBeCloseTo(9);
    expect(camera.orthoBottom).toBeCloseTo(-9);

    const wide = compositor.create({
      type: "sceneLayerCreate", layerId: "wide", assetGuid: "wide-asset", zOrder: 1,
      ownerSceneGuid: null, canvas: layerCanvas(20, 10),
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
      type: "sceneLayerCreate", layerId: "full", assetGuid: "full-asset", zOrder: 0, ownerSceneGuid: null,
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
      type: "sceneLayerCreate", layerId: "panel", assetGuid: "panel-asset", zOrder: 1, ownerSceneGuid: null,
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
    let screen = { width: 19.2, height: 10.8 };
    const compositor = new SceneLayerCompositor({
      engine, screen: () => screen, onLayerView: (_id, view) => views.push(view),
    });
    const layer = compositor.create({
      type: "sceneLayerCreate", layerId: "badge", assetGuid: "badge-asset", zOrder: 0, ownerSceneGuid: null,
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

    // A new screen reframes it, and the runtime hears the new view.
    screen = { width: 25.2, height: 10.8 };
    compositor.resize(true);
    expect(views).toHaveLength(3);

    // With nothing left to draw, it is the Fullscreen canvas again, framing the whole screen.
    quad.setEnabled(false);
    compositor.render();
    expect(layer.viewBounds.width).toBeCloseTo(25.2);
    expect(layer.viewBounds.height).toBeCloseTo(10.8);
    expect(layer.viewBounds.center[0]).toBeCloseTo(0);
  });

  it("leaves an untouched HUD camera and its matrices alone each frame, and restores one another owner moved", () => {
    const { compositor } = world();
    const layer = compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: null,
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
      ownerSceneGuid: null, canvas: layerCanvas(20, 10),
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
      ownerSceneGuid: null, canvas: layerCanvas(9, 9),
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
      canvas: layerCanvas(32, 18),
    });
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "a",
      assetGuid: "hud",
      zOrder: 1,
      ownerSceneGuid: null,
      canvas: layerCanvas(32, 18),
    });
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "front",
      assetGuid: "hud",
      zOrder: 4,
      ownerSceneGuid: null,
      canvas: layerCanvas(32, 18),
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
      canvas: layerCanvas(32, 18),
    });
    compositor.noteSpawn(7, "hud");
    expect(compositor.slotIdsForLayer("hud")).toEqual([7]);
    expect(compositor.sceneForSlot(7)).toBe(compositor.layers()[0]?.scene);
    expect(compositor.sceneForSlot(7)).not.toBe(scene);
    compositor.remove("hud");
    expect(compositor.layers()).toHaveLength(0);
    expect(compositor.sceneForSlot(7)).toBeNull();
  });

  describe("Scene Layer post-processing", () => {
    const pass = (id: string, enabled = true) => ({ id, materialGuid: id, enabled });
    const create = (compositor: SceneLayerCompositor, layerId: string, zOrder = 0) =>
      compositor.create({ type: "sceneLayerCreate", layerId, assetGuid: layerId, zOrder, ownerSceneGuid: null, canvas: layerCanvas(32, 18) });
    /** The Scene the passes run in: it draws the layers' shared target full screen. */
    const passScene = (engine: NullEngine) =>
      engine.scenes.find((scene) => !scene.isDisposed && scene.getMeshByName("sceneLayerPostProcessInput")) ?? null;
    const sharedTargets = (engine: NullEngine) =>
      engine.scenes.flatMap((scene) => scene.isDisposed ? [] : scene.textures.filter((texture) => texture.name === "sceneLayerTarget"));
    const sceneOf = (renderer: SceneRenderCoordinator) => (renderer as unknown as { scene: Scene }).scene;
    const layerRenderer = (compositor: SceneLayerCompositor, layerId: string) =>
      (compositor as unknown as { byId: Map<string, { renderer: SceneRenderCoordinator }> }).byId.get(layerId)!.renderer;
    const drawn = { path: "frameGraph" as const, rendered: true, readyForPresentation: true };

    function stackWorld(attached: SceneRenderCoordinator[] = [], disposed: { count: number } = { count: 0 }) {
      const { engine } = world();
      engine.getCaps().depthTextureExtension = true;
      const compositor = new SceneLayerCompositor({
        engine,
        attachLayerPostProcess: (_view, _stack, renderer) => {
          attached.push(renderer);
          return { dispose: () => { disposed.count += 1; } };
        },
      });
      return { engine, compositor };
    }

    it("draws each layer straight over the world, with no shared target or pass, while no pass is enabled", () => {
      const attached: SceneRenderCoordinator[] = [];
      const { engine, compositor } = stackWorld(attached);
      compositor.setPostProcess([pass("off", false)]);
      const hud = create(compositor, "hud", 1);
      const menu = create(compositor, "menu", 2);
      const render = vi.spyOn(SceneRenderCoordinator.prototype, "render").mockReturnValue(drawn);
      compositor.render();
      expect([hud.camera.outputRenderTarget, menu.camera.outputRenderTarget]).toEqual([null, null]);
      expect(attached).toEqual([]);
      expect(passScene(engine)).toBeNull();
      expect(sharedTargets(engine)).toEqual([]);
      // One draw per layer, each over the colour beneath, as layers without passes always drew.
      expect((render.mock.contexts as SceneRenderCoordinator[]).map(sceneOf)).toEqual([hud.scene, menu.scene]);
      expect([hud.scene.autoClear, menu.scene.autoClear]).toEqual([false, false]);
      // A steady frame draws without validating its presentation (a second strict round after each draw); a layer
      // that presents for the first time, which its loading owner waits on, validates.
      expect(render.mock.calls).toEqual([[false], [false]]);
      render.mockClear();
      compositor.render(new Set(["menu"]));
      expect(render.mock.calls).toEqual([[false], [true]]);
      expect(compositor.ownedScenes()).toEqual(expect.arrayContaining([hud.scene, menu.scene]));
      expect(compositor.ownedScenes()).toHaveLength(2);
    });

    it("draws every layer into one shared target and runs the passes once over it, whatever the number of layers", () => {
      const attached: SceneRenderCoordinator[] = [];
      const { engine, compositor } = stackWorld(attached);
      const before = create(compositor, "before", 3);
      compositor.setPostProcess([pass("off", false), pass("glow")]);
      const after = create(compositor, "after", 1);
      const third = create(compositor, "third", 2);
      const passes = passScene(engine)!;
      const [target] = sharedTargets(engine) as RenderTargetTexture[];
      expect(sharedTargets(engine)).toHaveLength(1);
      // One pass chain, in a Scene of its own, for the enabled pass only.
      expect(attached.map(sceneOf)).toEqual([passes]);
      for (const layer of [before, after, third]) {
        const view = layer.camera.outputRenderTarget!;
        // A renderer's output belongs to its own Scene: each layer views the same colour and depth textures.
        expect(view.getScene()).toBe(layer.scene);
        expect(view.renderTargetOptions.colorAttachment).toBe(target!.getInternalTexture());
        expect(view.depthStencilTexture).not.toBeNull();
        expect(view.depthStencilTexture).toBe(target!.depthStencilTexture);
      }
      const render = vi.spyOn(SceneRenderCoordinator.prototype, "render").mockReturnValue(drawn);
      compositor.render();
      // Layers in draw order, then the passes once; only the first layer clears the shared target.
      expect((render.mock.contexts as SceneRenderCoordinator[]).map(sceneOf)).toEqual([after.scene, third.scene, before.scene, passes]);
      expect(render.mock.calls).toEqual([[false], [false], [false], [false]]);
      expect([after.scene.autoClear, third.scene.autoClear, before.scene.autoClear]).toEqual([true, false, false]);
      compositor.remove("third");
      create(compositor, "fourth", 4);
      expect(attached).toHaveLength(1);
      expect(sharedTargets(engine)).toEqual([target]);
    });

    it("marks every layer targeted while the passes run, through every change of the list or the switch, and blits premultiplied", () => {
      const { engine } = world();
      engine.getCaps().depthTextureExtension = true;
      let enabled = true;
      const compositor = new SceneLayerCompositor({ engine, postProcessingEnabled: () => enabled, attachLayerPostProcess: () => ({ dispose() {} }) });
      const hud = create(compositor, "hud", 1);
      expect(isTargetedLayerScene(hud.scene)).toBe(false);
      compositor.setPostProcess([pass("grade")]);
      const menu = create(compositor, "menu", 2);
      expect([isTargetedLayerScene(hud.scene), isTargetedLayerScene(menu.scene)]).toEqual([true, true]);
      // The passes' output over the world is premultiplied colour and coverage; the held composite redraws that Scene.
      const blit = engine.scenes.find((scene) => !scene.isDisposed && scene.getMeshByName("sceneLayerBlitPlane"))!.getMeshByName("sceneLayerBlitPlane")!;
      expect(blit.material!.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED);
      compositor.setPostProcess([pass("grade", false)]);
      expect([isTargetedLayerScene(hud.scene), isTargetedLayerScene(menu.scene)]).toEqual([false, false]);
      compositor.setPostProcess([pass("grade")]);
      expect(isTargetedLayerScene(hud.scene)).toBe(true);
      enabled = false;
      compositor.refreshPostProcess();
      expect(isTargetedLayerScene(hud.scene)).toBe(false);
      enabled = true;
      compositor.refreshPostProcess();
      expect(isTargetedLayerScene(hud.scene)).toBe(true);
    });

    it("blends the layers' ordinary blending premultiplied into the shared target, and nothing else", () => {
      const { engine, compositor } = stackWorld();
      const hud = create(compositor, "hud", 1);
      const modes: string[] = [];
      vi.spyOn(SceneRenderCoordinator.prototype, "render").mockImplementation(function (this: SceneRenderCoordinator) {
        for (const mode of [Constants.ALPHA_COMBINE, Constants.ALPHA_ADD]) {
          engine.setAlphaMode(mode);
          modes.push(`${sceneOf(this) === hud.scene ? "hud" : "passes"}:${engine.getAlphaMode()}`);
        }
        return drawn;
      });
      compositor.render();
      // Straight over the world: as before.
      expect(modes).toEqual([`hud:${Constants.ALPHA_COMBINE}`, `hud:${Constants.ALPHA_ADD}`]);
      modes.length = 0;
      compositor.setPostProcess([pass("grade")]);
      compositor.render();
      expect(modes).toEqual([
        `hud:${Constants.ALPHA_LAYER_ACCUMULATE}`, `hud:${Constants.ALPHA_ADD}`,
        `passes:${Constants.ALPHA_COMBINE}`, `passes:${Constants.ALPHA_ADD}`,
      ]);
    });

    it("replaces only the passes for a new pass list, and the target and every layer's renderer for a new size or no passes", async () => {
      const attached: SceneRenderCoordinator[] = [];
      const disposed = { count: 0 };
      const { engine, compositor } = stackWorld(attached, disposed);
      compositor.setPostProcess([pass("first")]);
      const layer = create(compositor, "hud");
      const view = layer.camera.outputRenderTarget!;
      const renderer = layerRenderer(compositor, "hud");
      compositor.setPostProcess([pass("first"), pass("second")]);
      // The layers keep drawing into the same target with the same renderers.
      expect(layer.camera.outputRenderTarget).toBe(view);
      expect(layerRenderer(compositor, "hud")).toBe(renderer);
      expect(attached).toHaveLength(2);
      expect(attached[1]).not.toBe(attached[0]);
      expect(disposed.count).toBe(1);
      const disposeView = vi.spyOn(view, "dispose");
      vi.spyOn(engine, "getRenderWidth").mockReturnValue(view.getSize().width + 16);
      compositor.render(new Set(), () => {});
      const resized = layer.camera.outputRenderTarget!;
      expect(resized).not.toBe(view);
      expect(resized.getSize().width).toBe(view.getSize().width + 16);
      expect(layerRenderer(compositor, "hud")).not.toBe(renderer);
      // The old view goes once the renderer that drew into it has released it, and the old target with its passes.
      await vi.waitFor(() => { expect(disposeView).toHaveBeenCalledOnce(); });
      await vi.waitFor(() => { expect(sharedTargets(engine)).toHaveLength(1); });
      compositor.setPostProcess([]);
      expect(layer.camera.outputRenderTarget).toBeNull();
      expect(disposed.count).toBe(3);
      await vi.waitFor(() => { expect(passScene(engine)).toBeNull(); });
      await compositor.dispose();
      expect(compositor.ownedScenes()).toEqual([]);
    });

    it("keeps live parameter writes for the shared stack's passes and refuses passes it does not hold", () => {
      const { engine } = world();
      const setParameter = vi.fn(() => true);
      const attach = vi.fn((...args: unknown[]) => { void args; return { dispose() {}, setParameter }; });
      const stacked = new SceneLayerCompositor({ engine, attachLayerPostProcess: attach });
      stacked.setPostProcess([{ id: "glow", materialGuid: "glow", enabled: true }, { id: "tint", materialGuid: "tint", enabled: false }]);
      const value = { kind: "float" as const, value: 0.5 };
      expect(stacked.setPostProcessParameter("glow", "glow", "Gain", value, () => true)).toBe(true);
      expect(setParameter).toHaveBeenCalledWith("glow", "Gain", value);
      expect(stacked.setPostProcessParameter("glow", "other-material", "Gain", value, () => true)).toBe(false);
      expect(stacked.setPostProcessParameter("missing", "glow", "Gain", value, () => true)).toBe(false);
      expect(stacked.setPostProcessParameter("glow", "glow", "Gain", value, () => false)).toBe(false);
      // A disabled pass keeps its write for when it is enabled again.
      expect(stacked.setPostProcessParameter("tint", "tint", "Amount", value, () => true)).toBe(true);
      stacked.setPostProcess([{ id: "glow", materialGuid: "glow", enabled: true }, { id: "tint", materialGuid: "tint", enabled: true }]);
      expect(attach.mock.calls.at(-1)![1]).toEqual([
        { id: "glow", materialGuid: "glow", enabled: true, parameters: { Gain: value } },
        { id: "tint", materialGuid: "tint", enabled: true, parameters: { Amount: value } },
      ]);
      void stacked.dispose();
    });

    it("keeps the removed layer's Scene and view until actual release confirms", async () => {
      const { compositor } = stackWorld();
      compositor.setPostProcess([pass("effect")]);
      const layer = create(compositor, "overlay");
      const target = layer.camera.outputRenderTarget!;
      const disposal = vi.spyOn(target, "dispose");
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const whenReleased = SceneRenderCoordinator.prototype.whenReleased;
      // Hold only the layer renderer's actual-release boundary; bounded cleanup still completes.
      vi.spyOn(SceneRenderCoordinator.prototype, "whenReleased").mockImplementation(function (this: SceneRenderCoordinator) {
        return sceneOf(this) === layer.scene ? held : whenReleased.call(this);
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
      const { compositor } = stackWorld();
      compositor.setPostProcess([pass("effect")]);
      const layer = create(compositor, "overlay");
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

    it("quarantines a removed layer's view and Scene when actual release never confirms", async () => {
      const { compositor } = stackWorld();
      compositor.setPostProcess([pass("effect")]);
      const layer = create(compositor, "overlay");
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

    it("shows the last composite while new passes or a new target prepare, without acknowledging it", async () => {
      const attached: SceneRenderCoordinator[] = [];
      const { engine, compositor } = stackWorld(attached);
      adaptNullEngineFrameGraph(engine);
      // NullEngine omits the raw upload-ready flag that a WebGL2 Engine sets.
      // Preserve actual texture ownership and the production readiness checks.
      const upload = engine.createRawTexture.bind(engine);
      vi.spyOn(engine, "createRawTexture").mockImplementation((...args) => {
        const texture = upload(...args); texture.isReady = true; return texture;
      });
      compositor.setPostProcess([pass("first")]);
      create(compositor, "overlay");
      await compositor.prepare("overlay", () => {});
      await vi.waitFor(() => { expect(compositor.isReady("overlay")).toBe(true); });
      let acknowledged = false;
      // The layer's first presentation, which its loading owner acknowledges.
      compositor.render(new Set(["overlay"]), (_id, draw) => { acknowledged = draw(); });
      expect(acknowledged).toBe(true);
      const blit = engine.scenes.find((scene) => scene.getMeshByName("sceneLayerBlitPlane"))!;
      const plane = blit.getMeshByName("sceneLayerBlitPlane")!;
      expect(plane.material!.needAlphaBlendingForMesh(plane)).toBe(true);
      const blitDraws = vi.spyOn(blit, "render");
      // New passes at the same size: their renderer prepares while the last composite shows again.
      compositor.setPostProcess([pass("second")]);
      vi.spyOn(attached[1]!, "render").mockReturnValue({ path: "frameGraph", reason: "Waiting for native upload.", rendered: false, readyForPresentation: false });
      compositor.render(new Set(), (_id, draw) => { acknowledged = draw(); });
      expect(acknowledged).toBe(false);
      expect(blitDraws).toHaveBeenCalledOnce();
      // A new size: a new target, and every layer's renderer follows it. The old composite stays until one presents.
      vi.spyOn(engine, "getRenderWidth").mockReturnValue(engine.getRenderWidth(true) + 16);
      compositor.render(new Set(["overlay"]), (_id, _draw, fallback) => { acknowledged = false; fallback(); });
      expect(acknowledged).toBe(false);
      expect(blitDraws).toHaveBeenCalledTimes(2);
      // The held output and the layer's Scene both belong to the compositor, so a leak check never takes them for editor Scenes.
      expect(compositor.ownedScenes()).toContain(blit);
      expect(blit.isDisposed).toBe(false);
      await compositor.prepare("overlay", () => {});
      await vi.waitFor(() => { expect(compositor.isReady("overlay")).toBe(true); });
      // A steady frame: while the last composite stands in, it validates, and releases the composite once it presents.
      compositor.render(new Set(), (_id, draw) => { acknowledged = draw(); });
      expect(acknowledged).toBe(true);
      await vi.waitFor(() => { expect(blit.isDisposed).toBe(true); });
      expect(blitDraws).toHaveBeenCalledTimes(2);
      expect(compositor.ownedScenes()).not.toContain(blit);
      await compositor.dispose();
      expect(compositor.ownedScenes()).toEqual([]);
    });

    it("follows a pass rebuild during preparation and resolves for a layer removed while it prepares", async () => {
      const attached: SceneRenderCoordinator[] = [];
      const { engine, compositor } = stackWorld(attached);
      adaptNullEngineFrameGraph(engine);
      compositor.setPostProcess([pass("first")]);
      create(compositor, "overlay");
      // A script's sceneLayerPostProcess replaces the passes' renderer the pending preparation awaits.
      const assertCurrent = () => {};
      const rebuilt = compositor.prepare("overlay", assertCurrent);
      compositor.setPostProcess([pass("second")]);
      const followed = vi.spyOn(attached[1]!, "prepare");
      await expect(rebuilt).resolves.toBeUndefined();
      // The caller's own preparation reached the replacement: the readiness probe's background preparation passes no `assertCurrent`.
      expect(followed).toHaveBeenCalledWith(assertCurrent);
      await vi.waitFor(() => { expect(compositor.isReady("overlay")).toBe(true); });
      const removed = compositor.prepare("overlay", () => {});
      compositor.remove("overlay");
      await expect(removed).resolves.toBeUndefined();
      await compositor.dispose();
    });

    it("keeps a layer's probes scoped to the changed visuals in the renderer the shared target gives it", async () => {
      const { compositor } = stackWorld();
      create(compositor, "overlay");
      const first = layerRenderer(compositor, "overlay");
      compositor.setPostProcess([pass("first")]);
      const second = layerRenderer(compositor, "overlay");
      expect(second).not.toBe(first);
      const scoped = (renderer: SceneRenderCoordinator) =>
        (renderer as unknown as { graph: { scopedStrictProbes: boolean } }).graph.scopedStrictProbes;
      expect([first, second].map(scoped)).toEqual([true, true]);
      await compositor.dispose();
    });

    it("stops following renderer replacements once the preparation ceiling has passed", async () => {
      const attached: SceneRenderCoordinator[] = [];
      const { engine, compositor } = stackWorld(attached);
      adaptNullEngineFrameGraph(engine);
      compositor.setPostProcess([pass("first")]);
      create(compositor, "overlay");
      const preparing = compositor.prepare("overlay", () => {});
      compositor.setPostProcess([pass("second")]);
      // Each replacement's coordinator starts fresh bounds. A script keeps replacing the passes faster than they prepare:
      // once preparation follows the first replacement, the ceiling passes and the passes are replaced again.
      const follow = attached[1]!.prepare.bind(attached[1]);
      const now = performance.now.bind(performance);
      vi.spyOn(attached[1]!, "prepare").mockImplementation((...args) => {
        const followed = follow(...args);
        vi.spyOn(performance, "now").mockImplementation(() => now() + SCENE_PREPARATION_CEILING_MS);
        compositor.setPostProcess([pass("third")]);
        return followed;
      });
      await expect(preparing).rejects.toBeInstanceOf(PreparationTimedOut);
      await compositor.dispose();
    });
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

  it("maps the pointer through pick space when Resolution Scale raises the hardware scaling level", () => {
    const { engine, compositor } = world();
    // A 128 px drawing buffer at level 2 is picked like a 256 px canvas.
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(128);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(128);
    vi.spyOn(engine, "getHardwareScalingLevel").mockReturnValue(2);
    const layer = compositor.create({
      type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud-asset", zOrder: 0,
      ownerSceneGuid: null, canvas: layerCanvas(9, 9),
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
        ownerSceneGuid: null, canvas: layerCanvas(9, 9),
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
      canvas: layerCanvas(32, 18),
    });
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "pause",
      assetGuid: "pause-asset",
      zOrder: 1,
      ownerSceneGuid: null,
      canvas: layerCanvas(32, 18),
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
      canvas: layerCanvas(32, 18),
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
      canvas: layerCanvas(32, 18),
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
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud", zOrder: 0, ownerSceneGuid: null, canvas: layerCanvas(32, 18) });
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

  /**
   * The meshes one compositor frame handed its layer's draw batcher, by name in draw order: what Babylon's passes, or
   * the layer's retained draw list, put in its sorted lists.
   */
  function dispatched(engine: NullEngine, compositor: SceneLayerCompositor): string[] {
    const meshes: string[] = [];
    const batcher = sceneDrawBatcher(compositor.layers()[0]!.scene)!;
    const draw = batcher.draw;
    batcher.draw = (sorted, count, transparent, drawOne) => {
      for (let index = 0; index < count; index += 1) meshes.push(sorted[index]!.getMesh().name);
      draw.call(batcher, sorted, count, transparent, drawOne);
    };
    try {
      engine.beginFrame();
      compositor.render();
      engine.endFrame();
    } finally {
      batcher.draw = draw;
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
    expect(hud.compositor.diagnostics()[0]!.drawList).toMatchObject({ fallbackFrames: 0, heals: 0, mismatches: 0 });
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
      canvas: layerCanvas(32, 18),
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

  describe("a frame's layer work", () => {
    /**
     * A NullEngine that runs the real graph and binds framebuffers as a WebGL Engine does: every bind goes through
     * `_bindUnboundFramebuffer`, each target its own framebuffer, and binding a target never unbinds the last one first.
     */
    function webGlBinding(): NullEngine {
      const engine = adaptNullEngineFrameGraph(new NullEngine({
        renderWidth: 640, renderHeight: 360, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1,
      }));
      engines.push(engine);
      const binding = engine as unknown as { _currentFramebuffer: unknown; _bindUnboundFramebuffer(framebuffer: unknown): void };
      binding._bindUnboundFramebuffer = (framebuffer) => { binding._currentFramebuffer = framebuffer; };
      const framebuffers = new WeakMap<object, object>();
      const framebufferOf = (wrapper: object) => {
        let framebuffer = framebuffers.get(wrapper);
        if (!framebuffer) framebuffers.set(wrapper, framebuffer = {});
        return framebuffer;
      };
      const bind = engine.bindFramebuffer.bind(engine);
      engine.bindFramebuffer = (wrapper, ...rest) => {
        const current = binding._currentFramebuffer;
        engine._currentRenderTarget = null;
        bind(wrapper, ...rest);
        binding._currentFramebuffer = current;
        binding._bindUnboundFramebuffer(framebufferOf(wrapper));
      };
      const unbind = engine.unBindFramebuffer.bind(engine);
      engine.unBindFramebuffer = (wrapper, ...rest) => {
        const current = binding._currentFramebuffer;
        unbind(wrapper, ...rest);
        binding._currentFramebuffer = current;
        binding._bindUnboundFramebuffer(null);
      };
      return engine;
    }

    /** Prepared layers of one quad each over the world, by id and z-order. */
    async function layersOver(engine: NullEngine, compositor: SceneLayerCompositor, ids: string[]) {
      const views = ids.map((layerId, zOrder) => {
        const view = compositor.create({ type: "sceneLayerCreate", layerId, assetGuid: layerId, zOrder, ownerSceneGuid: null, canvas: layerCanvas(32, 18) });
        applyOverlayUnlitMaterial(MeshBuilder.CreatePlane(`${layerId}-quad`, { size: 1 }, view.scene));
        return view;
      });
      for (const layerId of ids) await compositor.prepare(layerId, () => {});
      return views;
    }

    function frame(engine: NullEngine, compositor: SceneLayerCompositor, world: () => void = () => {}) {
      engine.beginFrame();
      compositor.beforeWorld();
      world();
      compositor.render();
      engine.endFrame();
      return copyLayerFrameStats(compositor.frameStats);
    }

    /**
     * Gives `engine` a WebGL context that does nothing, and clears and draws that reach it as a WebGL Engine's do: the
     * Engine's states applied first, then the GL calls. The depth-stencil clears that reached it, by target.
     */
    function webGlCalls(engine: NullEngine): { depthClears: string[]; draws: () => number } {
      const reached: string[] = [];
      let bound: unknown = null;
      const gl = new Proxy({} as Record<string, unknown>, {
        get: (target, name) => {
          if (name in target) return target[name as string];
          // The constants Babylon's states read off the context.
          const constant = ({ DEPTH_TEST: 0x0b71, STENCIL_TEST: 0x0b90, SCISSOR_TEST: 0x0c11, CULL_FACE: 0x0b44, BLEND: 0x0be2,
            FRAMEBUFFER: 0x8d40, DRAW_FRAMEBUFFER: 0x8ca9 } as Record<string, number>)[name as string];
          if (constant !== undefined) return constant;
          if (typeof name === "string" && /^[A-Z0-9_]+$/.test(name)) return 0;
          if (name === "getParameter") return (parameter: number) =>
            parameter === 0x0b72 ? true : parameter === 0x0b98 || parameter === 0x8ca5 ? 0xff : parameter === 0x0b73 ? 1 : parameter === 0x0b91 ? 0 : null;
          if (name === "isEnabled") return () => false;
          if (name === "bindFramebuffer") return (_target: number, framebuffer: unknown) => { bound = framebuffer; };
          if (name === "clear") return (mask: number) => { if (mask & 0x500) reached.push(bound ? "target" : "backbuffer"); };
          return () => {};
        },
      });
      Object.defineProperty(engine, "_gl", { value: gl, configurable: true, writable: true });
      const binding = engine as unknown as { _bindUnboundFramebuffer(framebuffer: unknown): void; _currentFramebuffer: unknown };
      const bind = binding._bindUnboundFramebuffer;
      binding._bindUnboundFramebuffer = (framebuffer) => {
        if (binding._currentFramebuffer !== framebuffer) (engine as unknown as { _gl: { bindFramebuffer(target: number, framebuffer: unknown): void } })._gl.bindFramebuffer(0x8d40, framebuffer);
        bind(framebuffer);
      };
      const glOf = () => (engine as unknown as { _gl: Record<string, (...args: unknown[]) => void> })._gl;
      const clear = (color: unknown, backBuffer: boolean, depth: boolean, stencil = false, stencilClearValue = 0) => {
        engine.applyStates();
        glOf().clearDepth!(1);
        glOf().clearStencil!(stencilClearValue);
        glOf().clear!((color && backBuffer ? 0x4000 : 0) | (depth ? 0x100 : 0) | (stencil ? 0x400 : 0));
      };
      engine.clear = clear;
      // As a WebGL Engine's: through the Engine's own clear (so the layer counters see it once).
      engine.clearAttachments = (color, _attachments, clearColor, clearDepth, clearStencil, stencilClearValue) =>
        (engine.clear as typeof clear)(color, clearColor, clearDepth, clearStencil, stencilClearValue);
      let draws = 0;
      engine.drawElementsType = () => { engine.applyStates(); draws += 1; glOf().drawElements!(); };
      // The Engine's next state changes all reach the context, as on a fresh WebGL Engine.
      engine.wipeCaches(true);
      return { depthClears: reached, draws: () => draws };
    }

    it("leaves out a layer's depth-stencil clear the backbuffer already holds, with the same draws, while skipped clears are on", async () => {
      const engine = webGlBinding();
      const { depthClears, draws } = webGlCalls(engine);
      const compositor = new SceneLayerCompositor({ engine });
      await layersOver(engine, compositor, ["hud", "menu", "toast"]);
      // The world's clear of colour, depth and stencil (as its output pass folds them in, or a loading frame clears).
      const world = () => engine.clear(new Color4(0, 0, 0, 1), true, true, true);
      frame(engine, compositor, world);
      depthClears.length = 0;
      const drawn = draws();
      const skipped = frame(engine, compositor, world);
      expect(draws() - drawn).toBe(3);
      // The first layer finds the world's clear; each layer's quad writes depth, so the next two clear.
      expect(skipped).toMatchObject({ scenes: 3, depthClears: 3, backbuffer: { depthClears: 3, elided: 1 } });
      expect(depthClears).toEqual(["backbuffer", "backbuffer", "backbuffer"]);
      compositor.skipClears = false;
      depthClears.length = 0;
      const every = frame(engine, compositor, world);
      expect(every).toMatchObject({ scenes: 3, depthClears: 3, backbuffer: { depthClears: 4, elided: 0 } });
      expect(depthClears).toHaveLength(4);
      // The same draws either way.
      expect(skipped.scenes).toBe(every.scenes);
      // A layer whose draws write no depth leaves the next layer's clear out too.
      compositor.skipClears = true;
      for (const mesh of compositor.layers()[1]!.scene.meshes) if (mesh.material) mesh.material.disableDepthWrite = true;
      expect(frame(engine, compositor, world).backbuffer).toEqual({ clears: 2, depthClears: 2, elided: 2 });
      // A world that clears only colour (its output pass outside a frame that folds) leaves the first layer's clear in.
      expect(frame(engine, compositor, () => engine.clear(new Color4(0, 0, 0, 1), true, false, false)).backbuffer.elided).toBe(1);
      await compositor.dispose();
    });

    it("follows the Engine's draws only during its layer pass, a pass that throws included", async () => {
      const engine = webGlBinding();
      const draw = engine.drawElementsType;
      const compositor = new SceneLayerCompositor({ engine });
      await layersOver(engine, compositor, ["hud"]);
      const during: unknown[] = [];
      const render = vi.spyOn(SceneRenderCoordinator.prototype, "render").mockImplementation(() => {
        during.push(engine.drawElementsType);
        throw new Error("layer failed");
      });
      expect(() => frame(engine, compositor)).toThrow("layer failed");
      render.mockRestore();
      expect(during[0]).not.toBe(draw);
      // The world frame's draws are the Engine's own.
      expect(engine.drawElementsType).toBe(draw);
      engine.endFrame();
      await compositor.dispose();
    });

    it("skips no clear while the shared stack has a pass or the clears are off", async () => {
      const engine = webGlBinding();
      const { depthClears } = webGlCalls(engine);
      const compositor = new SceneLayerCompositor({ engine, attachLayerPostProcess: () => ({ dispose: () => {} }) });
      compositor.setPostProcess([{ id: "glow", materialGuid: "glow", enabled: true }]);
      await layersOver(engine, compositor, ["hud", "menu"]);
      const world = () => engine.clear(new Color4(0, 0, 0, 1), true, true, true);
      frame(engine, compositor, world);
      depthClears.length = 0;
      expect(frame(engine, compositor, world).backbuffer.elided).toBe(0);
      compositor.setPostProcess([]);
      compositor.depthClears = false;
      await compositor.prepare("hud", () => {});
      await compositor.prepare("menu", () => {});
      frame(engine, compositor, world);
      expect(frame(engine, compositor, world).backbuffer).toMatchObject({ depthClears: 1, elided: 0 });
      await compositor.dispose();
    });

    it("counts each layer Scene rendered over the world and its depth-stencil clear, with no framebuffer change", async () => {
      const engine = webGlBinding();
      const compositor = new SceneLayerCompositor({ engine });
      await layersOver(engine, compositor, ["hud", "menu", "toast"]);
      frame(engine, compositor);
      const stats = frame(engine, compositor);
      expect(stats).toMatchObject({ scenes: 3, clears: 3, depthClears: 3, targetSwitches: 0, uploads: 0, beforeWorld: { uploads: 0, targetSwitches: 0 } });
      // The batched passes are part of the layer pass's time.
      expect(stats.batchMs).toBeGreaterThan(0);
      expect(stats.batchMs).toBeLessThanOrEqual(stats.ms);
      // A clear the world issues is not the layers'.
      const world = frame(engine, compositor, () => engine.clear(new Color4(0, 0, 0, 1), false, true, true));
      expect(world).toMatchObject({ clears: 3, depthClears: 3 });
      await compositor.dispose();
    });

    it("draws every layer into the shared target and back while the stack has a pass", async () => {
      const engine = webGlBinding();
      const compositor = new SceneLayerCompositor({ engine, attachLayerPostProcess: () => ({ dispose: () => {} }) });
      compositor.setPostProcess([{ id: "glow", materialGuid: "glow", enabled: true }]);
      await layersOver(engine, compositor, ["hud", "menu"]);
      frame(engine, compositor);
      const stats = frame(engine, compositor);
      // Two layer Scenes into the shared target; the passes' Scene, and the blit over the world, are not layer Scenes.
      expect(stats.scenes).toBe(2);
      expect(stats.targetSwitches).toBeGreaterThanOrEqual(2);
      expect(stats.beforeWorld).toMatchObject({ uploads: 0, targetSwitches: 0 });
      await compositor.dispose();
    });

    it("uploads a layer's written glyph pages before the world draws, with the pixels its draws then sample", async () => {
      const engine = webGlBinding();
      const compositor = new SceneLayerCompositor({ engine });
      const [hud] = await layersOver(engine, compositor, ["hud", "menu"]);
      frame(engine, compositor);
      const glyph = (value: number) => ({ key: `glyph ${value}`, width: 4, height: 4, pixels: new Uint8ClampedArray(64).fill(value) });
      const written = sceneGlyphAtlas(hud!.scene, false).acquire(glyph(200));
      const order: string[] = [];
      const update = vi.spyOn(written.page.texture, "update").mockImplementation(function (this: RawTexture, pixels) {
        order.push(`upload ${(pixels as Uint8Array).filter((value) => value === 200).length}`);
      });
      hud!.scene.onBeforeRenderObservable.add(() => order.push("hud renders"));
      const stats = frame(engine, compositor, () => order.push("world"));
      // Before the world, once: the layer's own before-render work finds the page uploaded.
      expect(order).toEqual(["upload 64", "world", "hud renders"]);
      expect(stats.beforeWorld.uploads).toBe(1);
      expect(stats.uploads).toBe(0);
      // A page written while the layer renders (a text built by its observers) still uploads before its draws.
      hud!.scene.onBeforeRenderObservable.add(() => { sceneGlyphAtlas(hud!.scene, false).acquire(glyph(90)); }, undefined, true);
      order.length = 0;
      const late = frame(engine, compositor, () => order.push("world"));
      expect(order).toEqual(["world", "upload 64", "hud renders"]);
      expect(late).toMatchObject({ uploads: 1, beforeWorld: { uploads: 0 } });
      update.mockRestore();
      await compositor.dispose();
    });

    it("copies the images a layer's shared page was asked for before the world draws, and none again in its frame", async () => {
      const engine = webGlBinding();
      const compositor = new SceneLayerCompositor({ engine, isLayerReady: (layerId) => layerId !== "waiting" });
      await layersOver(engine, compositor, ["hud", "waiting"]);
      frame(engine, compositor);
      const flushed: string[] = [];
      const flush = vi.spyOn(LayerImageAtlas.prototype, "flush").mockImplementation(function (this: LayerImageAtlas) {
        const scene = (this as unknown as { scene: Scene }).scene;
        flushed.push(compositor.layers().find((view) => view.scene === scene)?.layerId ?? "another Scene");
      });
      frame(engine, compositor, () => flushed.push("world"));
      // The drawn layer's page before the world, then its before-render work's (which finds nothing); the waiting one's never.
      expect(flushed).toEqual(["hud", "world", "hud"]);
      flush.mockRestore();
      await compositor.dispose();
    });
  });
});
