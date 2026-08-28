import { Camera, MeshBuilder, Matrix, NullEngine, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SceneLayerCompositor } from "./scene-layer-compositor";

describe("SceneLayerCompositor", () => {
  const engines: NullEngine[] = [];

  afterEach(() => {
    while (engines.length > 0) {
      engines.pop()?.dispose();
    }
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
