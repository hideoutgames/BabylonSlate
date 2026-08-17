import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import {
  ENGINE_PLACE_ACTORS,
  nextActorId,
  prefabComponentsForGuid,
  projectPlaceActors,
  spawnPlacedActor,
  visualForPlaceActor,
  type PlaceActorItem,
} from "./place-actors";

describe("ENGINE_PLACE_ACTORS", () => {
  it("groups shapes, lights, camera, empty, and navigation", () => {
    const categories = new Set(ENGINE_PLACE_ACTORS.map((item) => item.category));
    expect(categories).toEqual(
      new Set(["Shapes", "Lights", "Camera", "Empty", "Navigation", "Audio"]),
    );
    expect(ENGINE_PLACE_ACTORS.some((entry) => entry.id === "navmesh-blocker")).toBe(
      true,
    );
  });

  it("uses Actor color with distinct component icons", () => {
    const shape = visualForPlaceActor(
      ENGINE_PLACE_ACTORS.find((entry) => entry.id === "shape-box")!,
    );
    const light = visualForPlaceActor(
      ENGINE_PLACE_ACTORS.find((entry) => entry.id === "light-point")!,
    );
    const empty = visualForPlaceActor(
      ENGINE_PLACE_ACTORS.find((entry) => entry.id === "empty")!,
    );
    expect(shape.colorVar).toBe("var(--asset-animation)");
    expect(light.colorVar).toBe(shape.colorVar);
    expect(empty.iconKey).toBe("Actor");
    expect(shape.iconKey).toBe("MeshComponent");
    expect(light.iconKey).toBe("LightComponent");
  });

  it("places an Audio actor with an AudioComponent", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "audio")!;
    expect(item.category).toBe("Audio");
    expect(visualForPlaceActor(item).iconKey).toBe("AudioComponent");
    const actor = spawnPlacedActor(createDefaultScene(), item, "actor-audio");
    expect(actor.name).toBe("Audio");
    expect(actor.components[0]?.classId).toBe("AudioComponent");
    expect(actor.components[0]?.properties).toEqual({
      audioAssetGuid: null,
      playOnStart: true,
      loop: false,
      volume: 1,
    });
  });
});

describe("spawnPlacedActor", () => {
  const scene = createDefaultScene();

  it("spawns a mesh primitive", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "shape-sphere")!;
    const actor = spawnPlacedActor(scene, item, "actor-1");
    expect(actor.name).toBe("sphere");
    expect(actor.components[0]?.classId).toBe("MeshComponent");
    expect(actor.components[0]?.properties.meshKind).toBe("sphere");
  });

  it("spawns a light actor", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "light-point")!;
    const actor = spawnPlacedActor(scene, item, "actor-2");
    expect(actor.components[0]?.classId).toBe("LightComponent");
    expect(actor.components[0]?.properties.lightKind).toBe("point");
    expect(actor.components[0]?.properties.range).toBe(10);
  });

  it("spawns a NavMesh actor with Recast settings", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "navmesh")!;
    const actor = spawnPlacedActor(scene, item, "actor-nav");
    expect(actor.name).toBe("NavMesh");
    expect(actor.components[0]?.classId).toBe("NavMeshComponent");
    expect(actor.components[0]?.properties.cellSize).toBe(0.2);
    expect(actor.components[0]?.properties.tiled).toBe(false);
    expect(actor.components[0]?.properties.supportDynamicObstacles).toBe(false);
    expect(actor.components[0]?.properties.autoBakeOnSave).toBe(false);
    expect(actor.components[0]?.properties.debugOverlay).toBe(false);
  });

  it("spawns a NavMesh blocker with static unwalkable defaults", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "navmesh-blocker")!;
    const actor = spawnPlacedActor(scene, item, "actor-block");
    expect(actor.name).toBe("NavMesh Blocker");
    expect(actor.components[0]?.classId).toBe("NavMeshBlockerComponent");
    expect(actor.components[0]?.properties.dynamic).toBe(false);
    expect(actor.components[0]?.properties.kind).toBe("box");
    expect(actor.components[0]?.properties.area).toBe("unwalkable");
  });

  it("spawns a camera with explicit projection defaults", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "camera")!;
    const actor = spawnPlacedActor(scene, item, "actor-cam");
    expect(actor.components[0]?.classId).toBe("CameraComponent");
    expect(actor.components[0]?.properties.projectionMode).toBe("perspective");
    expect(actor.components[0]?.properties.nearClip).toBe(0.1);
    expect(actor.components[0]?.properties.farClip).toBe(1000);
  });

  it("spawns an empty actor", () => {
    const item: PlaceActorItem = ENGINE_PLACE_ACTORS.find(
      (entry) => entry.id === "empty",
    )!;
    const actor = spawnPlacedActor(scene, item, "actor-3");
    expect(actor.components).toEqual([]);
  });

  it("spawns a Class asset with the authored prefab components and classId", () => {
    const item: PlaceActorItem = {
      id: "asset-hero",
      title: "Hero",
      category: "Project",
      kind: {
        type: "asset",
        name: "Hero",
        guid: "hero-guid",
        assetType: "Class",
        classId: "Hero",
        components: [
          {
            id: "sprite",
            classId: "SpriteComponent",
            properties: { assetGuid: "sprite-1" },
          },
        ],
      },
    };
    const actor = spawnPlacedActor(scene, item, "actor-9");
    expect(actor.classId).toBe("Hero");
    expect(actor.components).toEqual([
      {
        id: "actor-9-SpriteComponent-1",
        classId: "SpriteComponent",
        properties: { assetGuid: "sprite-1" },
        parentId: null,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
    ]);
  });

  it("allocates the next unused actor-N id", () => {
    const empty = { ...scene, actors: [] };
    expect(nextActorId(empty)).toBe("actor-1");
    expect(
      nextActorId({
        ...empty,
        actors: [spawnPlacedActor(empty, ENGINE_PLACE_ACTORS[0]!, "actor-1")],
      }),
    ).toBe("actor-2");
  });

  it("still yields actor-2 when the default scene already has a named Camera", () => {
    expect(nextActorId(createDefaultScene())).toBe("actor-2");
  });
});

describe("spawnPlacedActor placement", () => {
  const sphere = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "shape-sphere")!;
  const box = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "shape-box")!;

  it("uses the origin when the scene has no actors", () => {
    const empty = { ...createDefaultScene(), actors: [] };
    expect(spawnPlacedActor(empty, sphere, "actor-1").transform.position).toEqual([
      0, 0, 0,
    ]);
  });

  it("does not bury a new actor inside the default Cube at the origin", () => {
    const scene = createDefaultScene();
    const actor = spawnPlacedActor(scene, sphere, "actor-2");
    expect(actor.transform.position).not.toEqual([0, 0, 0]);
  });

  it("keeps successive placements clear of each other", () => {
    let scene = { ...createDefaultScene(), actors: [] };
    const positions: number[] = [];
    for (const [index, item] of [sphere, box, sphere].entries()) {
      const actor = spawnPlacedActor(scene, item, `actor-${index + 1}`);
      positions.push(actor.transform.position[0]);
      scene = { ...scene, actors: [...scene.actors, actor] };
    }
    expect(new Set(positions).size).toBe(3);
    const sorted = [...positions].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("reuses a gap left by a deleted actor instead of drifting outward", () => {
    const scene = {
      ...createDefaultScene(),
      actors: [] as ReturnType<typeof spawnPlacedActor>[],
    };
    const first = spawnPlacedActor(scene, box, "actor-1");
    const withFirst = { ...scene, actors: [first] };
    const second = spawnPlacedActor(withFirst, box, "actor-2");
    const onlySecond = { ...scene, actors: [second] };
    expect(spawnPlacedActor(onlySecond, box, "actor-3").transform.position).toEqual(
      first.transform.position,
    );
  });
});

describe("projectPlaceActors", () => {
  it("lists Class and Model assets, not sounds or textures", () => {
    const items = projectPlaceActors([
      { header: { guid: "hero", name: "Hero", type: "Class" } },
      { header: { guid: "mesh", name: "Tree", type: "Model" } },
      { header: { guid: "sfx", name: "Jump", type: "Sound" } },
      { header: { guid: "tex", name: "Grass", type: "Texture" } },
    ]);
    expect(items.map((item) => item.title)).toEqual(["Hero", "Tree"]);
  });

  it("copies prefab components from a closed class graph payload", () => {
    const assets = [
      {
        path: "assets/hero.class.babasset",
        header: { guid: "hero-guid", name: "Hero", type: "Class" },
      },
    ];
    const items = projectPlaceActors(assets, (guid) =>
      prefabComponentsForGuid(guid, {
        assets,
        graphForPath: (path) =>
          path === "assets/hero.class.babasset"
            ? {
                nodes: [],
                edges: [],
                components: [
                  {
                    id: "sprite",
                    classId: "SpriteComponent",
                    properties: { assetGuid: "sprite-1" },
                  },
                ],
              }
            : undefined,
      }),
    );
    expect(items[0]?.kind).toMatchObject({
      type: "asset",
      components: [
        {
          id: "sprite",
          classId: "SpriteComponent",
          properties: { assetGuid: "sprite-1" },
        },
      ],
    });
  });

  it("uses the compile class id for a Class asset named main.class", () => {
    const items = projectPlaceActors([
      {
        path: "assets/main.class.babasset",
        header: { guid: "main-guid", name: "main.class", type: "Class" },
      },
    ]);
    expect(items[0]?.kind).toMatchObject({
      type: "asset",
      classId: "main",
    });
  });
});
