import { Camera, Constants, InternalTexture, InternalTextureSource, MeshBuilder, Matrix, NullEngine, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { SceneRenderCoordinator } from "./scene-render-coordinator";

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

  it("sizes the HUD ortho to the orange layerBounds, not a height-9 aspect box", () => {
    const { engine, compositor } = world();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(1920);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(1080);
    compositor.create({
      type: "sceneLayerCreate",
      layerId: "hud",
      assetGuid: "hud-asset",
      zOrder: 0,
      ownerSceneGuid: null,
      postProcessStack: [],
    });
    const camera = compositor.layers()[0]!.camera;
    expect(camera.orthoLeft).toBeCloseTo(-16);
    expect(camera.orthoRight).toBeCloseTo(16);
    expect(camera.orthoTop).toBeCloseTo(9);
    expect(camera.orthoBottom).toBeCloseTo(-9);

    compositor.create({
      type: "sceneLayerCreate",
      layerId: "wide",
      assetGuid: "wide-asset",
      zOrder: 1,
      ownerSceneGuid: null,
      postProcessStack: [],
      layerBounds: { width: 20, height: 10 },
    });
    const wide = compositor.layers().find((layer) => layer.layerId === "wide")!;
    expect(wide.camera.orthoLeft).toBeCloseTo(-10);
    expect(wide.camera.orthoRight).toBeCloseTo(10);
    expect(wide.camera.orthoTop).toBeCloseTo(5);
    expect(wide.camera.orthoBottom).toBeCloseTo(-5);
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

  it("replaces layer targets with owned sampleable depth and waits for every retired graph before Scene disposal", async () => {
    const { engine } = world();
    engine.getCaps().depthTextureExtension = true;
    // NullEngine has no native depth attachment driver. Keep the real RTT owner
    // and complete only that boundary, as in the shadow allocation fixtures.
    vi.spyOn(engine, "createDepthStencilTexture").mockImplementation((size, options) => {
      const texture = new InternalTexture(engine, InternalTextureSource.DepthStencil);
      const dimensions = typeof size === "number" ? { width: size, height: size } : size;
      texture.width = texture.baseWidth = dimensions.width;
      texture.height = texture.baseHeight = dimensions.height;
      texture.format = options.depthTextureFormat ?? Constants.TEXTUREFORMAT_DEPTH24;
      texture.isReady = true;
      engine.getLoadedTexturesCache().push(texture);
      return texture;
    });
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
    expect(first.depthStencilTexture?.format).toBe(Constants.TEXTUREFORMAT_DEPTH24);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const retire = SceneRenderCoordinator.prototype.retire;
    // Preserve native cancellation/disposal, holding only completion of one owner.
    vi.spyOn(SceneRenderCoordinator.prototype, "retire").mockImplementation(function () {
      const retired = retire.call(this);
      return this === renderers[0] ? retired.then(() => held) : retired;
    });
    const disposeFirst = vi.spyOn(first, "dispose");
    const draw = vi.spyOn(layer.scene, "render");
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(first.getSize().width + 16);
    compositor.resize();
    const next = layer.camera.outputRenderTarget!;
    expect(next).not.toBe(first);
    expect(next.depthStencilTexture).not.toBe(first.depthStencilTexture);
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

  it("quarantines a removed layer's target and Scene when graph cleanup is uncertain", async () => {
    const { engine } = world();
    const compositor = new SceneLayerCompositor({ engine });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: [{ materialGuid: "effect", enabled: true }] });
    const target = layer.camera.outputRenderTarget!;
    const disposal = vi.spyOn(target, "dispose");
    const retire = SceneRenderCoordinator.prototype.retire;
    vi.spyOn(SceneRenderCoordinator.prototype, "retire").mockImplementation(async function () {
      await retire.call(this);
      throw new Error("Native task cleanup failed.");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    compositor.remove("overlay");
    await expect(compositor.dispose()).rejects.toThrow(/retirement failed/);
    expect(compositor.layers()).toEqual([]);
    expect(layer.scene.isDisposed).toBe(false);
    expect(disposal).not.toHaveBeenCalled();
  });

  it("keeps only the last presented layer image while replacement graphs prepare without acknowledging it", async () => {
    const { engine } = world();
    const renderers: SceneRenderCoordinator[] = [];
    const compositor = new SceneLayerCompositor({ engine, attachLayerPostProcess: (_layer, _stack, renderer) => {
      renderers.push(renderer); return { dispose() {} };
    } });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "overlay", assetGuid: "overlay", zOrder: 0, ownerSceneGuid: null, postProcessStack: [{ materialGuid: "first", enabled: true }] });
    await compositor.prepare("overlay", () => {});
    let acknowledged = false;
    compositor.render(new Set(), (_id, draw) => { acknowledged = draw(); });
    expect(acknowledged).toBe(true);
    const first = layer.camera.outputRenderTarget!;
    const oldBlit = engine.scenes.find((scene) => scene.getMaterialByName("sceneLayerBlit:overlay"))!;
    const disposeFirst = vi.spyOn(first, "dispose");
    const fallbackDraw = vi.spyOn(oldBlit, "render");
    compositor.setPostProcess("overlay", [{ materialGuid: "second", enabled: true }]);
    const unrendered = layer.camera.outputRenderTarget!;
    const disposeUnrendered = vi.spyOn(unrendered, "dispose");
    vi.spyOn(renderers[1]!, "render").mockReturnValue({ path: "classic", reason: "Waiting for native upload.", rendered: false, readyForPresentation: false });
    compositor.render(new Set(), (_id, draw) => { acknowledged = draw(); });
    expect(acknowledged).toBe(false);
    expect(fallbackDraw).toHaveBeenCalledOnce();
    expect(disposeFirst).not.toHaveBeenCalled();
    compositor.setPostProcess("overlay", [{ materialGuid: "third", enabled: true }]);
    await vi.waitFor(() => { expect(disposeUnrendered).toHaveBeenCalledOnce(); });
    expect(disposeFirst).not.toHaveBeenCalled();
    await compositor.prepare("overlay", () => {});
    compositor.render(new Set(), (_id, draw) => { acknowledged = draw(); });
    expect(acknowledged).toBe(true);
    await vi.waitFor(() => { expect(disposeFirst).toHaveBeenCalledOnce(); });
    expect(fallbackDraw).toHaveBeenCalledOnce();
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
      layerBounds: { width: 9, height: 9 },
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
});
