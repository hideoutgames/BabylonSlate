import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createDefaultSceneSettings,
  createMeshComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { ClassRegistry } from "./class-registry";
import { createActorsFromSerializedScene, createActorsFromSerializedSceneLayer } from "./instantiate-scene";
import { World } from "./world";

function testWorld() {
  return new World({
    seed: 1,
    dt: 1 / 60,
    classRegistry: new ClassRegistry(),
  });
}

describe("outliner folders", () => {
  it("never spawns a folder as a runtime actor", () => {
    const world = testWorld();
    const scene: SerializedScene = {
      ...createDefaultScene(),
      folders: [{ id: "folder-1", name: "Lighting", parentFolderId: null }],
      actors: [
        { ...createActor("grouped", "Grouped"), folderId: "folder-1" },
        createActor("loose", "Loose"),
      ],
    };
    const actors = createActorsFromSerializedScene(world, scene);
    expect(actors.map((actor) => actor.guid)).toEqual(["grouped", "loose"]);
  });
});

describe("createActorsFromSerializedSceneLayer", () => {
  it("tags overlay actors with the live SceneLayer id", () => {
    const world = testWorld();
    const layer = world.createSceneLayer({ assetGuid: "hud", zOrder: 1 });
    const actors = createActorsFromSerializedSceneLayer(
      world,
      {
        name: "HUD",
        settings: {
          gravity: [0, -9.81, 0],
          fixedTimestepMs: 16.6667,
          postProcessStack: [],
        },
        folders: [],
        actors: [
          createActor("banner", "Banner", {
            classId: "SceneLayerActor",
            components: [
              {
                id: "tex",
                classId: "2DTextureComponent",
                properties: { textureGuid: "albedo-1" },
              },
            ],
          }),
        ],
      },
      layer.guid,
    );
    expect(actors).toHaveLength(1);
    expect(actors[0]?.classId).toBe("SceneLayerActor");
    expect(actors[0]?.sceneLayerId).toBe(layer.guid);
    expect(actors[0]?.components[0]?.assetGuid).toBe("albedo-1");
  });

  it("drops Skybox, Camera, and Light when instantiating overlay actors", () => {
    const world = testWorld();
    const layer = world.createSceneLayer({ assetGuid: "hud", zOrder: 0 });
    const actors = createActorsFromSerializedSceneLayer(
      world,
      {
        name: "HUD",
        settings: {
          gravity: [0, -9.81, 0],
          fixedTimestepMs: 16.6667,
          postProcessStack: [],
        },
        folders: [],
        actors: [
          createActor("banner", "Banner", {
            classId: "SceneLayerActor",
            components: [
              {
                id: "sprite",
                classId: "SpriteComponent",
                properties: {},
              },
              {
                id: "cam",
                classId: "CameraComponent",
                properties: {},
              },
              {
                id: "light",
                classId: "LightComponent",
                properties: {},
              },
              {
                id: "sky",
                classId: "SkyboxComponent",
                properties: {},
              },
            ],
          }),
        ],
      },
      layer.guid,
    );
    expect(actors[0]?.components.map((component) => component.classId)).toEqual([
      "SpriteComponent",
    ]);
  });
});

describe("createActorsFromSerializedScene", () => {
  it("builds unspawned actors with serialized ids, transforms, and components", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "Level",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
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
    expect(actor.components[0]!.transform.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(actor.components[1]!.getVariable("mass")).toBe(4);
  });

  it("copies serialized component transforms onto runtime components", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "Offset",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
      actors: [
        createActor("hero", "Hero", {
          components: [
            {
              ...createMeshComponent("mesh-1", "box"),
              transform: {
                position: [2, 0, 0],
                rotation: [0, 0, 0, 1],
                scale: [1, 1, 1],
              },
            },
          ],
        }),
      ],
    });
    expect(actors[0]!.components[0]!.transform.position).toEqual({
      x: 2,
      y: 0,
      z: 0,
    });
  });

  it("copies graphGuid onto AnimationGraphComponent assetGuid", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "Anim",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
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
      folders: [],
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

  it("copies audioAssetGuid onto AudioComponent assetGuid", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "Audio",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
      actors: [
        createActor("speaker", "Speaker", {
          components: [
            {
              id: "audio-1",
              classId: "AudioComponent",
              properties: { audioAssetGuid: "jump" },
            },
          ],
        }),
      ],
    });
    expect(actors[0]!.components[0]!.assetGuid).toBe("jump");
  });

  it("copies particleSystemGuid onto ParticleComponent assetGuid", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "Particles",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
      actors: [
        createActor("fx", "Fire", {
          components: [
            {
              id: "particle-1",
              classId: "ParticleComponent",
              properties: { particleSystemGuid: "fire" },
            },
          ],
        }),
      ],
    });
    expect(actors[0]!.components[0]!.assetGuid).toBe("fire");
  });

  it("copies fontAssetGuid onto Text3DComponent assetGuid", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "Text",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
      actors: [
        createActor("label", "3D Text", {
          components: [
            {
              id: "text-1",
              classId: "Text3DComponent",
              properties: { fontAssetGuid: "font-display" },
            },
          ],
        }),
      ],
    });
    expect(actors[0]!.components[0]!.assetGuid).toBe("font-display");
  });

  it("skips SceneLayerActor when realizing a world scene", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "Level",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
      actors: [
        createActor("hero", "Hero"),
        createActor("banner", "Banner", { classId: "SceneLayerActor" }),
      ],
    });
    expect(actors.map((actor) => actor.guid)).toEqual(["hero"]);
  });

  it("copies serialized component sourceId onto the live ActorComponent", () => {
    const world = testWorld();
    const actors = createActorsFromSerializedScene(world, {
      name: "Level",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
      actors: [
        createActor("hero", "Hero", {
          components: [
            {
              ...createMeshComponent("live-mesh", "box"),
              sourceId: "prefab-mesh",
            },
          ],
        }),
      ],
    });
    expect(actors[0]!.components[0]!.guid).toBe("live-mesh");
    expect(actors[0]!.components[0]!.sourceId).toBe("prefab-mesh");
  });
});
