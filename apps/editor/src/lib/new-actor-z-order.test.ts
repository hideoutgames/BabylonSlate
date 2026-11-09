import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  sceneLayerToEditorScene,
  createDefaultSceneLayer,
  type SerializedActor,
  type SerializedScene,
} from "@haptic/core";
import { addNewSceneActors, droppedCopyPosition } from "./new-actor-z-order";

type Vec3 = [number, number, number];

function actor(id: string, position: Vec3, options: { classId?: string; parentId?: string } = {}): SerializedActor {
  return {
    ...createActor(id, id),
    parentId: options.parentId ?? null,
    transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: options.classId ? [{ id: `${id}-c`, classId: options.classId, properties: {} }] : [],
  };
}

const flat = (actors: SerializedActor[] = []): SerializedScene => ({ ...createDefaultScene("2d"), actors });
const layer = (actors: SerializedActor[] = []): SerializedScene => ({
  ...sceneLayerToEditorScene(createDefaultSceneLayer()),
  actors,
});
const depths = (scene: SerializedScene, ids: string[]) =>
  ids.map((id) => scene.actors.find((entry) => entry.id === id)!.transform.position);

describe("addNewSceneActors", () => {
  it("adds actors unchanged in a 3D Scene, whatever the setting", () => {
    const scene = { ...createDefaultScene("3d"), actors: [] };
    const next = addNewSceneActors(scene, [actor("a", [1, 2, 3])], { copies: false, stack: "both" });
    expect(depths(next, ["a"])).toEqual([[1, 2, 3]]);
  });

  it("puts placed actors at Z-Order 0 and keeps copies' Z in 2D Scenes and Scene Layers without stacking", () => {
    for (const host of [flat(), layer()]) {
      const placed = addNewSceneActors(host, [actor("a", [1, 2, -4])], { copies: false, stack: "disabled" });
      expect(depths(placed, ["a"])).toEqual([[1, 2, 0]]);
      const copied = addNewSceneActors(host, [actor("a", [1, 2, -4])], { copies: true, stack: "disabled" });
      expect(depths(copied, ["a"])).toEqual([[1, 2, -4]]);
    }
  });

  it("stacks above the highest actor that draws, ignoring Cameras and lights", () => {
    const scene = flat([
      actor("sprite", [0, 0, -2], { classId: "SpriteComponent" }),
      actor("root", [0, 0, -1]),
      // World Z-Order 4: the child's -3 under its parent's -1.
      actor("mesh", [0, 0, -3], { classId: "MeshComponent", parentId: "root" }),
      actor("cam", [0, 0, -10], { classId: "CameraComponent" }),
      actor("light", [0, 0, -20], { classId: "Light2DComponent" }),
    ]);
    const next = addNewSceneActors(scene, [
      actor("a", [5, 6, 0]),
      actor("a-child", [0, 0, -0.5], { parentId: "a" }),
      actor("under-root", [0, 0, 0], { parentId: "root" }),
      actor("cam-copy", [0, 0, -10], { classId: "CameraComponent" }),
    ], { copies: true, stack: "scenes" });
    // a: Z-Order 5. under-root: world Z-Order 6, so local -5 under root's -1. The child and the Camera keep their Z.
    expect(depths(next, ["a", "a-child", "under-root", "cam-copy"])).toEqual([
      [5, 6, -5], [0, 0, -0.5], [0, 0, -5], [0, 0, -10],
    ]);
  });

  it("starts stacking at Z-Order 0 when nothing draws, and only on the hosts the setting names", () => {
    const placed = addNewSceneActors(flat(), [actor("a", [0, 0, 0]), actor("b", [0, 0, 0])], { copies: false, stack: "both" });
    expect(depths(placed, ["a", "b"])).toEqual([[0, 0, 0], [0, 0, -1]]);
    const drawn = [actor("panel", [0, 0, -3], { classId: "2DPanelComponent" })];
    const copy = [actor("c", [0, 0, -1])];
    expect(depths(addNewSceneActors(layer(drawn), copy, { copies: true, stack: "sceneLayers" }), ["c"])).toEqual([[0, 0, -4]]);
    expect(depths(addNewSceneActors(layer(drawn), copy, { copies: true, stack: "scenes" }), ["c"])).toEqual([[0, 0, -1]]);
    expect(depths(addNewSceneActors(flat(drawn), copy, { copies: true, stack: "sceneLayers" }), ["c"])).toEqual([[0, 0, -1]]);
  });
});

describe("droppedCopyPosition", () => {
  it("keeps the source's world depth in 2D and uses the drop point whole in 3D", () => {
    const actors = [actor("root", [0, 0, -1]), actor("child", [3, 3, -2], { parentId: "root" })];
    expect(droppedCopyPosition(flat(actors), actors[1]!, [7, 8, 0])).toEqual([7, 8, -3]);
    expect(droppedCopyPosition({ ...createDefaultScene("3d"), actors }, actors[1]!, [7, 8, 9])).toEqual([7, 8, 9]);
  });
});
