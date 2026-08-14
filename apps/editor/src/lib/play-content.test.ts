import { describe, expect, it } from "vitest";
import { createDefaultPlayHud } from "@babylonslate/ui-runtime";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import { createActor, createDefaultScene } from "@babylonslate/core";
import {
  createDefaultSpritePayload,
  createDefaultTilemapPayload,
  createDefaultTilesetPayload,
} from "@babylonslate/assets";
import {
  animationGraphGuidsFromScene,
  applyPlayHudInstance,
  asUiDocument,
  behaviourTreeGuidsFromScene,
  blackboardGuidsFromScene,
  logicGraphFromUiPayload,
  mergePlayScriptDocuments,
  filterPlayScriptDocuments,
  mergePlayAnimGraphs,
  playAnimGraphsFromOpenDocuments,
  playAnimGraphsFromGuids,
  playLoadTilemapsControl,
  readPlayNavmeshBytes,
  playSpritePayloadsFromGuids,
  playUiLibraryFromAssets,
  removePlayHudInstance,
  resolvePlayHudDocuments,
  spriteAssetGuidsFromScene,
  tilemapAssetGuidsFromScene,
  tilesetGuidsFromTilemaps,
  textureGuidsFromPlayPayloads,
  modelAssetGuidsFromScene,
} from "./play-content";

describe("playUiLibraryFromAssets", () => {
  it("indexes UserInterface assets by guid and ignores other types", () => {
    const hud = createDefaultPlayHud("Score");
    hud.widgets.header!.props.text = "Authored";
    const library = playUiLibraryFromAssets(
      [
        {
          guid: "hud-guid",
          path: "assets/HUD.ui.babasset",
          type: "UserInterface",
        },
        {
          guid: "font-guid",
          path: "assets/Display.babasset",
          type: "Font",
        },
        {
          guid: "eui-guid",
          path: "assets/Tools.eui.babasset",
          type: "EditorUtilityInterface",
        },
      ],
      (path) => (path.endsWith("HUD.ui.babasset") ? hud : null),
    );
    expect(library["hud-guid"]?.widgets.header?.props.text).toBe("Authored");
    expect(library["font-guid"]).toBeUndefined();
    expect(library["eui-guid"]).toBeUndefined();
  });
});

describe("Play HUD instances", () => {
  it("does not apply any UserInterface until a graph asks", () => {
    expect(resolvePlayHudDocuments([], { "hud-guid": createDefaultPlayHud() })).toEqual(
      [],
    );
  });

  it("applies and removes instances by reference", () => {
    const hud = createDefaultPlayHud("HUD");
    const library = { "hud-guid": hud };
    let instances = applyPlayHudInstance([], "ui-1", "hud-guid");
    instances = applyPlayHudInstance(instances, "ui-2", "hud-guid");
    expect(resolvePlayHudDocuments(instances, library)).toEqual([
      { instanceId: "ui-1", document: hud },
      { instanceId: "ui-2", document: hud },
    ]);
    instances = removePlayHudInstance(instances, "ui-1");
    expect(resolvePlayHudDocuments(instances, library).map((row) => row.instanceId)).toEqual(
      ["ui-2"],
    );
  });

  it("skips instances whose asset is missing from the library", () => {
    expect(
      resolvePlayHudDocuments([{ instanceId: "ui-1", assetGuid: "missing" }], {}),
    ).toEqual([]);
  });
});

describe("asUiDocument", () => {
  it("reads desired size from the payload", () => {
    const doc = asUiDocument({
      name: "Chip",
      rootId: "canvas",
      desiredSize: { width: 240, height: 64 },
      widgets: {},
    });
    expect(doc.desiredSize).toEqual({ width: 240, height: 64 });
  });

  it("migrates legacy RectTransform widgets to Babylon layout", () => {
    const doc = asUiDocument({
      name: "HUD",
      rootId: "canvas",
      widgets: {
        canvas: {
          id: "canvas",
          kind: "Canvas",
          name: "Canvas",
          layout: {
            anchorMin: { x: 0, y: 0 },
            anchorMax: { x: 1, y: 1 },
            offsetMin: { x: 0, y: 0 },
            offsetMax: { x: 0, y: 0 },
            pivot: { x: 0.5, y: 0.5 },
          },
          visible: true,
          children: ["stick"],
          style: {},
          props: {},
        },
        stick: {
          id: "stick",
          kind: "TouchJoystick",
          name: "Stick",
          layout: {
            anchorMin: { x: 0.5, y: 0.5 },
            anchorMax: { x: 0.5, y: 0.5 },
            offsetMin: { x: -80, y: -80 },
            offsetMax: { x: 80, y: 80 },
            pivot: { x: 0.5, y: 0.5 },
          },
          visible: true,
          children: [],
          style: {},
          props: {},
        },
      },
    });
    expect(doc.widgets.stick?.layout.horizontalAlignment).toBe("center");
    expect(doc.widgets.stick?.layout.width).toBe(160);
  });

  it("falls back desired size to design resolution when omitted", () => {
    const doc = asUiDocument({
      designResolution: { width: 1920, height: 1080 },
      widgets: {},
    });
    expect(doc.desiredSize).toEqual({ width: 1920, height: 1080 });
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

  it("collects tileset guids from loaded tilemaps", () => {
    const tilemap = {
      ...createDefaultTilemapPayload(),
      tilesetGuid: "overworld-set",
    };
    expect(tilesetGuidsFromTilemaps(new Map([["overworld", tilemap]]))).toEqual([
      "overworld-set",
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
});

describe("UI logic Play compile", () => {
  it("extracts a UserInterface payload.logic graph for Play", () => {
    const logic = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    expect(
      logicGraphFromUiPayload("assets/HUD.ui.babasset", { logic }),
    ).toEqual({
      path: "assets/HUD.ui.babasset",
      content: logic,
    });
    expect(logicGraphFromUiPayload("assets/HUD.ui.babasset", {})).toBeNull();
  });

  it("merges UI logic graphs onto the Class graph set", () => {
    const classGraph = {
      path: "assets/Hero.class.babasset",
      content: { nodes: [], edges: [] },
    };
    const merged = mergePlayScriptDocuments(
      [classGraph],
      [
        {
          path: "assets/HUD.ui.babasset",
          payload: {
            logic: {
              nodes: [
                {
                  id: "begin",
                  type: "flow.event.beginPlay",
                  position: { x: 0, y: 0 },
                  data: {},
                },
              ],
              edges: [],
            },
          },
        },
      ],
    );
    expect(merged.map((doc) => doc.path)).toEqual([
      "assets/Hero.class.babasset",
      "assets/HUD.ui.babasset",
    ]);
  });

  it("drops EditorUtilityObject class graphs from Play compile", () => {
    const filtered = filterPlayScriptDocuments(
      [
        {
          path: "assets/Hero.class.babasset",
          content: { nodes: [], edges: [] },
        },
        {
          path: "assets/Tools.class.babasset",
          content: { nodes: [], edges: [] },
        },
      ],
      {
        "assets/Hero.class.babasset": { type: "Class", parentClass: "Actor" },
        "assets/Tools.class.babasset": {
          type: "Class",
          parentClass: "EditorUtilityObject",
        },
      },
      (id) =>
        id === "EditorUtilityObject" || id === "Actor" ? "BObject" : null,
    );
    expect(filtered.map((doc) => doc.path)).toEqual([
      "assets/Hero.class.babasset",
    ]);
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
