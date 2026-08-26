import { Camera, NullEngine, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
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
});
