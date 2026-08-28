import { describe, expect, it } from "vitest";
import { ClassRegistry } from "./class-registry";
import {
  SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS,
  isSceneLayerAllowedComponent,
} from "./ids";
import { SceneLayer } from "./objects";
import { World } from "./world";

describe("SceneLayer object model", () => {
  it("stores overlay instances on the World and tags their actors", () => {
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
    });
    const layer = world.createSceneLayer({
      assetGuid: "hud",
      zOrder: 3,
      ownerSceneGuid: "level-1",
      layerBounds: { width: 20, height: 10 },
    });
    expect(layer).toBeInstanceOf(SceneLayer);
    expect(layer.classId).toBe("SceneLayer");
    expect(layer.assetGuid).toBe("hud");
    expect(layer.zOrder).toBe(3);
    expect(layer.ownerSceneGuid).toBe("level-1");
    expect(layer.layerBounds).toEqual({ width: 20, height: 10 });
    expect(world.getSceneLayers()).toEqual([layer]);

    const defaultBounds = world.createSceneLayer({
      assetGuid: "fallback",
      zOrder: 0,
    });
    expect(defaultBounds.layerBounds).toEqual({ width: 32, height: 18 });

    const actor = world.createActor({
      classId: "SceneLayerActor",
      sceneLayerId: layer.guid,
    });
    expect(actor.sceneLayerId).toBe(layer.guid);
    world.spawnActorNow(actor);
    expect(world.getActors()).toHaveLength(1);
  });

  it("allows sprites and 2D physics components but not skybox, camera, or light", () => {
    expect(isSceneLayerAllowedComponent("SpriteComponent")).toBe(true);
    expect(isSceneLayerAllowedComponent("RigidBodyComponent")).toBe(true);
    expect(isSceneLayerAllowedComponent("ColliderComponent")).toBe(true);
    expect(isSceneLayerAllowedComponent("2DButtonComponent")).toBe(true);
    expect(isSceneLayerAllowedComponent("SkyboxComponent")).toBe(false);
    expect(isSceneLayerAllowedComponent("CameraComponent")).toBe(false);
    expect(isSceneLayerAllowedComponent("LightComponent")).toBe(false);
    expect(isSceneLayerAllowedComponent("HemisphericFillLightComponent")).toBe(
      false,
    );
    expect([...SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS]).toEqual([
      "2DAnchorComponent",
      "2DButtonComponent",
      "2DMaterialComponent",
      "2DTextureComponent",
      "2DTextComponent",
      "2DRichTextComponent",
      "2DPanelComponent",
    ]);
  });

  it("destroys a SceneLayer instance without requiring it to be an Actor", () => {
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
    });
    const layer = world.createSceneLayer({ assetGuid: "hud", zOrder: 0 });
    world.destroySceneLayer(layer.guid);
    expect(world.getSceneLayers()).toEqual([]);
  });
});
