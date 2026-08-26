import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedComponent,
} from "@babylonslate/core";
import {
  ENGINE_PLACE_ACTORS,
  duplicateSceneActor,
  nextActorId,
  placeActorsForHost,
  prefabComponentsForGuid,
  projectPlaceActors,
  spawnPlacedActor,
  visualForPlaceActor,
  type PlaceActorItem,
} from "./place-actors";

const ORIGIN: [number, number, number] = [0, 0, 0];

describe("ENGINE_PLACE_ACTORS", () => {
  it("groups shapes, lights, camera, empty, and navigation", () => {
    const categories = new Set(ENGINE_PLACE_ACTORS.map((item) => item.category));
    expect(categories).toEqual(
      new Set([
        "Shapes",
        "Lights",
        "Camera",
        "Environment",
        "Empty",
        "Navigation",
        "Audio",
        "Particles",
        "Physics",
      ]),
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

  it("hides Camera Lights and Skybox on overlay Place Actors and stamps SceneLayerActor", () => {
    const overlay = placeActorsForHost({ overlay: true });
    expect(overlay.some((entry) => entry.kind.type === "camera")).toBe(false);
    expect(overlay.some((entry) => entry.kind.type === "light")).toBe(false);
    expect(overlay.some((entry) => entry.kind.type === "skybox")).toBe(false);
    expect(overlay.some((entry) => entry.kind.type === "shape")).toBe(true);
    expect(
      overlay.filter((entry) => entry.category === "Overlay").map((entry) => entry.id),
    ).toEqual([
      "2d-anchor",
      "2d-texture",
      "2d-material",
      "2d-button",
      "2d-panel",
    ]);
    const actor = spawnPlacedActor(
      createDefaultScene(),
      overlay.find((entry) => entry.id === "shape-box")!,
      "actor-box",
      ORIGIN,
      { overlay: true },
    );
    expect(actor.classId).toBe("SceneLayerActor");
    const world = placeActorsForHost({ overlay: false });
    expect(world.some((entry) => entry.kind.type === "camera")).toBe(true);
    expect(world.some((entry) => entry.id === "2d-button")).toBe(false);
  });

  it("stamps overlay 2D Place Actors as SceneLayerActors with the matching component", () => {
    const overlay = placeActorsForHost({ overlay: true });
    const expected: Array<[string, string]> = [
      ["2d-anchor", "2DAnchorComponent"],
      ["2d-texture", "2DTextureComponent"],
      ["2d-material", "2DMaterialComponent"],
      ["2d-button", "2DButtonComponent"],
      ["2d-panel", "2DPanelComponent"],
    ];
    for (const [id, classId] of expected) {
      const item = overlay.find((entry) => entry.id === id);
      expect(item?.title).toBeTruthy();
      const actor = spawnPlacedActor(
        createDefaultScene(),
        item!,
        `actor-${id}`,
        ORIGIN,
        { overlay: true },
      );
      expect(actor.classId).toBe("SceneLayerActor");
      expect(actor.components.map((component) => component.classId)).toEqual([
        classId,
      ]);
    }
  });

  it("strips Camera Light and Skybox when placing an overlay Class prefab", () => {
    const item: PlaceActorItem = {
      id: "asset-hud",
      title: "Hud",
      category: "Project",
      kind: {
        type: "asset",
        name: "Hud",
        guid: "hud",
        assetType: "Class",
        classId: "HudBanner",
        components: [
          { id: "sprite", classId: "SpriteComponent", properties: {} },
          { id: "cam", classId: "CameraComponent", properties: {} },
          { id: "light", classId: "LightComponent", properties: {} },
          { id: "sky", classId: "SkyboxComponent", properties: {} },
        ],
      },
    };
    const actor = spawnPlacedActor(
      createDefaultScene(),
      item,
      "actor-hud",
      ORIGIN,
      { overlay: true },
    );
    expect(actor.classId).toBe("HudBanner");
    expect(actor.components.map((component) => component.classId)).toEqual([
      "SpriteComponent",
    ]);
  });

  it("places an Audio actor with an AudioComponent", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "audio")!;
    expect(item.category).toBe("Audio");
    expect(visualForPlaceActor(item).iconKey).toBe("AudioComponent");
    const actor = spawnPlacedActor(createDefaultScene(), item, "actor-audio", ORIGIN);
    expect(actor.name).toBe("Audio");
    expect(actor.components[0]?.classId).toBe("AudioComponent");
    expect(actor.components[0]?.properties).toEqual({
      audioAssetGuid: null,
      playOnStart: true,
      loop: false,
      volume: 1,
    });
  });

  it("places a Particle actor with a ParticleComponent", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "particle")!;
    expect(item.category).toBe("Particles");
    expect(visualForPlaceActor(item).iconKey).toBe("ParticleComponent");
    const actor = spawnPlacedActor(
      createDefaultScene(),
      item,
      "actor-particle",
      ORIGIN,
    );
    expect(actor.name).toBe("Particle");
    expect(actor.components[0]?.classId).toBe("ParticleComponent");
    expect(actor.components[0]?.properties).toEqual({
      particleSystemGuid: null,
      playOnStart: true,
      sortingLayer: "Default",
      orderInLayer: 0,
    });
  });
});

describe("spawnPlacedActor", () => {
  const scene = createDefaultScene();

  it("spawns a mesh primitive", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "shape-sphere")!;
    const actor = spawnPlacedActor(scene, item, "actor-1", ORIGIN);
    expect(actor.name).toBe("sphere");
    expect(actor.components[0]?.classId).toBe("MeshComponent");
    expect(actor.components[0]?.properties.meshKind).toBe("sphere");
  });

  it("spawns a light actor", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "light-point")!;
    const actor = spawnPlacedActor(scene, item, "actor-2", ORIGIN);
    expect(actor.components[0]?.classId).toBe("LightComponent");
    expect(actor.components[0]?.properties.lightKind).toBe("point");
    expect(actor.components[0]?.properties.range).toBe(10);
  });

  it("spawns a locked Skybox actor with a SkyboxComponent", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "skybox")!;
    expect(item.category).toBe("Environment");
    expect(visualForPlaceActor(item).iconKey).toBe("SkyboxComponent");
    const actor = spawnPlacedActor(createDefaultScene(), item, "actor-sky", ORIGIN);
    expect(actor.name).toBe("Skybox");
    expect(actor.locked).toBe(true);
    expect(actor.components[0]?.classId).toBe("SkyboxComponent");
    expect(actor.components[0]?.properties.size).toBe(1000);
  });

  it("spawns an unlocked 3D Text actor with a Text3DComponent", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "text3d")!;
    expect(item.category).toBe("Environment");
    expect(visualForPlaceActor(item).iconKey).toBe("Text3DComponent");
    const actor = spawnPlacedActor(createDefaultScene(), item, "actor-text", ORIGIN);
    expect(actor.name).toBe("3D Text");
    expect(actor.locked).toBeFalsy();
    expect(actor.components[0]?.classId).toBe("Text3DComponent");
    expect(actor.components[0]?.properties.text).toBe("Text");
  });

  it("spawns a NavMesh actor with Recast settings", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "navmesh")!;
    const actor = spawnPlacedActor(scene, item, "actor-nav", ORIGIN);
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
    const actor = spawnPlacedActor(scene, item, "actor-block", ORIGIN);
    expect(actor.name).toBe("NavMesh Blocker");
    expect(actor.components[0]?.classId).toBe("NavMeshBlockerComponent");
    expect(actor.components[0]?.properties.dynamic).toBe(false);
    expect(actor.components[0]?.properties.kind).toBe("box");
    expect(actor.components[0]?.properties.area).toBe("unwalkable");
  });

  it("spawns a Blocking Volume under Physics", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "blocking-volume")!;
    expect(item.category).toBe("Physics");
    expect(visualForPlaceActor(item).iconKey).toBe("BlockingVolumeComponent");
    const actor = spawnPlacedActor(scene, item, "actor-wall", ORIGIN);
    expect(actor.name).toBe("Blocking Volume");
    expect(actor.components[0]?.classId).toBe("BlockingVolumeComponent");
  });

  it("spawns a camera with explicit projection defaults", () => {
    const item = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "camera")!;
    const actor = spawnPlacedActor(scene, item, "actor-cam", ORIGIN);
    expect(actor.components[0]?.classId).toBe("CameraComponent");
    expect(actor.components[0]?.properties.projectionMode).toBe("perspective");
    expect(actor.components[0]?.properties.nearClip).toBe(0.1);
    expect(actor.components[0]?.properties.farClip).toBe(1000);
  });

  it("spawns an empty actor", () => {
    const item: PlaceActorItem = ENGINE_PLACE_ACTORS.find(
      (entry) => entry.id === "empty",
    )!;
    const actor = spawnPlacedActor(scene, item, "actor-3", ORIGIN);
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
    const actor = spawnPlacedActor(scene, item, "actor-9", ORIGIN);
    expect(actor.classId).toBe("Hero");
    expect(actor.components).toEqual([
      {
        id: "actor-9-SpriteComponent-1",
        classId: "SpriteComponent",
        properties: { assetGuid: "sprite-1" },
        parentId: null,
        sourceId: "sprite",
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
        actors: [spawnPlacedActor(empty, ENGINE_PLACE_ACTORS[0]!, "actor-1", ORIGIN)],
      }),
    ).toBe("actor-2");
  });

  it("still yields actor-2 when the default scene already has a named Camera", () => {
    expect(nextActorId(createDefaultScene())).toBe("actor-2");
  });
});

describe("spawnPlacedActor placement", () => {
  const sphere = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "shape-sphere")!;
  const navmesh = ENGINE_PLACE_ACTORS.find((entry) => entry.id === "navmesh")!;

  it("uses the supplied world position", () => {
    const scene = createDefaultScene();
    const actor = spawnPlacedActor(scene, sphere, "actor-2", [4, 5, 6]);
    expect(actor.transform.position).toEqual([4, 5, 6]);
  });

  it("places a NavMesh at the supplied world position", () => {
    const scene = createDefaultScene();
    const actor = spawnPlacedActor(scene, navmesh, "actor-nav", [1, 2, 3]);
    expect(actor.transform.position).toEqual([1, 2, 3]);
  });
});

describe("duplicateSceneActor", () => {
  it("clones the actor with a new id and Copy name", () => {
    const scene = createDefaultScene();
    const source = createActor("actor-1", "Cube", {
      folderId: "props",
      parentId: "actor-root",
      components: [createMeshComponent("mesh-1", "box")],
    });
    const copy = duplicateSceneActor(scene, source);
    expect(copy.id).toBe("actor-2");
    expect(copy.name).toBe("Cube Copy");
    expect(copy.parentId).toBe("actor-root");
    expect(copy.folderId).toBe("props");
    expect(copy.components).toEqual(source.components);
    expect(copy.transform).toEqual(source.transform);
    expect(copy).not.toBe(source);
  });

  it("keeps prefab sourceId and overrideKeys on the copy", () => {
    const scene = createDefaultScene();
    const source = createActor("actor-1", "Hero", {
      classId: "Hero",
      components: [
        {
          ...createMeshComponent("mesh-1", "box"),
          sourceId: "prefab-mesh",
          overrideKeys: ["meshKind"],
        },
      ],
    });
    const copy = duplicateSceneActor(scene, source);
    expect(copy.components[0]?.sourceId).toBe("prefab-mesh");
    expect(copy.components[0]?.overrideKeys).toEqual(["meshKind"]);
  });

  it("can drop the copy at a world position as a root actor", () => {
    const scene = createDefaultScene();
    const source = createActor("actor-1", "Cube", {
      parentId: "actor-root",
      folderId: "props",
      transform: {
        position: [1, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    });
    const copy = duplicateSceneActor(scene, source, {
      position: [4, 5, 6],
      parentId: null,
    });
    expect(copy.parentId).toBeNull();
    expect(copy.folderId).toBe("props");
    expect(copy.transform.position).toEqual([4, 5, 6]);
    expect(copy.transform.scale).toEqual([1, 1, 1]);
  });
});

describe("projectPlaceActors", () => {
  it("lists Class, Model, Audio, and Particle System assets, not textures", () => {
    const items = projectPlaceActors([
      { header: { guid: "hero", name: "Hero", type: "Class" } },
      { header: { guid: "mesh", name: "Tree", type: "Model" } },
      { header: { guid: "sfx", name: "Jump", type: "Audio" } },
      { header: { guid: "fx", name: "Fire", type: "ParticleSystem" } },
      { header: { guid: "tex", name: "Grass", type: "Texture" } },
    ]);
    expect(items.map((item) => item.title)).toEqual(["Hero", "Tree", "Jump", "Fire"]);
  });

  it("keeps SceneLayerActor classes on overlay Place Actors and world Classes off overlay", () => {
    const assets = [
      {
        path: "assets/Hud.class.babasset",
        header: {
          guid: "hud",
          name: "Hud",
          type: "Class",
          parentClass: "SceneLayerActor",
        },
      },
      {
        path: "assets/Hero.class.babasset",
        header: {
          guid: "hero",
          name: "Hero",
          type: "Class",
          parentClass: "Actor",
        },
      },
      { header: { guid: "sfx", name: "Jump", type: "Audio" } },
    ];
    expect(
      projectPlaceActors(assets, undefined, { overlay: true }).map(
        (item) => item.title,
      ),
    ).toEqual(["Hud", "Jump"]);
    expect(
      projectPlaceActors(assets, undefined, { overlay: false }).map(
        (item) => item.title,
      ),
    ).toEqual(["Hero", "Jump"]);
  });

  it("places a project Audio asset with the guid already on AudioComponent", () => {
    const items = projectPlaceActors([
      { header: { guid: "beep", name: "Beep", type: "Audio" } },
    ]);
    const item = items[0]!;
    const actor = spawnPlacedActor(
      createDefaultScene(),
      item,
      "actor-beep",
      ORIGIN,
    );
    expect(actor.name).toBe("Beep");
    expect(actor.components[0]?.classId).toBe("AudioComponent");
    expect(actor.components[0]?.properties).toEqual({
      audioAssetGuid: "beep",
      playOnStart: true,
      loop: false,
      volume: 1,
    });
  });

  it("places a project Particle System with the guid already on ParticleComponent", () => {
    const items = projectPlaceActors([
      { header: { guid: "fire", name: "Fire", type: "ParticleSystem" } },
    ]);
    const item = items[0]!;
    const actor = spawnPlacedActor(
      createDefaultScene(),
      item,
      "actor-fire",
      ORIGIN,
    );
    expect(actor.name).toBe("Fire");
    expect(actor.components[0]?.classId).toBe("ParticleComponent");
    expect(actor.components[0]?.properties).toEqual({
      particleSystemGuid: "fire",
      playOnStart: true,
      sortingLayer: "Default",
      orderInLayer: 0,
    });
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

  it("places a subclass with ancestor-merged prefab components", () => {
    const assets = [
      {
        path: "assets/pawn.class.babasset",
        header: {
          guid: "pawn-guid",
          name: "Pawn",
          type: "Class",
          parentClass: "Actor",
        },
      },
      {
        path: "assets/hero.class.babasset",
        header: {
          guid: "hero-guid",
          name: "Hero",
          type: "Class",
          parentClass: "Pawn",
        },
      },
    ];
    const graphs: Record<string, { components?: SerializedComponent[] }> = {
      "assets/pawn.class.babasset": {
        components: [createMeshComponent("prefab-mesh", "box")],
      },
      "assets/hero.class.babasset": { components: [] },
    };
    const items = projectPlaceActors(assets, (guid) =>
      prefabComponentsForGuid(guid, {
        assets,
        graphForPath: (path) => graphs[path],
      }),
    );
    const hero = items.find((item) => item.title === "Hero");
    expect(hero?.kind).toMatchObject({
      type: "asset",
      components: [
        expect.objectContaining({
          id: "prefab-mesh",
          properties: expect.objectContaining({ meshKind: "box" }),
        }),
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
