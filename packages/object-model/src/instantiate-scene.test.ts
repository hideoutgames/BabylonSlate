import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultSceneSettings,
  createMeshComponent,
} from "@babylonslate/core";
import { ClassRegistry } from "./class-registry";
import { createActorsFromSerializedScene } from "./instantiate-scene";
import { World } from "./world";

function testWorld() {
  return new World({
    seed: 1,
    dt: 1 / 60,
    classRegistry: new ClassRegistry(),
  });
}

describe("createActorsFromSerializedScene", () => {
  it("builds unspawned actors with serialized ids, transforms, and components", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "Level",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      actors: [
        createActor("actor-cube", "Cube", {
          transform: {
            position: [1, 2, 3],
            rotation: [0, 0, 0, 1],
            scale: [2, 2, 2],
          },
          components: [
            createMeshComponent("mesh-1", "sphere"),
            {
              id: "rb-1",
              classId: "RigidBodyComponent",
              properties: { motionType: "dynamic", mass: 4 },
            },
          ],
        }),
      ],
    });

    expect(world.getActors()).toHaveLength(0);
    expect(actors).toHaveLength(1);
    const actor = actors[0]!;
    expect(actor.guid).toBe("actor-cube");
    expect(actor.classId).toBe("Actor");
    expect(actor.getVariable("name")).toBe("Cube");
    expect(actor.transform.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(actor.transform.scale).toEqual({ x: 2, y: 2, z: 2 });
    expect(actor.components.map((c) => c.classId)).toEqual([
      "MeshComponent",
      "RigidBodyComponent",
    ]);
    expect(actor.components[0]!.guid).toBe("mesh-1");
    expect(actor.components[0]!.getVariable("meshKind")).toBe("sphere");
    expect(actor.components[1]!.getVariable("mass")).toBe(4);
  });

  it("copies graphGuid onto AnimationGraphComponent assetGuid", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "Anim",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      actors: [
        createActor("hero", "Hero", {
          components: [
            {
              id: "anim-1",
              classId: "AnimationGraphComponent",
              properties: { graphGuid: "graph-guid" },
            },
          ],
        }),
      ],
    });
    expect(actors[0]!.components[0]!.assetGuid).toBe("graph-guid");
  });

  it("copies treeGuid onto BehaviourTreeComponent assetGuid", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "AI",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      actors: [
        createActor("guard", "Guard", {
          components: [
            {
              id: "bt-1",
              classId: "BehaviourTreeComponent",
              properties: { treeGuid: "tree-guid", blackboardGuid: "bb-guid" },
            },
          ],
        }),
      ],
    });
    expect(actors[0]!.components[0]!.assetGuid).toBe("tree-guid");
    expect(actors[0]!.components[0]!.getVariable("blackboardGuid")).toBe("bb-guid");
  });
});
