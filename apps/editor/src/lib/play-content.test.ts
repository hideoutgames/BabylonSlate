import { describe, expect, it } from "vitest";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  createActor,
  createDefaultScene,
  createDefaultSceneLayer,
  sceneLayerToEditorScene,
} from "@babylonslate/core";
import {
  buildBoxGlbFixture,
  cookComplexCollisionMeshes,
  createDefaultSpriteAnimationPayload,
  createDefaultSpritePayload,
  createDefaultTilemapPayload,
  createDefaultTilesetPayload,
  normalizeTilemapPayload,
} from "@babylonslate/assets";
import {
  collectPlayScriptDocuments,
  overlayTextureGuidsFromScenes,
  collectAnimGraphCompileDocuments,
  playLoadTilemapsControl,
  readPlayNavmeshBytes,
  readPlaySceneBakes,
  readPlayAudioReverbBytes,
  playSpritePayloadsFromGuids,
  playLoadSpritesControl,
  playLoadModelsControl,
  spriteAssetGuidsFromScene,
  skyboxFaceGuidsFromScene,
  environmentTextureGuidsFromScenes,
  postProcessTextureGuidsFromScenes,
  materialInstanceTextureGuidsFromScenes,
  tilemapAssetGuidsFromScene,
  tilesetGuidsFromTilemaps,
  textureGuidsFromPlayPayloads,
  modelAssetGuidsFromScene,
  modelGuidsForPlayRetarget,
  modelSlotMaterialGuidsFromPayloads,
  materialAssetGuidsFromScene,
  postProcessMaterialGuidsFromScene,
  materialGuidsFromScenes,
  playMaterialGuidsFromSources,
  playSceneByGuid,
  materialClosureFromGuids,
  overlayTextureGuidsFromScene,
  playFontGuidsFromScenes,
} from "./play-content";

describe("collectPlayScriptDocuments", () => {
  it("keeps Class graphs and drops editor-only assets", () => {
    const graph = {
      nodes: [],
      edges: [],
    };
    const documents = collectPlayScriptDocuments(
      [
        { path: "assets/Hero.class.babasset", content: graph },
        { path: "assets/Tools.euo.babasset", content: graph },
      ],
      {
        "assets/Hero.class.babasset": { type: "Class", parentClass: "Actor" },
        "assets/Tools.euo.babasset": {
          type: "Class",
          parentClass: "EditorUtilityObject",
        },
      },
      (id) =>
        id === "EditorUtilityObject" ? "BObject" : id === "Actor" ? "BObject" : null,
    );
    expect(documents.map((entry) => entry.path)).toEqual([
      "assets/Hero.class.babasset",
    ]);
    expect(documents[0]?.parentClassId).toBe("Actor");
  });
});

describe("collectAnimGraphCompileDocuments", () => {
  it("maps Play AnimationGraph entries onto compile documents", () => {
    const graph = createDefaultAnimGraph("Loco");
    expect(
      collectAnimGraphCompileDocuments(
        [{ guid: "graph-guid", document: graph }],
        (guid) =>
          guid === "graph-guid" ? "assets/Loco.anim.babasset" : null,
      ),
    ).toEqual([
      {
        guid: "graph-guid",
        path: "assets/Loco.anim.babasset",
        document: graph,
      },
    ]);
  });
});

describe("scene-referenced Play content", () => {
  it("collects SpriteComponent assetGuid values from a closed scene", () => {
    const scene = createDefaultScene();
    scene.actors.push(
      createActor("hero", "Hero", {
        components: [
          {
            id: "sprite",
            classId: "SpriteComponent",
            properties: { assetGuid: "hero-sprite" },
          },
        ],
      }),
    );
    expect(spriteAssetGuidsFromScene(scene)).toEqual(["hero-sprite"]);
  });

  it("collects TilemapComponent assetGuid values from a closed scene", () => {
    const scene = createDefaultScene();
    scene.actors.push(
      createActor("map", "Map", {
        components: [
          {
            id: "tiles",
            classId: "TilemapComponent",
            properties: { assetGuid: "overworld" },
          },
        ],
      }),
    );
    expect(tilemapAssetGuidsFromScene(scene)).toEqual(["overworld"]);
  });

  it("maps sprite guids to payloads for Play UV seeks", () => {
    const payload = createDefaultSpritePayload();
    const map = playSpritePayloadsFromGuids(["hero-sprite"], (guid) =>
      guid === "hero-sprite" ? payload : null,
    );
    expect(map.get("hero-sprite")).toEqual(payload);
  });

  it("builds a worker loadSprites control from sprite and Sprite Animation payloads", () => {
    const sprite = createDefaultSpritePayload();
    const animation = createDefaultSpriteAnimationPayload();
    expect(
      playLoadSpritesControl(
        new Map([["hero-sprite", sprite]]),
        new Map([["walk-anim", animation]]),
        16,
      ),
    ).toEqual({
      type: "loadSprites",
      sprites: [{ guid: "hero-sprite", document: sprite }],
      spriteAnimations: [{ guid: "walk-anim", document: animation }],
      pixelsPerUnit: 16,
    });
    expect(playLoadSpritesControl(new Map(), new Map())).toBeNull();
  });

  it("builds a worker loadModels control from Model payloads and cooked meshes", () => {
    const payload = {
      materialSlots: [],
      clipNames: [],
      skeletonGuid: null,
      importScale: 1,
      simpleColliders: [],
      autoLod: true,
    };
    const cooked = cookComplexCollisionMeshes(
      new Map([["hero-model", buildBoxGlbFixture(1)]]),
      new Map([["hero-model", payload]]),
    );
    expect(
      playLoadModelsControl(new Map([["hero-model", payload]]), cooked),
    ).toMatchObject({
      type: "loadModels",
      models: [{ guid: "hero-model", document: payload }],
      complexMeshes: [{ guid: "hero-model", positions: expect.any(Float32Array), indices: expect.any(Uint16Array) }],
    });
    expect(playLoadModelsControl(new Map())).toBeNull();
  });

  it("collects tileset guids from loaded tilemaps", () => {
    const tilemap = {
      ...createDefaultTilemapPayload(),
      tilesets: [{ guid: "overworld-set", firstGid: 1, tileCount: 4 }],
    };
    expect(tilesetGuidsFromTilemaps(new Map([["overworld", tilemap]]))).toEqual([
      "overworld-set",
    ]);
  });

  it("collects every tileset guid listed on a tilemap", () => {
    const tilemap = normalizeTilemapPayload({
      tilesets: [
        { guid: "ground", firstGid: 1, tileCount: 4 },
        { guid: "deco", firstGid: 5, tileCount: 2 },
      ],
    });
    expect(tilesetGuidsFromTilemaps(new Map([["overworld", tilemap]]))).toEqual([
      "ground",
      "deco",
    ]);
  });

  it("builds a worker loadTilemaps control from scene payloads", () => {
    const tilemap = createDefaultTilemapPayload();
    const tileset = createDefaultTilesetPayload();
    expect(
      playLoadTilemapsControl(
        new Map([["overworld", tilemap]]),
        new Map([["overworld-set", tileset]]),
        16,
      ),
    ).toEqual({
      type: "loadTilemaps",
      tilemaps: [{ guid: "overworld", document: tilemap }],
      tilesets: [{ guid: "overworld-set", document: tileset }],
      pixelsPerUnit: 16,
    });
    expect(playLoadTilemapsControl(new Map(), new Map())).toBeNull();
  });

  it("collects texture guids from sprite and tileset payloads", () => {
    const sprite = { ...createDefaultSpritePayload(), textureGuid: "tex-sprite" };
    const tileset = {
      ...createDefaultTilesetPayload(),
      textureGuid: "tex-atlas",
    };
    expect(
      textureGuidsFromPlayPayloads(
        new Map([["hero-sprite", sprite]]),
        new Map([["overworld-set", tileset]]),
      ),
    ).toEqual(["tex-sprite", "tex-atlas"]);
  });

  it("collects texture guids from Sprite Animation frames", () => {
    const animation = createDefaultSpriteAnimationPayload();
    animation.frames[0]!.textureGuid = "tex-walk";
    animation.frames.push({
      ...animation.frames[0]!,
      textureGuid: "tex-walk-2",
    });
    expect(
      textureGuidsFromPlayPayloads(
        new Map(),
        new Map(),
        new Map([["walk-anim", animation]]),
      ),
    ).toEqual(["tex-walk", "tex-walk-2"]);
  });

  it("skips missing texture guids and de-duplicates", () => {
    const sprite = { ...createDefaultSpritePayload(), textureGuid: "shared" };
    const tileset = { ...createDefaultTilesetPayload(), textureGuid: "shared" };
    expect(
      textureGuidsFromPlayPayloads(
        new Map([["hero-sprite", sprite]]),
        new Map([["overworld-set", tileset]]),
      ),
    ).toEqual(["shared"]);
    expect(
      textureGuidsFromPlayPayloads(new Map(), new Map()),
    ).toEqual([]);
  });

  it("collects MeshComponent assetGuid values as model assets", () => {
    const scene = createDefaultScene();
    scene.actors.push(
      createActor("tree", "Tree", {
        components: [
          {
            id: "mesh",
            classId: "MeshComponent",
            properties: { meshKind: "box", assetGuid: "tree-glb" },
          },
        ],
      }),
    );
    expect(modelAssetGuidsFromScene(scene)).toEqual(["tree-glb"]);
  });

  it("adds source Model guids needed to Play retargeted Animation rows", () => {
    expect(
      modelGuidsForPlayRetarget(
        ["hero-model"],
        [
          {
            guid: "native",
            payload: {
              clipName: "Idle",
              modelGuid: "hero-model",
              skeletonGuid: "hero-skel",
            },
          },
          {
            guid: "src",
            payload: {
              clipName: "Idle",
              modelGuid: "mixamo-model",
              skeletonGuid: "mixamo-skel",
            },
          },
          {
            guid: "retargeted",
            payload: {
              clipName: "Idle",
              modelGuid: "hero-model",
              skeletonGuid: "hero-skel",
              sourceAnimationGuid: "src",
            },
          },
        ],
      ).sort(),
    ).toEqual(["hero-model", "mixamo-model"]);
  });

  it("collects Model slot material guids for Play compile", () => {
    const payloads = new Map([
      [
        "hero",
        {
          clipNames: [],
          skeletonGuid: null,
          importScale: 1,
          simpleColliders: [],
          autoLod: true,
          materialSlots: [
            { index: 0, name: "Hero Mat", materialGuid: "mat-hero" },
            { index: 1, name: "Eyes", materialGuid: null },
          ],
        },
      ],
      [
        "rock",
        {
          clipNames: [],
          skeletonGuid: null,
          importScale: 1,
          simpleColliders: [],
          autoLod: true,
          materialSlots: [{ index: 0, name: "Rock", materialGuid: "mat-rock" }],
        },
      ],
    ]);
    expect(modelSlotMaterialGuidsFromPayloads(payloads)).toEqual([
      "mat-hero",
      "mat-rock",
    ]);
  });

  it("collects override skybox face texture guids and skips engine defaults", () => {
    const scene = createDefaultScene();
    expect(skyboxFaceGuidsFromScene(scene)).toEqual([]);
    const skybox = scene.actors.find((actor) => actor.id === "actor-skybox");
    expect(skybox).toBeDefined();
    skybox!.components[0]!.properties.faces = {
      px: "tex-right",
      py: null,
      pz: "tex-front",
      nx: null,
      ny: null,
      nz: null,
    };
    expect(skyboxFaceGuidsFromScene(scene)).toEqual(["tex-right", "tex-front"]);
  });
  it("collects distinct environment cubes from the active and destination scene library", () => {
    const active = createDefaultScene();
    active.settings.environmentTextureGuid = "active-cube";
    const destination = createDefaultScene();
    destination.settings.environmentTextureGuid = "destination-cube";
    expect(environmentTextureGuidsFromScenes([active, null, destination, active, createDefaultScene()])).toEqual(["active-cube", "destination-cube"]);
  });

  it("collects MeshComponent materialGuid values as surface materials", () => {
    const scene = createDefaultScene();
    scene.actors.push(
      createActor("rock", "Rock", {
        components: [
          {
            id: "mesh",
            classId: "MeshComponent",
            properties: { meshKind: "box", materialGuid: "mat-rock" },
          },
        ],
      }),
    );
    expect(materialAssetGuidsFromScene(scene)).toEqual(["mat-rock"]);
  });

  it("collects landscape materials and every Model and material in mixed foliage strokes", () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("environment", "Environment", { components: [
      { id: "land", classId: "LandscapeComponent", properties: { materialGuid: "terrain" } },
      { id: "plants", classId: "FoliageComponent", properties: { batches: [
        { modelGuid: "oak", materialGuid: "leaves", transforms: [{}] },
        { modelGuid: "pine", materialGuid: "leaves", transforms: [{}] },
      ] } },
    ] })];
    expect(modelAssetGuidsFromScene(scene)).toEqual(["oak", "pine"]);
    expect(materialAssetGuidsFromScene(scene)).toEqual(["terrain", "leaves"]);
  });

  it("loads Text Materials referenced by plain and rich SceneLayer labels", () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("labels", "Labels", { components: [
      { id: "plain", classId: "2DTextComponent", properties: { materialGuid: "plain-fill" } },
      { id: "rich", classId: "2DRichTextComponent", properties: { materialGuid: "rich-fill" } },
    ] })];
    expect(materialAssetGuidsFromScene(scene)).toEqual(["plain-fill", "rich-fill"]);
  });

  it("collects post-process stack guids in authored order, including disabled entries", () => {
    const scene = createDefaultScene();
    scene.settings.postProcessStack = [
      { materialGuid: "pp-a", enabled: true },
      { materialGuid: "pp-b", enabled: false },
    ];
    expect(postProcessMaterialGuidsFromScene(scene)).toEqual(["pp-a", "pp-b"]);
  });

  it("closes over surface materials, stack materials, functions, and textures", () => {
    const scene = createDefaultScene();
    scene.actors[0]!.components.push({
      id: "mesh",
      classId: "MeshComponent",
      properties: { meshKind: "box", materialGuid: "mat-rock" },
    });
    scene.settings.postProcessStack = [{ materialGuid: "pp-blur", enabled: true }];
    const docs: Record<string, unknown> = {
      "mat-rock": {
        domain: "surface",
        nodes: [
          {
            id: "tex",
            type: "param.texture",
            properties: { textureGuid: "tex-albedo" },
          },
          {
            id: "call",
            type: "function.call",
            properties: { functionGuid: "fn-tint" },
          },
        ],
        edges: [],
      },
      "pp-blur": {
        domain: "postProcess",
        nodes: [],
        edges: [],
      },
      "fn-tint": {
        nodes: [
          {
            id: "nested",
            type: "function.call",
            properties: { functionGuid: "fn-inner" },
          },
        ],
        edges: [],
      },
      "fn-inner": {
        nodes: [
          {
            id: "tex",
            type: "param.texture",
            properties: { textureGuid: "tex-lut" },
          },
        ],
        edges: [],
      },
    };
    const guids = [
      ...materialAssetGuidsFromScene(scene),
      ...postProcessMaterialGuidsFromScene(scene),
    ];
    expect(materialClosureFromGuids(guids, (guid) => docs[guid] ?? null)).toMatchObject({
      materials: ["mat-rock", "pp-blur"],
      functions: ["fn-tint", "fn-inner"],
      textures: ["tex-albedo", "tex-lut"],
    });
  });

  it("follows Material Instance parents to the root Material and reports unloaded references", () => {
    const docs: Record<string, unknown> = {
      "inst-red": { kind: "materialInstance", parentGuid: "inst-base", overrides: { Albedo: { kind: "texture", textureAssetGuid: "tex-red" } } },
      "inst-base": { kind: "materialInstance", parentGuid: "mat-root", overrides: {} },
      "mat-root": { nodes: [{ id: "call", type: "function.call", properties: { functionGuid: "fn-missing" } }], edges: [] },
    };
    const closure = materialClosureFromGuids(["inst-red"], (guid) => docs[guid] ?? null);
    expect(closure).toMatchObject({ materials: ["mat-root"], instances: ["inst-red", "inst-base"], textures: ["tex-red"] });
    // Callers load referenced guids that had no content yet, then retry.
    expect(closure.referenced).toContain("fn-missing");
  });

  it("unions material guids across Play library scenes", () => {
    const startup = createDefaultScene();
    startup.settings.postProcessStack = [{ materialGuid: "pp-a", enabled: true }];
    const level2 = createDefaultScene();
    level2.settings.postProcessStack = [{ materialGuid: "pp-b", enabled: true }];
    expect(materialGuidsFromScenes([startup, level2])).toEqual(["pp-a", "pp-b"]);
    expect(playMaterialGuidsFromSources([startup, level2], ["extra"])).toEqual([
      "pp-a",
      "pp-b",
      "extra",
    ]);
  });



  it("resolves an activeScene guid from the Play library", () => {
    const startup = createDefaultScene();
    const level2 = createDefaultScene();
    level2.name = "Level 2";
    expect(
      playSceneByGuid("scene-2", [{ guid: "scene-2", scene: level2 }], {
        guid: "scene-1",
        scene: startup,
      }),
    ).toBe(level2);
  });

  it("reloads the boot Scene from the Play library after the boot document is released", () => {
    const reloaded = createDefaultScene();
    expect(playSceneByGuid("scene-1", [{ guid: "scene-1", scene: reloaded }], { guid: "scene-1" })).toBe(reloaded);
  });
});

describe("readPlayNavmeshBytes", () => {
  it("collects each scene's bakes by GUID and isolates missing or failed chunks", async () => {
    const reads: string[] = [];
    const errors: string[] = [];
    const result = await readPlaySceneBakes([
      { guid: "one", path: "one.scene.babasset" }, { guid: "two", path: "two.scene.babasset" },
      { guid: "one", path: "one.scene.babasset" }, { guid: "unsaved" },
    ], async (path, chunkId) => {
      reads.push(`${path}:${chunkId}`);
      if (path.startsWith("one")) return chunkId === "navmesh" ? new Uint8Array([1]) : null;
      if (chunkId === "navmesh") throw new Error("Unavailable");
      return new Uint8Array([2]);
    }, (guid, chunkId) => errors.push(`${guid}:${chunkId}`));
    expect([...result.navmeshes]).toEqual([["one", new Uint8Array([1])]]);
    expect([...result.audioReverbs]).toEqual([["two", new Uint8Array([2])]]);
    expect(errors).toEqual(["two:navmesh"]);
    expect(reads).toHaveLength(4);
  });
  it("reads the Scene navmesh extra chunk and never invents bytes", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const readChunk = async (path: string, chunkId: string) => {
      expect(path).toBe("assets/Main.scene.babasset");
      expect(chunkId).toBe("navmesh");
      return bytes;
    };
    expect(
      await readPlayNavmeshBytes("assets/Main.scene.babasset", readChunk),
    ).toEqual(bytes);
  });

  it("returns null when the scene path or chunk is missing", async () => {
    expect(await readPlayNavmeshBytes(undefined, async () => new Uint8Array([1]))).toBeNull();
    expect(
      await readPlayNavmeshBytes("assets/Main.scene.babasset", async () => null),
    ).toBeNull();
  });
});

describe("SceneLayer Play collection", () => {
  it("collects overlay 2DTexture and 2DMaterial guids from converted layer scenes", () => {
    const layer = createDefaultSceneLayer();
    layer.actors.push(
      createActor("banner", "Banner", {
        classId: "SceneLayerActor",
        components: [
          {
            id: "tex",
            classId: "2DTextureComponent",
            properties: { textureGuid: "tex-banner" },
          },
          {
            id: "mat",
            classId: "2DMaterialComponent",
            properties: { materialGuid: "mat-unlit" },
          },
          { id: "stick", classId: "2DJoystickComponent", properties: { backgroundMaterialGuid: "mat-background", joystickMaterialGuid: "mat-joystick" } },
          {
            id: "sprite",
            classId: "SpriteComponent",
            properties: { assetGuid: "sprite-hud" },
          },
          {
            id: "rich",
            classId: "2DRichTextComponent",
            properties: {
              text: "[img=tex-inline size=14]Hi",
              fontAssetGuid: "font-hud",
            },
          },
        ],
      }),
    );
    const scenes = [sceneLayerToEditorScene(layer)];
    expect(overlayTextureGuidsFromScene(scenes[0])).toEqual([
      "tex-banner",
      "tex-inline",
    ]);
    expect(playFontGuidsFromScenes(scenes)).toEqual(["font-hud"]);
    expect(materialAssetGuidsFromScene(scenes[0])).toEqual(["mat-background", "mat-joystick", "mat-unlit"]);
    expect(spriteAssetGuidsFromScene(scenes[0])).toEqual(["sprite-hud"]);
  });
});

describe("readPlayAudioReverbBytes", () => {
  it("reads the Scene audioReverb extra chunk and never invents bytes", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const readChunk = async (path: string, chunkId: string) => {
      expect(path).toBe("assets/Main.scene.babasset");
      expect(chunkId).toBe("audioReverb");
      return bytes;
    };
    expect(
      await readPlayAudioReverbBytes("assets/Main.scene.babasset", readChunk),
    ).toEqual(bytes);
  });

  it("returns null when the scene path or chunk is missing", async () => {
    expect(
      await readPlayAudioReverbBytes(undefined, async () => new Uint8Array([1])),
    ).toBeNull();
    expect(
      await readPlayAudioReverbBytes("assets/Main.scene.babasset", async () => null),
    ).toBeNull();
  });
});

it("includes textures from disabled and duplicate post-process entry overrides in Play preparation", () => {
  const scene = createDefaultScene();
  scene.settings.postProcessStack = [
    { id: 'first', materialGuid: 'gain', enabled: false, parameters: {
      Mask: { kind: 'texture', textureAssetGuid: 'mask' }, Gain: { kind: 'float', value: 0.5 },
    } },
    { id: 'second', materialGuid: 'gain', enabled: true, parameters: {
      Mask: { kind: 'texture', textureAssetGuid: 'mask' }, Cleared: { kind: 'texture', textureAssetGuid: null },
    } },
  ];
  expect(postProcessTextureGuidsFromScenes([null, scene, scene])).toEqual(['mask']);
});

it("prepares retained surface textures only for the current component assignment", () => {
  const scene = createDefaultScene();
  scene.actors = [createActor("actor", "Actor", { components: [
    { id: "current", classId: "MeshComponent", properties: { materialGuid: "surface" }, materialInstance: {
      materialGuid: "surface", parameters: { Image: { kind: "texture", textureAssetGuid: "instance-texture" }, Empty: { kind: "texture", textureAssetGuid: null } },
    } },
    { id: "stale", classId: "MeshComponent", properties: { materialGuid: "other" }, materialInstance: {
      materialGuid: "surface", parameters: { Image: { kind: "texture", textureAssetGuid: "stale-texture" } },
    } },
  ] })];
  expect(materialInstanceTextureGuidsFromScenes([null, scene, scene])).toEqual(["instance-texture"]);
});

describe("SceneLayer control dependencies", () => {
  it("loads assigned control visuals for Play", () => {
    const scene = { ...createDefaultScene(), actors: [createActor("switch", "Switcher", { components: [{ id: "slider", classId: "2DSliderComponent", properties: { trackMaterialGuid: "track-material", thumbTextureGuid: "thumb-texture" } }] })] };
    expect(overlayTextureGuidsFromScenes([scene])).toEqual(["thumb-texture"]);
    expect(materialGuidsFromScenes([scene])).toEqual(["track-material"]);
  });
});
