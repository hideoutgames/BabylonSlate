import { describe, expect, it, vi } from "vitest";
import {
  createDefaultPlayHud,
  createDefaultUserInterface,
  createWidget,
  WIDGET_KINDS,
} from "@babylonslate/ui-runtime";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  createActor,
  createDefaultScene,
  ENGINE_WIDGET_KINDS,
} from "@babylonslate/core";
import {
  createDefaultSpriteAnimationPayload,
  createDefaultSpritePayload,
  createDefaultTilemapPayload,
  createDefaultTilesetPayload,
  normalizeTilemapPayload,
} from "@babylonslate/assets";
import {
  animationGraphGuidsFromScene,
  applyPlayHudInstance,
  applyPlayHudVisibility,
  asUiDocument,
  behaviourTreeGuidsFromScene,
  blackboardGuidsFromScene,
  logicGraphFromUiPayload,
  mergePlayScriptDocuments,
  filterPlayScriptDocuments,
  collectPlayScriptDocuments,
  mergePlayAnimGraphs,
  collectAnimGraphCompileDocuments,
  parsePlayHudControlId,
  playAnimGraphsFromOpenDocuments,
  playAnimGraphsFromGuids,
  playHudVisibilityKey,
  playLoadTilemapsControl,
  playUserInterfaceRuntimeDocuments,
  preferOpenPlayUiContent,
  dispatchMountedPlayUiWidgetEvent,
  setPlayUiWidgetEventSink,
  readPlayNavmeshBytes,
  readPlayAudioReverbBytes,
  playSpriteAnimationPayloadsFromGuids,
  playSpritePayloadsFromGuids,
  playLoadSpritesControl,
  playUiLibraryFromAssets,
  spriteAnimationGuidsFromAnimGraphs,
  removePlayHudInstance,
  resolvePlayHudDocuments,
  spriteAssetGuidsFromScene,
  tilemapAssetGuidsFromScene,
  tilesetGuidsFromTilemaps,
  textureGuidsFromPlayPayloads,
  modelAssetGuidsFromScene,
  modelSlotMaterialGuidsFromPayloads,
  materialAssetGuidsFromScene,
  postProcessMaterialGuidsFromScene,
  materialGuidsFromScenes,
  playSceneByGuid,
  materialClosureFromGuids,
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

  it("applies and removes instances by reference and keeps classId", () => {
    const hud = createDefaultPlayHud("HUD");
    const library = { "hud-guid": hud };
    let instances = applyPlayHudInstance(
      [],
      "ui-1",
      "hud-guid",
      "UserInterface:hud-guid",
    );
    instances = applyPlayHudInstance(
      instances,
      "ui-2",
      "hud-guid",
      "UserInterface:hud-guid",
    );
    expect(instances).toEqual([
      {
        instanceId: "ui-1",
        assetGuid: "hud-guid",
        classId: "UserInterface:hud-guid",
      },
      {
        instanceId: "ui-2",
        assetGuid: "hud-guid",
        classId: "UserInterface:hud-guid",
      },
    ]);
    expect(resolvePlayHudDocuments(instances, library)).toEqual([
      { instanceId: "ui-1", document: hud },
      { instanceId: "ui-2", document: hud },
    ]);
    instances = removePlayHudInstance(instances, "ui-1");
    expect(resolvePlayHudDocuments(instances, library).map((row) => row.instanceId)).toEqual(
      ["ui-2"],
    );
  });

  it("derives classId from the asset guid when the apply command omits it", () => {
    expect(applyPlayHudInstance([], "ui-1", "hud-guid")).toEqual([
      {
        instanceId: "ui-1",
        assetGuid: "hud-guid",
        classId: "UserInterface:hud-guid",
      },
    ]);
  });

  it("skips instances whose asset is missing from the library", () => {
    expect(
      resolvePlayHudDocuments(
        [{ instanceId: "ui-1", assetGuid: "missing", classId: "UserInterface:missing" }],
        {},
      ),
    ).toEqual([]);
  });

  it("scopes widget visibility to the owning instance", () => {
    let hidden = new Set<string>();
    hidden = applyPlayHudVisibility(hidden, "ui-1", "play-btn", false);
    hidden = applyPlayHudVisibility(hidden, "ui-2", "play-btn", false);
    expect(hidden.has(playHudVisibilityKey("ui-1", "play-btn"))).toBe(true);
    expect(hidden.has(playHudVisibilityKey("ui-2", "play-btn"))).toBe(true);
    hidden = applyPlayHudVisibility(hidden, "ui-1", "play-btn", true);
    expect(hidden.has(playHudVisibilityKey("ui-1", "play-btn"))).toBe(false);
    expect(hidden.has(playHudVisibilityKey("ui-2", "play-btn"))).toBe(true);
  });
});

describe("playUserInterfaceRuntimeDocuments", () => {
  it("builds slim widget metadata for every widget id/kind/name", () => {
    const hud = createDefaultUserInterface("HUD");
    const button = createWidget("play-btn", "Button", "Play");
    const image = createWidget("logo", "Image", "Logo");
    hud.widgets.canvas!.children = ["play-btn", "logo"];
    hud.widgets["play-btn"] = button;
    hud.widgets.logo = image;
    expect(playUserInterfaceRuntimeDocuments({ "hud-guid": hud })).toEqual([
      {
        guid: "hud-guid",
        widgets: expect.arrayContaining([
          { id: "canvas", kind: "Canvas", name: "Canvas" },
          { id: "play-btn", kind: "Button", name: "Play" },
          { id: "logo", kind: "Image", name: "Logo" },
        ]),
      },
    ]);
  });

  it("copies nestedUiGuid onto UserInterface widget metadata", () => {
    const hud = createDefaultUserInterface("HUD");
    const chip = createWidget("chip", "UserInterface", "Chip");
    chip.nestedUiGuid = "chip-guid";
    hud.widgets.canvas!.children = ["chip"];
    hud.widgets.chip = chip;
    expect(
      playUserInterfaceRuntimeDocuments({ "hud-guid": hud })[0]?.widgets.find(
        (widget) => widget.id === "chip",
      ),
    ).toEqual({
      id: "chip",
      kind: "UserInterface",
      name: "Chip",
      nestedUiGuid: "chip-guid",
    });
  });

  it("does not invent an apply command or mount instances", () => {
    const library = { "hud-guid": createDefaultUserInterface("HUD") };
    expect(playUserInterfaceRuntimeDocuments(library)[0]?.guid).toBe("hud-guid");
    expect(resolvePlayHudDocuments([], library)).toEqual([]);
  });
});

describe("preferOpenPlayUiContent", () => {
  it("lets an open in-memory document win over disk bytes", () => {
    const open = createDefaultUserInterface("Open");
    open.widgets.canvas!.name = "Live Canvas";
    const disk = createDefaultUserInterface("Disk");
    expect(preferOpenPlayUiContent(open, disk)).toBe(open);
    expect(preferOpenPlayUiContent(null, disk)).toBe(disk);
    expect(preferOpenPlayUiContent(undefined, null)).toBeNull();
  });
});

describe("mounted Play UI widget event sink", () => {
  it("forwards events after the test host object is replaced", () => {
    const sink = vi.fn(() => true);
    setPlayUiWidgetEventSink(sink);
    const host: {
      dispatchPlayUiWidgetEvent?: (event: {
        instanceId: string;
        widgetId: string;
        kind: "click";
      }) => boolean;
    } = {};
    host.dispatchPlayUiWidgetEvent = (event) =>
      dispatchMountedPlayUiWidgetEvent(event);
    const replaced: typeof host = {};
    replaced.dispatchPlayUiWidgetEvent = (event) =>
      dispatchMountedPlayUiWidgetEvent(event);
    expect(
      replaced.dispatchPlayUiWidgetEvent({
        instanceId: "ui-1",
        widgetId: "play-btn",
        kind: "click",
      }),
    ).toBe(true);
    expect(sink).toHaveBeenCalledWith({
      instanceId: "ui-1",
      widgetId: "play-btn",
      kind: "click",
    });
    setPlayUiWidgetEventSink(null);
    expect(
      replaced.dispatchPlayUiWidgetEvent({
        instanceId: "ui-1",
        widgetId: "play-btn",
        kind: "click",
      }),
    ).toBe(false);
  });
});

describe("parsePlayHudControlId", () => {
  it("strips the instance prefix and keeps nested widget ids", () => {
    expect(parsePlayHudControlId("ui-1:play-btn")).toEqual({
      instanceId: "ui-1",
      widgetId: "play-btn",
    });
    expect(parsePlayHudControlId("ui-2:host/nested-btn")).toEqual({
      instanceId: "ui-2",
      widgetId: "host/nested-btn",
    });
    expect(parsePlayHudControlId("play-btn")).toBeNull();
    expect(parsePlayHudControlId(":only-widget")).toBeNull();
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

  it("creates a Canvas root instead of leaving widgets empty", () => {
    const doc = asUiDocument({ name: "Broken" });
    expect(doc.rootId).toBe("canvas");
    expect(doc.widgets.canvas?.kind).toBe("Canvas");
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

  it("rewrites Animation clip guids to the owning Model before Play", () => {
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
      assetGuid: "hero-model",
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

  it("collects Model slot material guids for Play compile", () => {
    const payloads = new Map([
      [
        "hero",
        {
          clipNames: [],
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
          materialSlots: [{ index: 0, name: "Rock", materialGuid: "mat-rock" }],
        },
      ],
    ]);
    expect(modelSlotMaterialGuidsFromPayloads(payloads)).toEqual([
      "mat-hero",
      "mat-rock",
    ]);
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
    scene.actors[0]!.components[0]!.properties.materialGuid = "mat-rock";
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

describe("UI widget class mapping", () => {
  it("keeps engine widget kinds aligned with the UserInterface payload kinds", () => {
    expect([...ENGINE_WIDGET_KINDS]).toEqual([...WIDGET_KINDS]);
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

  it("merges UserInterface logic then strips EditorUtilityObject graphs", () => {
    const collected = collectPlayScriptDocuments(
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
      {
        "assets/Hero.class.babasset": { type: "Class", parentClass: "Actor" },
        "assets/Tools.class.babasset": {
          type: "Class",
          parentClass: "EditorUtilityObject",
        },
        "assets/HUD.ui.babasset": { type: "UserInterface", parentClass: null },
      },
      (id) =>
        id === "EditorUtilityObject" || id === "Actor" ? "BObject" : null,
    );
    expect(collected.map((doc) => doc.path)).toEqual([
      "assets/Hero.class.babasset",
      "assets/HUD.ui.babasset",
    ]);
    expect(collected[0]?.parentClassId).toBe("Actor");
  });

  it("identifies UserInterface scripts by asset guid, not the file stem", () => {
    const collected = collectPlayScriptDocuments(
      [],
      [
        {
          path: "assets/HUD.ui.babasset",
          guid: "hud-guid",
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
      {
        "assets/HUD.ui.babasset": { type: "UserInterface", parentClass: null },
      },
      () => null,
    );
    expect(collected).toEqual([
      expect.objectContaining({
        path: "assets/HUD.ui.babasset",
        classId: "UserInterface:hud-guid",
        parentClassId: "UserInterface",
      }),
    ]);
  });

  it("strips EditorUtilityInterface logic even if it is merged into the Play list", () => {
    const collected = collectPlayScriptDocuments(
      [],
      [
        {
          path: "assets/Tools.eui.babasset",
          payload: {
            logic: {
              nodes: [
                {
                  id: "start",
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
      {
        "assets/Tools.eui.babasset": {
          type: "EditorUtilityInterface",
          parentClass: null,
        },
      },
      () => null,
    );
    expect(collected).toEqual([]);
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
