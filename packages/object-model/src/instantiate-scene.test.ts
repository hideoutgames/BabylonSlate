import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createDefaultSceneLayerSettings,
  createDefaultSceneSettings,
  createMeshComponent,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@babylonslate/core";
import { ClassRegistry } from "./class-registry";
import { attachSerializedComponents, createActorFromSerialized } from "./instantiate-scene";
import { World } from "./world";
import { SceneStreamingActor } from "./objects";

/** Every document row through the per-actor factory, as Play instantiates a scene or SceneLayer. */
function documentActors(
  world: World,
  document: SerializedScene | SerializedSceneLayer,
  sceneLayerId?: string,
) {
  return document.actors.flatMap((serialized) =>
    createActorFromSerialized(world, serialized, undefined, sceneLayerId) ?? [],
  );
}

function testWorld() {
  return new World({
    seed: 1,
    dt: 1 / 60,
    classRegistry: new ClassRegistry(),
  });
}

it("hydrates inherited typed map overrides for placed actors without sharing the authored values", () => {
  const world = testWorld();
  world.classRegistry.register({ id: "LocalizedActor", parentClassId: "Actor", kind: "actor", implementedInterfaces: [], variables: [
    { name: "labels", type: "string", container: "map", keyTypeId: "string", defaultValue: [{ key: "locale", value: "default" }] },
    { name: "choices", type: "string", container: "array", defaultValue: ["default"] },
    { name: "untouched", type: "string", defaultValue: "inherited" },
  ] });
  world.classRegistry.register({ id: "MenuActor", parentClassId: "LocalizedActor", kind: "actor", implementedInterfaces: [], variables: [] });
  const source = createActor("menu", "Menu", { classId: "MenuActor", properties: {
    labels: [{ key: "locale", value: "en" }], choices: ["one"],
  } });
  const first = createActorFromSerialized(world, source)!;
  const second = createActorFromSerialized(world, { ...source, id: "other" })!;
  const labels = first.getVariable("labels") as Map<string, string>;
  expect(labels).toBeInstanceOf(Map);
  expect(labels.get("locale")).toBe("en");
  labels.set("locale", "fr");
  (first.getVariable("choices") as string[]).push("two");
  expect(second.getVariable("labels")).toEqual(new Map([["locale", "en"]]));
  expect(second.getVariable("choices")).toEqual(["one"]);
  expect(first.getVariable("untouched")).toBe("inherited");
  expect(source.properties).toEqual({ labels: [{ key: "locale", value: "en" }], choices: ["one"] });
});

it("keeps deformer targets local when spawning fresh instances of inherited scene components", () => {
  const world = testWorld();
  const first = world.createActor({ classId: "Actor" });
  const second = world.createActor({ classId: "Actor" });
  const components = [
    { id: "placed-mesh", sourceId: "template-mesh", classId: "MeshComponent", properties: {} },
    { id: "placed-cage", classId: "DeformerComponent", properties: { enabled: true, targetMeshComponentId: "template-mesh", offsets: [1, 0, 0] } },
  ];
  attachSerializedComponents(world, first, components, { freshIds: true });
  attachSerializedComponents(world, second, components, { freshIds: true });
  expect(first.components[1]!.getVariable("targetMeshComponentId")).toBe(first.components[0]!.guid);
  expect(second.components[1]!.getVariable("targetMeshComponentId")).toBe(second.components[0]!.guid);
  expect(first.components[0]!.guid).not.toBe(second.components[0]!.guid);
  (first.components[1]!.getVariable("offsets") as number[])[0] = 9;
  expect(second.components[1]!.getVariable("offsets")).toEqual([1, 0, 0]);
  expect(components[1]!.properties.targetMeshComponentId).toBe("template-mesh");
});

it("detaches a missing prefab parent while retaining template identity", () => {
  const world = testWorld();
  const actor = world.createActor({ classId: "Actor" });
  attachSerializedComponents(
    world,
    actor,
    [
      {
        id: "mesh",
        classId: "MeshComponent",
        parentId: "missing",
        properties: {},
      },
    ],
    { freshIds: true },
  );
  expect(actor.components[0]!.parentId).toBeNull();
  expect(actor.components[0]!.sourceId).toBe("mesh");
  expect(actor.components[0]!.guid).not.toBe("mesh");
});

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
    const actors = documentActors(world, scene);
    expect(actors.map((actor) => actor.guid)).toEqual(["grouped", "loose"]);
  });
});

describe("createActorFromSerialized for SceneLayer rows", () => {
  it("tags overlay actors with the live SceneLayer id", () => {
    const world = testWorld();
    const layer = world.createSceneLayer({ assetGuid: "hud", zOrder: 1 });
    const actors = documentActors(
      world,
      {
        name: "HUD",
        settings: createDefaultSceneLayerSettings(),
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
    const actors = documentActors(
      world,
      {
        name: "HUD",
        settings: createDefaultSceneLayerSettings(),
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

describe("createActorFromSerialized", () => {
  it("does not realize suppressed source rows for placed actors or fresh prefab identities", () => {
    const world = testWorld();
    const removed = { ...createMeshComponent("removed"), sourceId: "source-removed" };
    const child = { ...createMeshComponent("child"), parentId: "removed" };
    const placed = createActorFromSerialized(world, createActor("placed", "Placed", {
      components: [removed, child], suppressedComponentSourceIds: ["source-removed"],
    }))!;
    expect(placed.components.map((component) => [component.guid, component.parentId])).toEqual([["child", null]]);
    const spawned = world.createActor({ classId: "Actor", guid: "spawned", suppressedComponentSourceIds: ["removed"] });
    attachSerializedComponents(world, spawned, [removed, child], { freshIds: true });
    expect(spawned.components.map((component) => [component.guid, component.sourceId, component.parentId]))
      .toEqual([["spawned:child", "child", null]]);
  });
  it("instantiates the dedicated streaming actor identity and its authored scene target", () => {
    const world = testWorld();
    const actors = documentActors(world, {
      ...createDefaultScene(),
      actors: [createActor("stream", "Courtyard", { classId: "SceneStreamingActor", components: [
        { id: "origin", classId: "SceneStreamingComponent", properties: { sceneGuid: "scene-courtyard", sceneName: "Courtyard" } },
      ] })],
    });
    const actor = actors[0];
    expect(actor).toBeInstanceOf(SceneStreamingActor);
    expect(world.classRegistry.isA(actor!.classId, "Actor")).toBe(true);
    expect((actor as SceneStreamingActor).targetSceneGuid).toBe("scene-courtyard");
    expect((actor as SceneStreamingActor).targetSceneName).toBe("Courtyard");
  });

  it("builds unspawned actors with serialized ids, transforms, and components", () => {
    const world = testWorld();
    const actors = documentActors(world, {
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
    const actors = documentActors(world, {
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
    const actors = documentActors(world, {
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
    const actors = documentActors(world, {
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
    const actors = documentActors(world, {
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
    const actors = documentActors(world, {
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
    const actors = documentActors(world, {
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
    const actors = documentActors(world, {
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
    const actors = documentActors(world, {
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
