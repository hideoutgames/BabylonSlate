import { describe, expect, it } from "vitest";
import type { IndexedAsset } from "@babylonslate/assets";
import { createDefaultMigrationRegistry } from "@babylonslate/assets";
import {
  CREATABLE_ASSET_TYPES,
  ENGINE_BASE_CLASSES,
  buildNewAssetResult,
  classDocumentShowsPrefab,
  collectFolderGuids,
  compressionBadgeLabel,
  contentBrowserMoveFromDrop,
  displayAssetTitle,
  filterAssets,
  flattenContentBrowserTree,
  flattenFolderTree,
  filterFolderTreeRows,
  isFolderNameTaken,
  isFolderTreeRoot,
  isNewAssetNameTaken,
  isValidMoveDestination,
  isValidSelectionMoveDestination,
  contentBrowserContextActions,
  contentBrowserMoveDialogTitle,
  contentBrowserMovePreviewName,
  guidsOutsideSelectedFolders,
  rootSelectedFolderPaths,
  listChildFolders,
  matchesAssetSearch,
  newAssetFileName,
  remapPathAfterFolderMove,
  textureCompressionState,
  visualForIndexedAsset,
  classParentLookup,
  addSelectedAssetGuid,
  addSelectedFolderPath,
  exclusiveSelectAsset,
  exclusiveSelectFolder,
  paintSelectTiles,
  resolveContentBrowserPaintHit,
  assetTypeThumbAccent,
} from "./content-browser-helpers";
import { resolveTypeVisual } from "@babylonslate/editor-kit";

function asset(
  overrides: Partial<IndexedAsset["header"]> & {
    path?: string;
    guid?: string;
    type?: string;
    name?: string;
  },
): IndexedAsset {
  return {
    rootId: "project",
    path: overrides.path ?? "assets/tex.babasset",
    header: {
      guid: overrides.guid ?? "guid-1",
      type: overrides.type ?? "Texture",
      name: overrides.name ?? "tex",
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      dependencies: [],
      parentClass: overrides.parentClass ?? null,
      payload: overrides.payload ?? {},
      chunks: [],
    },
  };
}

describe("content-browser-helpers", () => {
  it("filters by search, type, and folder guids", () => {
    const items = [
      asset({ guid: "a", name: "Hero", type: "Texture", path: "assets/a.babasset" }),
      asset({ guid: "b", name: "Main", type: "Scene", path: "assets/main.scene.babasset" }),
    ];

    expect(
      filterAssets(items, {
        folderGuids: new Set(["a"]),
        typeFilters: null,
        search: "",
      }),
    ).toHaveLength(1);

    expect(
      filterAssets(items, {
        folderGuids: null,
        typeFilters: ["Scene"],
        search: "",
      }),
    ).toHaveLength(1);

    expect(
      filterAssets(items, {
        folderGuids: null,
        typeFilters: ["Scene", "Texture"],
        search: "",
      }),
    ).toHaveLength(2);

    expect(
      filterAssets(items, {
        folderGuids: null,
        typeFilters: [],
        search: "",
      }),
    ).toHaveLength(2);

    expect(
      filterAssets(items, {
        folderGuids: null,
        typeFilters: null,
        search: "hero",
      }),
    ).toHaveLength(1);
  });

  it("matches search across name, path, and type", () => {
    const item = asset({ name: "Crate", type: "Model", path: "assets/models/crate.babasset" });
    expect(matchesAssetSearch(item, "model")).toBe(true);
    expect(matchesAssetSearch(item, "crate")).toBe(true);
    expect(matchesAssetSearch(item, "missing")).toBe(false);
  });

  it("reads texture compression badges", () => {
    const pending = asset({
      payload: { compressionState: "pending" },
    });
    expect(textureCompressionState(pending)).toBe("pending");
    expect(compressionBadgeLabel("encoding")).toBe("Encoding");
    expect(textureCompressionState(asset({ type: "Scene" }))).toBeNull();
  });

  it("strips a trailing type suffix from asset titles", () => {
    expect(displayAssetTitle("main.scene")).toBe("main");
    expect(displayAssetTitle("logic.graph")).toBe("logic");
    expect(displayAssetTitle("Hero")).toBe("Hero");
    expect(displayAssetTitle("crate.model")).toBe("crate");
  });

  it("collects only direct children unless the folder is recursive", () => {
    const tree = {
      path: "assets",
      assets: ["root"],
      children: [
        {
          path: "assets/textures",
          assets: ["child"],
          children: [
            {
              path: "assets/textures/ui",
              assets: ["nested"],
              children: [],
            },
          ],
        },
      ],
    };
    expect([...collectFolderGuids("assets/textures", tree)]).toEqual(["child"]);
    expect([...collectFolderGuids("assets", tree)]).toEqual(["root"]);
    expect([
      ...collectFolderGuids("assets/textures", tree, { recursive: true }),
    ]).toEqual(["child", "nested"]);
    expect(
      [...collectFolderGuids("assets", tree, { recursive: true })].sort(),
    ).toEqual(["child", "nested", "root"].sort());
  });

  it("lists only direct child folders of a path", () => {
    const tree = {
      name: "assets",
      path: "assets",
      assets: [],
      children: [
        {
          name: "textures",
          path: "assets/textures",
          assets: [],
          children: [
            {
              name: "ui",
              path: "assets/textures/ui",
              assets: [],
              children: [],
            },
          ],
        },
        {
          name: "fx",
          path: "assets/fx",
          assets: [],
          children: [],
        },
      ],
    };
    expect(listChildFolders(tree, "assets")).toEqual([
      { name: "textures", path: "assets/textures" },
      { name: "fx", path: "assets/fx" },
    ]);
    expect(listChildFolders(tree, "assets/textures")).toEqual([
      { name: "ui", path: "assets/textures/ui" },
    ]);
    expect(listChildFolders(tree, "assets/missing")).toEqual([]);
  });

  it("flattens folders first then assets under each parent", () => {
    const tree = {
      name: "assets",
      path: "assets",
      assets: ["hero-guid"],
      children: [
        {
          name: "textures",
          path: "assets/textures",
          assets: ["dirt-guid"],
          children: [
            {
              name: "ui",
              path: "assets/textures/ui",
              assets: ["icon-guid"],
              children: [],
            },
          ],
        },
      ],
    };
    const assets = [
      asset({
        guid: "hero-guid",
        name: "hero",
        path: "assets/hero.babasset",
      }),
      asset({
        guid: "dirt-guid",
        name: "dirt",
        path: "assets/textures/dirt.babasset",
      }),
      asset({
        guid: "icon-guid",
        name: "icon",
        path: "assets/textures/ui/icon.babasset",
      }),
    ];
    const rows = flattenContentBrowserTree(tree, assets);
    expect(rows.map((row) => ({ id: row.id, kind: row.kind, depth: row.depth }))).toEqual([
      { id: "assets", kind: "folder", depth: 0 },
      { id: "assets/textures", kind: "folder", depth: 1 },
      { id: "assets/textures/ui", kind: "folder", depth: 2 },
      { id: "assets/textures/ui/icon.babasset", kind: "asset", depth: 3 },
      { id: "assets/textures/dirt.babasset", kind: "asset", depth: 2 },
      { id: "assets/hero.babasset", kind: "asset", depth: 1 },
    ]);
    expect(rows[0]).toMatchObject({
      hasChildren: true,
      expanded: true,
      label: "assets",
    });
    expect(rows.find((row) => row.id === "assets/hero.babasset")).toMatchObject({
      kind: "asset",
      guid: "hero-guid",
      label: "hero",
      hasChildren: false,
    });
    const collapsed = flattenContentBrowserTree(
      tree,
      assets,
      new Set(["assets/textures"]),
    );
    expect(collapsed.map((row) => row.id)).toEqual([
      "assets",
      "assets/textures",
      "assets/hero.babasset",
    ]);
    expect(collapsed[1]).toMatchObject({
      hasChildren: true,
      expanded: false,
    });
  });

  it("treats a folder with only assets as having children", () => {
    const tree = {
      name: "assets",
      path: "assets",
      assets: ["hero-guid"],
      children: [],
    };
    const rows = flattenContentBrowserTree(tree, [
      asset({ guid: "hero-guid", name: "hero", path: "assets/hero.babasset" }),
    ]);
    expect(rows[0]?.hasChildren).toBe(true);
  });

  it("resolves a tree drop onto a folder or an asset parent", () => {
    const tree = {
      name: "assets",
      path: "assets",
      assets: ["hero-guid"],
      children: [
        {
          name: "textures",
          path: "assets/textures",
          assets: ["dirt-guid"],
          children: [],
        },
        {
          name: "fx",
          path: "assets/fx",
          assets: [],
          children: [],
        },
      ],
    };
    const rows = flattenContentBrowserTree(tree, [
      asset({ guid: "hero-guid", name: "hero", path: "assets/hero.babasset" }),
      asset({
        guid: "dirt-guid",
        name: "dirt",
        path: "assets/textures/dirt.babasset",
      }),
    ]);
    expect(
      contentBrowserMoveFromDrop("assets/hero.babasset", "assets/textures", rows),
    ).toEqual({
      kind: "asset",
      sourcePath: "assets",
      destinationPath: "assets/textures",
      id: "assets/hero.babasset",
      guid: "hero-guid",
    });
    expect(
      contentBrowserMoveFromDrop(
        "assets/hero.babasset",
        "assets/textures/dirt.babasset",
        rows,
      ),
    ).toEqual({
      kind: "asset",
      sourcePath: "assets",
      destinationPath: "assets/textures",
      id: "assets/hero.babasset",
      guid: "hero-guid",
    });
    expect(contentBrowserMoveFromDrop("assets/textures", "assets/fx", rows)).toEqual({
      kind: "folder",
      sourcePath: "assets/textures",
      destinationPath: "assets/fx",
      id: "assets/textures",
    });
  });

  it("rejects illegal tree drops including dragging the assets root", () => {
    const tree = {
      name: "assets",
      path: "assets",
      assets: ["hero-guid"],
      children: [
        {
          name: "textures",
          path: "assets/textures",
          assets: [],
          children: [
            {
              name: "ui",
              path: "assets/textures/ui",
              assets: [],
              children: [],
            },
          ],
        },
      ],
    };
    const rows = flattenContentBrowserTree(tree, [
      asset({ guid: "hero-guid", name: "hero", path: "assets/hero.babasset" }),
    ]);
    expect(contentBrowserMoveFromDrop("assets", "assets/textures", rows)).toBeNull();
    expect(contentBrowserMoveFromDrop("assets/textures", "assets", rows)).toBeNull();
    expect(
      contentBrowserMoveFromDrop("assets/textures", "assets/textures/ui", rows),
    ).toBeNull();
    expect(
      contentBrowserMoveFromDrop("assets/hero.babasset", "assets", rows),
    ).toBeNull();
    expect(
      contentBrowserMoveFromDrop("assets/hero.babasset", null, rows),
    ).toBeNull();
    expect(contentBrowserMoveFromDrop("missing", "assets/textures", rows)).toBeNull();
  });

  it("flattens a folder tree for the Move picker", () => {
    const tree = {
      name: "assets",
      path: "assets",
      assets: [],
      children: [
        {
          name: "textures",
          path: "assets/textures",
          assets: [],
          children: [
            {
              name: "ui",
              path: "assets/textures/ui",
              assets: [],
              children: [],
            },
          ],
        },
      ],
    };
    const rows = flattenFolderTree(tree);
    expect(rows.map((row) => row.path)).toEqual([
      "assets",
      "assets/textures",
      "assets/textures/ui",
    ]);
    expect(rows[1]).toMatchObject({
      label: "textures",
      depth: 1,
      hasChildren: true,
      expanded: true,
    });
    const collapsed = flattenFolderTree(tree, new Set(["assets/textures"]));
    expect(collapsed.map((row) => row.path)).toEqual([
      "assets",
      "assets/textures",
    ]);
  });

  it("detects a New Asset name that already exists in the folder", () => {
    const paths = [
      "assets/main.scene.babasset",
      "assets/hero.class.babasset",
      "assets/classes/hero.class.babasset",
    ];
    expect(isNewAssetNameTaken(paths, "assets", "Scene", "main")).toBe(true);
    expect(isNewAssetNameTaken(paths, "assets", "Class", "hero")).toBe(true);
    expect(isNewAssetNameTaken(paths, "assets", "Class", "crate")).toBe(false);
    expect(isNewAssetNameTaken(paths, "assets/classes", "Class", "hero")).toBe(
      true,
    );
    expect(isNewAssetNameTaken(paths, "assets/classes", "Class", "main")).toBe(
      false,
    );
  });

  it("detects a folder name that already exists under the parent", () => {
    const folders = ["assets", "assets/textures", "assets/fx"];
    expect(isFolderNameTaken(folders, "assets", "textures")).toBe(true);
    expect(isFolderNameTaken(folders, "assets", "audio")).toBe(false);
    expect(isFolderNameTaken(folders, "assets/textures", "ui")).toBe(false);
  });

  it("allows copying a folder into its current parent", () => {
    expect(
      isValidMoveDestination({
        kind: "folder",
        sourcePath: "assets/textures",
        destinationPath: "assets",
        operation: "copy",
      }),
    ).toBe(true);
    expect(
      isValidMoveDestination({
        kind: "folder",
        sourcePath: "assets/textures",
        destinationPath: "assets/textures",
        operation: "copy",
      }),
    ).toBe(false);
    expect(
      isValidMoveDestination({
        kind: "folder",
        sourcePath: "assets/textures",
        destinationPath: "assets/textures/ui",
        operation: "copy",
      }),
    ).toBe(false);
  });

  it("rejects a no-op asset move and accepts a different folder", () => {
    expect(
      isValidMoveDestination({
        kind: "asset",
        sourcePath: "assets/textures",
        destinationPath: "assets/textures",
      }),
    ).toBe(false);
    expect(
      isValidMoveDestination({
        kind: "asset",
        sourcePath: "assets/textures",
        destinationPath: "assets",
      }),
    ).toBe(true);
    expect(
      isValidMoveDestination({
        kind: "asset",
        sourcePath: "assets/textures",
        destinationPath: "assets/fx",
      }),
    ).toBe(true);
  });

  it("rejects moving a folder into itself, a descendant, or its current parent", () => {
    expect(
      isValidMoveDestination({
        kind: "folder",
        sourcePath: "assets/textures",
        destinationPath: "assets/textures",
      }),
    ).toBe(false);
    expect(
      isValidMoveDestination({
        kind: "folder",
        sourcePath: "assets/textures",
        destinationPath: "assets/textures/ui",
      }),
    ).toBe(false);
    expect(
      isValidMoveDestination({
        kind: "folder",
        sourcePath: "assets/textures",
        destinationPath: "assets",
      }),
    ).toBe(false);
    expect(
      isValidMoveDestination({
        kind: "folder",
        sourcePath: "assets/textures",
        destinationPath: "assets/fx",
      }),
    ).toBe(true);
  });

  it("keeps matching folders and their ancestors when searching the Move tree", () => {
    const tree = {
      name: "assets",
      path: "assets",
      assets: [],
      children: [
        {
          name: "textures",
          path: "assets/textures",
          assets: [],
          children: [
            {
              name: "ui",
              path: "assets/textures/ui",
              assets: [],
              children: [],
            },
          ],
        },
        {
          name: "fx",
          path: "assets/fx",
          assets: [],
          children: [],
        },
      ],
    };
    const rows = flattenFolderTree(tree);
    expect(filterFolderTreeRows(rows, "  ").map((row) => row.path)).toEqual([
      "assets",
      "assets/textures",
      "assets/textures/ui",
      "assets/fx",
    ]);
    expect(filterFolderTreeRows(rows, "ui").map((row) => row.path)).toEqual([
      "assets",
      "assets/textures",
      "assets/textures/ui",
    ]);
    expect(filterFolderTreeRows(rows, "FX").map((row) => row.path)).toEqual([
      "assets",
      "assets/fx",
    ]);
  });

  it("remaps contained paths after a folder move", () => {
    expect(
      remapPathAfterFolderMove(
        "assets/textures/ui/hero.babasset",
        "assets/textures",
        "assets/fx/textures",
      ),
    ).toBe("assets/fx/textures/ui/hero.babasset");
    expect(
      remapPathAfterFolderMove(
        "assets/fx/boom.babasset",
        "assets/textures",
        "assets/fx/textures",
      ),
    ).toBe("assets/fx/boom.babasset");
    expect(
      remapPathAfterFolderMove(
        "assets/textures",
        "assets/textures",
        "assets/fx/textures",
      ),
    ).toBe("assets/fx/textures");
  });

  it("treats the registry tree root as immovable", () => {
    expect(isFolderTreeRoot("assets")).toBe(true);
    expect(isFolderTreeRoot("assets/textures")).toBe(false);
    expect(isFolderTreeRoot("content", "content")).toBe(true);
    expect(
      isFolderTreeRoot("plugins/pack/assets", [
        "assets",
        "plugins/pack/assets",
      ]),
    ).toBe(true);
    expect(
      isFolderTreeRoot("plugins/pack/assets/actors", [
        "assets",
        "plugins/pack/assets",
      ]),
    ).toBe(false);
  });

  it("resolves Class tiles to the parent engine icon", () => {
    const hero = asset({
      type: "Class",
      name: "MyHero",
      guid: "c1",
      path: "assets/my-hero.babasset",
      parentClass: "Actor",
    });
    const parentOf = classParentLookup([hero]);
    const visual = visualForIndexedAsset(hero, parentOf);
    expect(visual.colorVar).toBe("var(--asset-class)");
    expect(visual.icon).toBe(resolveTypeVisual({ classId: "Actor" }).icon);
    expect(visual.icon).not.toBe(resolveTypeVisual({ classId: "BObject" }).icon);
  });

  it("offers BDebugCommand as a Class parent", () => {
    expect(ENGINE_BASE_CLASSES).toContain("BDebugCommand");
  });

  it("offers EditorUtilityObject as a Class parent", () => {
    expect(ENGINE_BASE_CLASSES).toContain("EditorUtilityObject");
  });

  it("offers behaviour-tree bases as Class parents", () => {
    expect(ENGINE_BASE_CLASSES).toContain("BTTask");
    expect(ENGINE_BASE_CLASSES).toContain("BTDecorator");
    expect(ENGINE_BASE_CLASSES).toContain("BTService");
    expect(ENGINE_BASE_CLASSES).toContain("BTComposite");
  });

  it("seeds P9 document assets with typed suffixes", () => {
    expect(newAssetFileName("UserInterface", "HUD")).toBe("HUD.ui.babasset");
    expect(newAssetFileName("Sprite", "Hero")).toBe("Hero.sprite.babasset");
    expect(newAssetFileName("AnimationGraph", "Loco")).toBe("Loco.anim.babasset");
    expect(newAssetFileName("Shader", "Surface")).toBe("Surface.shader.babasset");
    expect(newAssetFileName("Class", "Hero")).toBe("Hero.class.babasset");
    expect(newAssetFileName("Tileset", "Ground")).toBe(
      "Ground.tileset.babasset",
    );
    expect(newAssetFileName("Tilemap", "Overworld")).toBe(
      "Overworld.tilemap.babasset",
    );
    expect(newAssetFileName("BehaviourTree", "Patrol")).toBe(
      "Patrol.bt.babasset",
    );
    expect(newAssetFileName("Blackboard", "Guard")).toBe(
      "Guard.blackboard.babasset",
    );
    expect(newAssetFileName("EditorUtilityInterface", "SceneTools")).toBe(
      "SceneTools.eui.babasset",
    );
    expect(newAssetFileName("Scene", "")).toBe("");
    expect(newAssetFileName("Scene", "   ")).toBe("");
    expect(isNewAssetNameTaken(["assets/NewAsset.scene.babasset"], "assets", "Scene", "")).toBe(
      false,
    );
    const tileset = buildNewAssetResult({
      type: "Tileset",
      name: "Ground",
      guid: "ts-1",
      parentClass: null,
    });
    expect(tileset.type).toBe("Tileset");
    expect(tileset.payload.tileWidth).toBe(16);
    expect(tileset.chunks.some((chunk) => chunk.id === "document")).toBe(true);
    const tilemap = buildNewAssetResult({
      type: "Tilemap",
      name: "Overworld",
      guid: "tm-1",
      parentClass: null,
    });
    expect(tilemap.type).toBe("Tilemap");
    expect(tilemap.payload.chunkSize).toBe(32);
    const hud = buildNewAssetResult({
      type: "UserInterface",
      name: "HUD",
      guid: "ui-1",
      parentClass: null,
    });
    expect(hud.type).toBe("UserInterface");
    expect(hud.version).toBe(2);
    expect(hud.payload.rootId).toBe("canvas");
    expect(hud.payload.viewportLayer).toBe(true);
    expect(Object.keys(hud.payload.widgets as object).sort()).toEqual(["canvas"]);
    expect(
      (hud.payload.widgets as { canvas: { children: string[] } }).canvas.children,
    ).toEqual([]);
    expect(hud.chunks.some((chunk) => chunk.id === "document")).toBe(true);
  });

  it("seeds BehaviourTree and Blackboard New Asset documents", () => {
    const tree = buildNewAssetResult({
      type: "BehaviourTree",
      name: "Patrol",
      guid: "bt-1",
      parentClass: null,
    });
    expect(tree.type).toBe("BehaviourTree");
    expect(tree.payload.rootId).toBe("root");
    expect(
      (tree.payload.nodes as Array<{ kind: string }>).map((node) => node.kind),
    ).toEqual(["selector", "sequence", "task"]);
    const board = buildNewAssetResult({
      type: "Blackboard",
      name: "Guard",
      guid: "bb-1",
      parentClass: null,
    });
    expect(board.type).toBe("Blackboard");
    expect(Array.isArray(board.payload.keys)).toBe(true);
  });

  it("lists only authored types in New Asset", () => {
    expect([...CREATABLE_ASSET_TYPES]).toEqual([
      "Scene",
      "Class",
      "UserInterface",
      "Sprite",
      "AnimationGraph",
      "Shader",
      "Tileset",
      "Tilemap",
      "BehaviourTree",
      "Blackboard",
      "Enum",
      "Structure",
      "ScriptInterface",
      "EditorUtilityInterface",
    ]);
  });

  it("creates Class assets with a logic graph and parent class", () => {
    const klass = buildNewAssetResult({
      type: "Class",
      name: "Hero",
      guid: "class-1",
      parentClass: "Actor",
    });
    expect(klass.type).toBe("Class");
    expect(klass.parentClass).toBe("Actor");
    expect(Array.isArray(klass.payload.nodes)).toBe(true);
    expect((klass.payload.nodes as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(klass.payload.edges)).toBe(true);
    expect(klass.chunks.some((chunk) => chunk.id === "document")).toBe(true);
  });

  it("creates EditorUtilityInterface assets with UserInterface payload and dockKind", () => {
    const eui = buildNewAssetResult({
      type: "EditorUtilityInterface",
      name: "SceneTools",
      guid: "eui-1",
      parentClass: null,
    });
    expect(eui.type).toBe("EditorUtilityInterface");
    expect(eui.payload.dockKind).toBe("scene");
    expect(eui.payload.rootId).toBeTruthy();
    expect(eui.payload.widgets).toBeTruthy();
  });

  it("seeds a BTDecorator class with On Evaluate instead of Begin Play", () => {
    const klass = buildNewAssetResult({
      type: "Class",
      name: "Alert",
      guid: "class-2",
      parentClass: "BTDecorator",
    });
    const types = (klass.payload.nodes as Array<{ type?: string }>).map(
      (node) => node.type,
    );
    expect(types).toContain("bt.event.evaluate");
    expect(types).not.toContain("flow.event.beginPlay");
  });

  it("writes new Scene assets at the current migration schema version", () => {
    const scene = buildNewAssetResult({
      type: "Scene",
      name: "Arena",
      guid: "scene-1",
      parentClass: null,
    });
    expect(scene.type).toBe("Scene");
    expect(scene.version).toBe(
      createDefaultMigrationRegistry().currentVersion("Scene"),
    );
  });

  it("shows Prefab only for Actor-lineage classes", () => {
    const hero = asset({
      type: "Class",
      name: "MyHero",
      parentClass: "Actor",
    });
    const stats = asset({
      type: "Class",
      name: "GameStats",
      parentClass: "BObject",
    });
    const meshComp = asset({
      type: "Class",
      name: "MyMesh",
      parentClass: "ActorComponent",
    });
    const subclass = asset({
      type: "Class",
      name: "Boss",
      parentClass: "MyHero",
    });
    const parentOf = classParentLookup([hero, stats, meshComp, subclass]);
    expect(classDocumentShowsPrefab("Actor", parentOf)).toBe(true);
    expect(classDocumentShowsPrefab("MyHero", parentOf)).toBe(true);
    expect(classDocumentShowsPrefab("Boss", parentOf)).toBe(true);
    expect(classDocumentShowsPrefab("BObject", parentOf)).toBe(false);
    expect(classDocumentShowsPrefab("GameStats", parentOf)).toBe(false);
    expect(classDocumentShowsPrefab("ActorComponent", parentOf)).toBe(false);
    expect(classDocumentShowsPrefab("MyMesh", parentOf)).toBe(false);
    expect(
      classDocumentShowsPrefab(null, parentOf, { assetType: "Graph" }),
    ).toBe(true);
  });

  it("adds a guid to the Content Browser selection without replacing others", () => {
    const selected = addSelectedAssetGuid(new Set(["scene-1"]), "class-1");
    expect([...selected]).toEqual(["scene-1", "class-1"]);
  });

  it("adds a folder path to the Content Browser selection without replacing others", () => {
    const selected = addSelectedFolderPath(new Set(["assets/fx"]), "assets/textures");
    expect([...selected]).toEqual(["assets/fx", "assets/textures"]);
  });

  it("does not drop a guid that is already selected", () => {
    const current = new Set(["scene-1"]);
    const selected = addSelectedAssetGuid(current, "scene-1");
    expect([...selected]).toEqual(["scene-1"]);
    expect(selected).not.toBe(current);
  });

  it("replaces the Content Browser selection with a single asset tap", () => {
    const selected = exclusiveSelectAsset("class-1");
    expect([...selected.guids]).toEqual(["class-1"]);
    expect([...selected.folderPaths]).toEqual([]);
  });

  it("replaces the Content Browser selection with a single folder tap", () => {
    const selected = exclusiveSelectFolder("assets/fx");
    expect([...selected.guids]).toEqual([]);
    expect([...selected.folderPaths]).toEqual(["assets/fx"]);
  });

  it("paints a union of assets and folders dragged over, ignoring prior selection", () => {
    const selected = paintSelectTiles([
      { kind: "asset", guid: "scene-1" },
      { kind: "folder", path: "assets/fx" },
      { kind: "asset", guid: "class-1" },
      { kind: "asset", guid: "scene-1" },
    ]);
    expect([...selected.guids]).toEqual(["scene-1", "class-1"]);
    expect([...selected.folderPaths]).toEqual(["assets/fx"]);
  });

  it("resolves a paint hit from an asset or folder tile element", () => {
    const assetTile = document.createElement("button");
    assetTile.setAttribute("data-asset-guid", "hero-1");
    const inner = document.createElement("span");
    assetTile.append(inner);
    expect(resolveContentBrowserPaintHit(inner)).toEqual({
      kind: "asset",
      guid: "hero-1",
    });

    const folderTile = document.createElement("button");
    folderTile.setAttribute("data-folder-path", "assets/fx");
    expect(resolveContentBrowserPaintHit(folderTile)).toEqual({
      kind: "folder",
      path: "assets/fx",
    });
    expect(resolveContentBrowserPaintHit(document.createElement("div"))).toBeNull();
  });

  it("re-exports an inset thumb type outline", () => {
    const accent = assetTypeThumbAccent("var(--asset-texture)");
    expect(accent.border).toBe("2px solid var(--asset-texture)");
    expect(accent.borderTopLeftRadius).toBe("calc(var(--radius-xl) - 2px)");
    expect(accent.borderTopRightRadius).toBe("calc(var(--radius-xl) - 2px)");
    expect("boxShadow" in accent).toBe(false);
    expect("backgroundImage" in accent).toBe(false);
  });

  it("intersects tile menu actions by selection counts", () => {
    expect(
      contentBrowserContextActions({ assetCount: 1, folderCount: 0 }),
    ).toEqual([
      "duplicate",
      "rename",
      "move",
      "copy",
      "show-references",
      "delete",
    ]);
    expect(
      contentBrowserContextActions({ assetCount: 2, folderCount: 0 }),
    ).toEqual(["duplicate", "move", "copy", "delete"]);
    expect(
      contentBrowserContextActions({ assetCount: 0, folderCount: 1 }),
    ).toEqual(["duplicate", "rename", "move", "copy", "delete"]);
    expect(
      contentBrowserContextActions({ assetCount: 1, folderCount: 1 }),
    ).toEqual(["duplicate", "move", "copy", "delete"]);
    expect(
      contentBrowserContextActions({ assetCount: 0, folderCount: 0 }),
    ).toEqual([]);
  });

  it("rejects a move destination that is any selected folder or a descendant", () => {
    expect(
      isValidSelectionMoveDestination({
        destinationPath: "assets/fx",
        folderSourcePaths: ["assets/textures", "assets/audio"],
        assetSourcePaths: ["assets"],
      }),
    ).toBe(true);
    expect(
      isValidSelectionMoveDestination({
        destinationPath: "assets/textures",
        folderSourcePaths: ["assets/textures", "assets/audio"],
      }),
    ).toBe(false);
    expect(
      isValidSelectionMoveDestination({
        destinationPath: "assets/textures/ui",
        folderSourcePaths: ["assets/textures"],
      }),
    ).toBe(false);
    expect(
      isValidSelectionMoveDestination({
        destinationPath: "assets",
        operation: "move",
        folderSourcePaths: ["assets/textures"],
      }),
    ).toBe(false);
    expect(
      isValidSelectionMoveDestination({
        destinationPath: "assets",
        operation: "copy",
        folderSourcePaths: ["assets/textures"],
        assetSourcePaths: ["assets"],
      }),
    ).toBe(true);
  });

  it("titles the move dialog for one item vs many", () => {
    expect(
      contentBrowserMoveDialogTitle({
        operation: "move",
        itemCount: 1,
        folderCount: 0,
        assetCount: 1,
      }),
    ).toBe("Move Asset");
    expect(
      contentBrowserMoveDialogTitle({
        operation: "copy",
        itemCount: 1,
        folderCount: 1,
        assetCount: 0,
      }),
    ).toBe("Copy Folder");
    expect(
      contentBrowserMoveDialogTitle({
        operation: "move",
        itemCount: 3,
        folderCount: 1,
        assetCount: 2,
      }),
    ).toBe("Move 3 items");
    expect(contentBrowserMovePreviewName(["hero"])).toBe("hero");
    expect(contentBrowserMovePreviewName(["hero", "fx", "albedo"])).toBe(
      "3 items",
    );
  });

  it("drops selected assets that already live under a selected folder", () => {
    expect(
      guidsOutsideSelectedFolders(
        ["tex-1", "scene-1"],
        ["assets/textures"],
        (guid) =>
          guid === "tex-1"
            ? "assets/textures/albedo.babasset"
            : "assets/main.scene.babasset",
      ),
    ).toEqual(["scene-1"]);
    expect(
      rootSelectedFolderPaths([
        "assets/textures",
        "assets/textures/ui",
        "assets/fx",
      ]),
    ).toEqual(["assets/textures", "assets/fx"]);
  });
});
