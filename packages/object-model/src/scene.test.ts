import { describe, expect, it } from "vitest";
import { ClassRegistry } from "./class-registry";
import { sceneAssetClassId } from "./ids";
import { Scene } from "./objects";
import { World } from "./world";

describe("Scene object model", () => {
  it("creates a live Scene instance with SceneName and a typed class id", () => {
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
    });
    const scene = world.createScene({
      assetGuid: "scene-1",
      sceneName: "Main",
    });
    expect(scene).toBeInstanceOf(Scene);
    expect(scene.classId).toBe(sceneAssetClassId("scene-1"));
    expect(scene.assetGuid).toBe("scene-1");
    expect(scene.getVariable("sceneName")).toBe("Main");
    expect(world.currentScene).toBe(scene);
  });

  it("invalidates the previous Scene when a new one becomes current", () => {
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
    });
    const first = world.createScene({
      assetGuid: "scene-1",
      sceneName: "Main",
    });
    const second = world.createScene({
      assetGuid: "scene-2",
      sceneName: "Level 2",
    });
    expect(first.destroyed).toBe(true);
    expect(world.currentScene).toBe(second);
    expect(world.currentScene?.destroyed).toBe(false);
  });
});

describe("sceneAssetClassId", () => {
  it("prefixes the asset guid so Scene types do not collide with Class stems", () => {
    expect(sceneAssetClassId("abc")).toBe("Scene:abc");
  });
});
