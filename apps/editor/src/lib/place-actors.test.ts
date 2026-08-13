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
  it("groups shapes, lights, camera, and empty", () => {
    const categories = new Set(ENGINE_PLACE_ACTORS.map((item) => item.category));
    expect(categories).toEqual(
      new Set(["Shapes", "Lights", "Camera", "Empty"]),
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
    expect(shape.colorVar).toBe("var(--asset-class)");
    expect(light.colorVar).toBe(shape.colorVar);
    expect(empty.iconKey).toBe("Actor");
    expect(shape.iconKey).toBe("MeshComponent");
    expect(light.iconKey).toBe("LightComponent");
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
});
