import { describe, expect, it } from "vitest";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import { createDefaultBehaviourTree } from "@babylonslate/behaviour-tree";
import {
  createActor,
  createDefaultScene,
  createDefaultSceneLayer,
  sceneLayerToEditorScene,
  type SerializedGraph,
} from "@babylonslate/core";
import {
  buildBoxGlbFixture,
  createDefaultSpriteAnimationPayload,
  createDefaultSpritePayload,
  createDefaultTilemapPayload,
  createDefaultTilesetPayload,
  normalizeTilemapPayload,
} from "@babylonslate/assets";
import {
  animationGraphGuidsFromScene,
  behaviourTreeGuidsFromScene,
  blackboardGuidsFromScene,
  collectPlayScriptDocuments,
  mergePlayAnimGraphs,
  collectAnimGraphCompileDocuments,
  playAnimGraphsFromOpenDocuments,
  playAnimGraphsFromGuids,
  playLoadTilemapsControl,
  readPlayNavmeshBytes,
  readPlayAudioReverbBytes,
  playSpriteAnimationPayloadsFromGuids,
  playSpritePayloadsFromGuids,
  playLoadSpritesControl,
  playLoadModelsControl,
  cookPlayComplexMeshes,
  spriteAnimationGuidsFromAnimGraphs,
  spriteAnimationGuidsFromBehaviourTrees,
  spriteAssetGuidsFromScene,
  skyboxFaceGuidsFromScene,
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
  overlayEditorScenesFromLayers,
  overlayTextureGuidsFromScene,
  playFontGuidsFromScenes,
  sceneLayerGuidsFromGraphs,
  sceneLayerGuidsFromScenes,
  sceneLayerMaterialGuidsFromGraphs,
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

describe("playAnimGraphsFromOpenDocuments", () => {
  it("emits loadAnimGraphs entries keyed by registry guid", () => {
    const graph = createDefaultAnimGraph("Loco");
    const entries = playAnimGraphsFromOpenDocuments(
      [
        {
          id: "anim-graph:assets/Loco.anim.babasset",
          ref: { kind: "anim-graph", path: "assets/Loco.anim.babasset" },
          content: graph,
        },
      ],
      (path) => (path.endsWith("Loco.anim.babasset") ? "graph-guid" : null),
    );
    expect(entries).toEqual([{ guid: "graph-guid", document: graph }]);
  });

  it("keeps Animation clip guids and fills the glTF clip name before Play", () => {
    const graph = createDefaultAnimGraph("Loco");
    graph.clips[0] = {
      id: "idle-clip",
      kind: "animation",
      assetGuid: "hero-walk-anim",
      clipName: "Idle",
      durationMs: 1000,
    };
    const entries = playAnimGraphsFromOpenDocuments(
      [
        {
          id: "anim-graph:assets/Loco.anim.babasset",
          ref: { kind: "anim-graph", path: "assets/Loco.anim.babasset" },
          content: graph,
        },
      ],
      () => "graph-guid",
      [
        {
          guid: "hero-model",
          type: "Model",
          name: "Hero",
          clipNames: ["Idle", "Walk"],
          dependencyGuids: ["hero-walk-anim"],
        },
        {
          guid: "hero-walk-anim",
          type: "Animation",
          name: "Hero_Walk",
          clipName: "Walk",
        },
      ],
    );
    expect((entries[0]!.document as { clips: Array<{ assetGuid: string; clipName: string }> }).clips[0]).toMatchObject({
      assetGuid: "hero-walk-anim",
      clipName: "Walk",
    });
  });

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

  it("skips unparsable documents", () => {
    expect(
      playAnimGraphsFromOpenDocuments(
        [
          {
            id: "anim-graph:assets/Bad.anim.babasset",
            ref: { kind: "anim-graph", path: "assets/Bad.anim.babasset" },
            content: { nope: true },
          },
        ],
        () => "x",
      ),
    ).toEqual([]);
  });
});

describe("scene-referenced Play content", () => {
  it("collects AnimationGraphComponent graphGuid values from a closed scene", () => {
    const scene = createDefaultScene();
    scene.actors.push(
      createActor("hero", "Hero", {
        components: [
          {
            id: "anim",
            classId: "AnimationGraphComponent",
            properties: { graphGuid: "loco-guid" },
          },
        ],
      }),
    );
    expect(animationGraphGuidsFromScene(scene)).toEqual(["loco-guid"]);
  });

  it("collects BehaviourTreeComponent treeGuid values from a closed scene", () => {
    const scene = createDefaultScene();
    scene.actors.push(
      createActor("guard", "Guard", {
        components: [
          {
            id: "bt",
            classId: "BehaviourTreeComponent",
            properties: { treeGuid: "tree-guid", blackboardGuid: "bb-guid" },
          },
        ],
      }),
    );
    expect(behaviourTreeGuidsFromScene(scene)).toEqual(["tree-guid"]);
    expect(blackboardGuidsFromScene(scene)).toEqual(["bb-guid"]);
  });

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

  it("loads anim graphs by guid without an open tab", () => {
    const graph = createDefaultAnimGraph("Loco");
    expect(
      playAnimGraphsFromGuids(["loco-guid"], (guid) =>
        guid === "loco-guid" ? graph : null,
      ),
    ).toEqual([{ guid: "loco-guid", document: graph }]);
  });

  it("merges open-tab graphs with scene-referenced graphs by guid", () => {
    const open = createDefaultAnimGraph("Open");
    const scene = createDefaultAnimGraph("Scene");
    expect(
      mergePlayAnimGraphs(
        [{ guid: "open", document: open }],
        [{ guid: "scene", document: scene }],
      ),
    ).toEqual([
      { guid: "open", document: open },
      { guid: "scene", document: scene },
    ]);
  });

  it("maps sprite guids to payloads for Play UV seeks", () => {
    const payload = createDefaultSpritePayload();
    const map = playSpritePayloadsFromGuids(["hero-sprite"], (guid) =>
      guid === "hero-sprite" ? payload : null,
    );
    expect(map.get("hero-sprite")).toEqual(payload);
  });

  it("collects Sprite Animation guids from loaded anim graphs", () => {
    const graph = createDefaultAnimGraph("Loco");
    graph.clips[0] = {
      id: "idle-clip",
      kind: "sprite",
      assetGuid: "walk-anim",
      clipName: "",
      durationMs: 250,
    };
    expect(
      spriteAnimationGuidsFromAnimGraphs([{ guid: "loco", document: graph }]),
    ).toEqual(["walk-anim"]);
  });

  it("collects Sprite Animation guids from BT Play Animation tasks", () => {
    const tree = createDefaultBehaviourTree("Guard");
    const task = tree.nodes.find((node) => node.kind === "task");
    expect(task).toBeTruthy();
    task!.classId = "bt.task.playAnimation";
    task!.properties = {
      clipKind: "sprite",
      clipAssetGuid: "idle-1",
    };
    expect(
      spriteAnimationGuidsFromBehaviourTrees([{ guid: "tree-1", document: tree }]),
    ).toEqual(["idle-1"]);
  });

  it("maps Sprite Animation guids to payloads and ignores Sprite atlas documents", () => {
    const animation = createDefaultSpriteAnimationPayload();
    animation.frames[0]!.textureGuid = "tex-walk";
    const map = playSpriteAnimationPayloadsFromGuids(
      ["walk-anim", "hero-sprite"],
      (guid) =>
        guid === "walk-anim" ? animation : createDefaultSpritePayload(),
    );
    expect(map.get("walk-anim")).toEqual(animation);
    expect(map.has("hero-sprite")).toBe(false);
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
    };
    const cooked = cookPlayComplexMeshes(
      new Map([["hero-model", buildBoxGlbFixture(1)]]),
      new Map([["hero-model", payload]]),
    );
    expect(cooked.get("hero-model")?.vertices.length).toBeGreaterThanOrEqual(3);
    expect(
      playLoadModelsControl(new Map([["hero-model", payload]]), cooked),
    ).toMatchObject({
      type: "loadModels",
      models: [{ guid: "hero-model", document: payload }],
    });
    expect(playLoadModelsControl(new Map())).toBeNull();
  });

  it("collects tileset guids from loaded tilemaps", () => {
    const tilemap = {
      ...createDefaultTilemapPayload(),
      tilesetGuid: "overworld-set",
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
    expect(materialClosureFromGuids(guids, (guid) => docs[guid] ?? null)).toEqual({
      materials: ["mat-rock", "pp-blur"],
      functions: ["fn-tint", "fn-inner"],
      textures: ["tex-albedo", "tex-lut"],
    });
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
});

describe("readPlayNavmeshBytes", () => {
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
  it("collects SceneLayer guids from every Play-library scene spawn list", () => {
    const main = createDefaultScene();
    main.settings.sceneLayers = [
      { assetGuid: "hud", zOrder: 0, enabled: true },
      { assetGuid: "pause", zOrder: 1, enabled: false },
    ];
    const other = createDefaultScene();
    other.settings.sceneLayers = [
      { assetGuid: "hud", zOrder: 2, enabled: true },
      { assetGuid: "minimap", zOrder: 3, enabled: true },
    ];
    expect(sceneLayerGuidsFromScenes([main, other])).toEqual([
      "hud",
      "pause",
      "minimap",
    ]);
  });

  it("collects SceneLayer guids from Create Scene Layer pin defaults, including function graphs", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "create",
          type: "scene-layer.create",
          position: { x: 0, y: 0 },
          data: { properties: { "default:asset": "pause-menu" } },
        },
      ],
      edges: [],
      functionGraphs: {
        fn1: {
          nodes: [
            {
              id: "create-fn",
              type: "scene-layer.create",
              position: { x: 0, y: 0 },
              data: { "default:asset": "inventory" },
            },
          ],
          edges: [],
        },
      },
    };
    expect(sceneLayerGuidsFromGraphs([graph])).toEqual([
      "pause-menu",
      "inventory",
    ]);
  });

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
    const scenes = overlayEditorScenesFromLayers([
      { guid: "hud", layer },
    ]);
    expect(scenes).toEqual([sceneLayerToEditorScene(layer)]);
    expect(overlayTextureGuidsFromScene(scenes[0])).toEqual([
      "tex-banner",
      "tex-inline",
    ]);
    expect(playFontGuidsFromScenes(scenes)).toEqual(["font-hud"]);
    expect(materialAssetGuidsFromScene(scenes[0])).toEqual(["mat-unlit"]);
    expect(spriteAssetGuidsFromScene(scenes[0])).toEqual(["sprite-hud"]);
  });

  it("collects Register Scene Layer Post-processing material pin defaults", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "pp",
          type: "scene-layer.registerPostProcess",
          position: { x: 0, y: 0 },
          data: { properties: { "default:material": "pp-blur" } },
        },
      ],
      edges: [],
    };
    expect(sceneLayerMaterialGuidsFromGraphs([graph])).toEqual(["pp-blur"]);
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
