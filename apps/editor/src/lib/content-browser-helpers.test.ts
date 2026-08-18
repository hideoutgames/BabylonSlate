import { describe, expect, it } from "vitest";
import type { IndexedAsset } from "@babylonslate/assets";
import { createDefaultMigrationRegistry } from "@babylonslate/assets";
import {
  CREATABLE_ASSET_TYPES,
  CREATABLE_ASSET_TYPE_GROUPS,
  ENGINE_BASE_CLASSES,
  buildParentClassTreeRows,
  creatableAssetTypeDescription,
  creatableAssetTypeLabel,
  filterCreatableAssetTypes,
  isContentBrowserEmptyGridDoubleClickTarget,
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
  contentBrowserDeleteListNames,
  contentBrowserDeletingGuids,
  lastSceneClassDeleteLines,
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
  materialAssetDependencies,
  assetHeaderDependencies,
  materialHeaderMeta,
  isPostProcessMaterialAsset,
  isPostProcessMaterialForPicker,
  classIdFromClassAsset,
  classParentLookup,
  addSelectedAssetGuid,
  addSelectedFolderPath,
  exclusiveSelectAsset,
  exclusiveSelectFolder,
  paintSelectTiles,
  resolveContentBrowserPaintHit,
  applyContentBrowserTreeSelect,
  type ContentBrowserTreeRow,
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
    expect(visual.colorVar).toBe("var(--asset-animation)");
    expect(visual.icon).toBe(resolveTypeVisual({ classId: "Actor" }).icon);
    expect(visual.icon).not.toBe(resolveTypeVisual({ classId: "BObject" }).icon);
  });

  it("looks up Class parents by compile id when the header name still has a type suffix", () => {
    const parentOf = classParentLookup([
      {
        path: "assets/main.class.babasset",
        header: { type: "Class", name: "main.class", parentClass: "Actor" },
      },
    ]);
    expect(parentOf("main")).toBe("Actor");
    expect(parentOf("main.class")).toBe("Actor");
  });

  it("parents a project UserInterface class id under UserInterface", () => {
    const parentOf = classParentLookup([
      {
        header: {
          type: "UserInterface",
          name: "HUD",
          guid: "hud-guid",
        },
      },
    ]);
    expect(parentOf("UserInterface:hud-guid")).toBe("UserInterface");
  });

  it("uses the compile class id for a Class asset named main.class", () => {
    expect(
      classIdFromClassAsset({
        path: "assets/main.class.babasset",
        header: { type: "Class", name: "main.class", parentClass: "Actor" },
      }),
    ).toBe("main");
    expect(
      classIdFromClassAsset({
        header: { type: "Class", name: "main.class", parentClass: "Actor" },
      }),
    ).toBe("main");
  });

  it("offers BDebugCommand as a Class parent", () => {
    expect(ENGINE_BASE_CLASSES).toContain("BDebugCommand");
  });

  it("offers EditorUtilityObject as a Class parent", () => {
    expect(ENGINE_BASE_CLASSES).toContain("EditorUtilityObject");
  });

  it("offers EditorFunctionLibrary as a Class parent", () => {
    expect(ENGINE_BASE_CLASSES).toContain("EditorFunctionLibrary");
  });

  it("offers behaviour-tree bases as Class parents", () => {
    expect(ENGINE_BASE_CLASSES).toContain("BTTask");
    expect(ENGINE_BASE_CLASSES).toContain("BTDecorator");
    expect(ENGINE_BASE_CLASSES).toContain("BTService");
    expect(ENGINE_BASE_CLASSES).toContain("BTComposite");
  });

  it("builds a searchable Parent Class tree with project Classes nested", () => {
    const rows = buildParentClassTreeRows([
      {
        path: "assets/Hero.class.babasset",
        header: { type: "Class", name: "Hero", parentClass: "Actor" },
      },
      {
        path: "plugins/pack/assets/PackActor.class.babasset",
        header: { type: "Class", name: "PackActor", parentClass: "Actor" },
      },
    ]);
    const hero = rows.find((row) => row.id === "Hero");
    const pack = rows.find((row) => row.id === "PackActor");
    const actor = rows.find((row) => row.id === "Actor");
    expect(actor?.depth).toBe(1);
    expect(hero?.depth).toBe(2);
    expect(hero?.group).toBe("Project");
    expect(pack?.group).toBe("Project");
    const filtered = buildParentClassTreeRows(
      [
        {
          path: "assets/Hero.class.babasset",
          header: { type: "Class", name: "Hero", parentClass: "Actor" },
        },
      ],
      { search: "hero" },
    );
    expect(filtered.map((row) => row.id)).toEqual(
      expect.arrayContaining(["BObject", "Actor", "Hero"]),
    );
    expect(filtered.some((row) => row.id === "GameInstance")).toBe(false);
  });

  it("seeds P9 document assets with typed suffixes", () => {
    expect(newAssetFileName("UserInterface", "HUD")).toBe("HUD.ui.babasset");
    expect(newAssetFileName("Sprite", "Hero")).toBe("Hero.sprite.babasset");
    expect(newAssetFileName("SpriteAnimation", "Walk")).toBe(
      "Walk.spriteanim.babasset",
    );
    expect(newAssetFileName("AnimationGraph", "Loco")).toBe("Loco.anim.babasset");
    expect(newAssetFileName("Material", "Rock")).toBe("Rock.material.babasset");
    expect(newAssetFileName("MaterialFunction", "Tint")).toBe(
      "Tint.matfunc.babasset",
    );
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
    expect(newAssetFileName("AudioMixer", "Master")).toBe(
      "Master.mixer.babasset",
    );
    expect(newAssetFileName("AudioChannel", "SFX")).toBe("SFX.channel.babasset");
    expect(newAssetFileName("SoundAttenuation", "Near")).toBe(
      "Near.atten.babasset",
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
    expect(
      (hud.payload.logic as { nodes: Array<{ type: string }> }).nodes.map(
        (node) => node.type,
      ),
    ).toEqual([]);
    expect(Object.keys(hud.payload.widgets as object).sort()).toEqual(["canvas"]);
    expect(
      (hud.payload.widgets as { canvas: { children: string[] } }).canvas.children,
    ).toEqual([]);
    expect(hud.chunks.some((chunk) => chunk.id === "document")).toBe(true);
  });

  it("seeds Sprite Animation New Asset documents", () => {
    const walk = buildNewAssetResult({
      type: "SpriteAnimation",
      name: "Walk",
      guid: "sa-1",
      parentClass: null,
    });
    expect(walk.type).toBe("SpriteAnimation");
    expect(walk.payload.frames).toEqual([
      expect.objectContaining({
        textureGuid: "",
        durationMs: 100,
        pivot: { x: 0.5, y: 0.5 },
        collision: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ]);
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

  it("seeds AudioMixer, AudioChannel, and SoundAttenuation New Asset documents", () => {
    const mixer = buildNewAssetResult({
      type: "AudioMixer",
      name: "Master",
      guid: "mix-1",
      parentClass: null,
    });
    expect(mixer.type).toBe("AudioMixer");
    expect(mixer.payload).toEqual({ globalVolume: 1, channels: [] });
    const channel = buildNewAssetResult({
      type: "AudioChannel",
      name: "SFX",
      guid: "ch-1",
      parentClass: null,
    });
    expect(channel.type).toBe("AudioChannel");
    expect(channel.payload).toMatchObject({
      parentChannelGuid: null,
      effects: [{ kind: "environmentReverb", enabled: false }],
    });
    const atten = buildNewAssetResult({
      type: "SoundAttenuation",
      name: "Near",
      guid: "att-1",
      parentClass: null,
    });
    expect(atten.type).toBe("SoundAttenuation");
    expect(atten.payload).toMatchObject({
      innerRadius: 1,
      maxRadius: 50,
      distanceModel: "linear",
    });
  });

  it("lists only authored types in New Asset", () => {
    expect([...CREATABLE_ASSET_TYPES]).toEqual([
      "Scene",
      "Class",
      "UserInterface",
      "Sprite",
      "SpriteAnimation",
      "AnimationGraph",
      "Material",
      "MaterialFunction",
      "Tileset",
      "Tilemap",
      "BehaviourTree",
      "Blackboard",
      "Enum",
      "Structure",
      "ScriptInterface",
      "EditorUtilityInterface",
      "AudioMixer",
      "AudioChannel",
      "SoundAttenuation",
    ]);
  });

  it("labels creatable types in Title Case with spaces", () => {
    expect(creatableAssetTypeLabel("Scene")).toBe("Scene");
    expect(creatableAssetTypeLabel("UserInterface")).toBe("User Interface");
    expect(creatableAssetTypeLabel("EditorUtilityInterface")).toBe(
      "Editor Utility Interface",
    );
    expect(creatableAssetTypeLabel("AnimationGraph")).toBe("Animation Graph");
    expect(creatableAssetTypeLabel("SpriteAnimation")).toBe("Sprite Animation");
    expect(creatableAssetTypeLabel("MaterialFunction")).toBe("Material Function");
    expect(creatableAssetTypeLabel("BehaviourTree")).toBe("Behaviour Tree");
    expect(creatableAssetTypeLabel("ScriptInterface")).toBe("Script Interface");
    expect(creatableAssetTypeLabel("AudioMixer")).toBe("Audio Mixer");
    expect(creatableAssetTypeLabel("AudioChannel")).toBe("Audio Channel");
    expect(creatableAssetTypeLabel("SoundAttenuation")).toBe("Sound Attenuation");
  });

  it("groups every creatable type once", () => {
    const grouped = CREATABLE_ASSET_TYPE_GROUPS.flatMap((group) => [
      ...group.types,
    ]);
    expect([...grouped].sort()).toEqual([...CREATABLE_ASSET_TYPES].sort());
    expect(CREATABLE_ASSET_TYPE_GROUPS.map((group) => group.label)).toEqual([
      "World",
      "Scripting",
      "UI",
      "2D",
      "Animation",
      "Rendering",
      "Audio",
      "AI",
    ]);
    const twoD = CREATABLE_ASSET_TYPE_GROUPS.find((group) => group.id === "2d");
    const animation = CREATABLE_ASSET_TYPE_GROUPS.find(
      (group) => group.id === "animation",
    );
    const audio = CREATABLE_ASSET_TYPE_GROUPS.find((group) => group.id === "audio");
    expect([...twoD!.types]).toEqual(["Sprite", "Tileset", "Tilemap"]);
    expect([...animation!.types]).toEqual(["AnimationGraph", "SpriteAnimation"]);
    expect([...audio!.types]).toEqual([
      "AudioMixer",
      "AudioChannel",
      "SoundAttenuation",
    ]);
  });

  it("describes the selected creatable type", () => {
    expect(creatableAssetTypeDescription("Scene")).toMatch(/world/i);
    expect(creatableAssetTypeDescription("Class")).toMatch(/parent/i);
    expect(creatableAssetTypeDescription("Class")).toMatch(/logic graph/i);
    expect(creatableAssetTypeDescription("Class")).not.toMatch(/blueprint/i);
  });

  it("filters creatable types by Title Case label", () => {
    expect(filterCreatableAssetTypes("user")).toEqual(["UserInterface"]);
    expect(filterCreatableAssetTypes("  ")).toEqual([...CREATABLE_ASSET_TYPES]);
  });

  it("treats empty grid space as a new-asset double-click target, not tiles", () => {
    document.body.innerHTML = `
      <div data-testid="content-browser-asset-grid">
        <p data-testid="content-browser-empty-copy">No assets</p>
        <button data-asset-path="assets/main.scene.babasset">Scene</button>
        <button data-folder-path="assets/fx">Folder</button>
      </div>
      <div data-testid="outside">outside</div>
    `;
    const grid = document.querySelector(
      '[data-testid="content-browser-asset-grid"]',
    );
    const empty = document.querySelector(
      '[data-testid="content-browser-empty-copy"]',
    );
    const assetTile = document.querySelector("[data-asset-path]");
    const folderTile = document.querySelector("[data-folder-path]");
    const outside = document.querySelector('[data-testid="outside"]');
    expect(isContentBrowserEmptyGridDoubleClickTarget(grid)).toBe(true);
    expect(isContentBrowserEmptyGridDoubleClickTarget(empty)).toBe(true);
    expect(isContentBrowserEmptyGridDoubleClickTarget(assetTile)).toBe(false);
    expect(isContentBrowserEmptyGridDoubleClickTarget(folderTile)).toBe(false);
    expect(isContentBrowserEmptyGridDoubleClickTarget(outside)).toBe(false);
    expect(isContentBrowserEmptyGridDoubleClickTarget(null)).toBe(false);
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
    expect(
      (eui.payload.logic as { nodes: Array<{ type: string }> }).nodes.map(
        (node) => node.type,
      ),
    ).toEqual([]);
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

  it("extracts Material texture and function guids for header.dependencies", () => {
    expect(
      materialAssetDependencies("Material", {
        domain: "surface",
        nodes: [
          {
            id: "tex",
            type: "texture.sample",
            properties: { textureGuid: "tex-albedo" },
          },
          {
            id: "call",
            type: "function.call",
            properties: { functionGuid: "fn-tint" },
          },
        ],
        edges: [],
      }),
    ).toEqual(["fn-tint", "tex-albedo"]);
    expect(materialAssetDependencies("Class", {})).toEqual([]);
  });

  it("extracts Audio mixer and channel guids for header.dependencies", () => {
    expect(
      assetHeaderDependencies("Audio", {
        volume: 1,
        audioChannelGuid: "ch-1",
        soundAttenuationGuid: "att-1",
      }),
    ).toEqual(["att-1", "ch-1"]);
    expect(
      assetHeaderDependencies("AudioMixer", {
        globalVolume: 1,
        channels: [{ channelGuid: "ch-sfx", volume: 0.5 }],
      }),
    ).toEqual(["ch-sfx"]);
    expect(
      assetHeaderDependencies("AudioChannel", {
        parentChannelGuid: "ch-master",
        effects: [],
      }),
    ).toEqual(["ch-master"]);
    expect(
      assetHeaderDependencies("SpriteAnimation", {
        frames: [
          { textureGuid: "tex-a" },
          { textureGuid: "tex-a" },
          { textureGuid: "tex-b" },
        ],
      }),
    ).toEqual(["tex-a", "tex-b"]);
  });

  it("stores Material domain on the scanned header", () => {
    expect(materialHeaderMeta("Material", { domain: "postProcess" })).toEqual({
      domain: "postProcess",
    });
    expect(materialHeaderMeta("Material", {})).toEqual({ domain: "surface" });
    expect(materialHeaderMeta("Class", { domain: "postProcess" })).toBeUndefined();
  });

  it("recognizes post-process Materials from header payload", () => {
    expect(
      isPostProcessMaterialAsset(
        asset({
          type: "Material",
          payload: { domain: "postProcess" },
        }),
      ),
    ).toBe(true);
    expect(
      isPostProcessMaterialAsset(
        asset({ type: "Material", payload: { domain: "surface" } }),
      ),
    ).toBe(false);
  });

  it("prefers an open Material document domain over a stale header", () => {
    const bloom = asset({
      type: "Material",
      path: "assets/Bloom.material.babasset",
      guid: "pp-bloom",
      name: "Bloom",
      payload: { domain: "surface" },
    });
    expect(
      isPostProcessMaterialForPicker(bloom, [
        {
          ref: { kind: "material", path: "assets/Bloom.material.babasset" },
          content: { domain: "postProcess" },
        },
      ]),
    ).toBe(true);
    expect(isPostProcessMaterialForPicker(bloom, [])).toBe(false);
  });

  it("lists selected folders and assets for Delete confirm, not flattened contents", () => {
    expect(
      contentBrowserDeleteListNames({
        folderPaths: ["assets/fx"],
        assetNames: ["qa1"],
      }),
    ).toEqual(["assets/fx", "qa1"]);
    expect(
      contentBrowserDeleteListNames({
        folderPaths: ["assets/empty"],
        assetNames: [],
      }),
    ).toEqual(["assets/empty"]);
  });

  it("collects extra guids plus assets inside selected folders for last-Scene checks", () => {
    const assets = [
      asset({ guid: "s1", type: "Scene", name: "Main", path: "assets/fx/Main.scene.babasset" }),
      asset({ guid: "a1", type: "Enum", name: "qa1", path: "assets/qa1.babasset" }),
    ];
    expect(
      [...contentBrowserDeletingGuids({
        extraGuids: ["a1"],
        folderPaths: ["assets/fx"],
        assets,
      })].sort(),
    ).toEqual(["a1", "s1"]);
  });

  it("warns when deleting the last Scene and last Class", () => {
    const assets = [
      asset({ guid: "s1", type: "Scene", name: "Main" }),
      asset({ guid: "c1", type: "Class", name: "Hero" }),
      asset({ guid: "t1", type: "Texture", name: "Tex" }),
    ];
    expect(
      lastSceneClassDeleteLines(assets, new Set(["s1", "c1"])),
    ).toEqual([
      "This is the last Scene in the project.",
      "This is the last Class in the project.",
    ]);
    expect(lastSceneClassDeleteLines(assets, new Set(["s1"]))).toEqual([
      "This is the last Scene in the project.",
    ]);
    expect(
      lastSceneClassDeleteLines(
        [
          asset({ guid: "s1", type: "Scene", name: "Main" }),
          asset({ guid: "s2", type: "Scene", name: "Other" }),
        ],
        new Set(["s1"]),
      ),
    ).toEqual([]);
  });

  it("adds a tree row to the Content Browser selection without replacing the grid folder", () => {
    const rows: ContentBrowserTreeRow[] = [
      {
        id: "assets",
        kind: "folder",
        label: "assets",
        depth: 0,
        hasChildren: true,
        expanded: true,
        path: "assets",
      },
      {
        id: "assets/Hero.class.babasset",
        kind: "asset",
        label: "Hero",
        depth: 1,
        hasChildren: false,
        expanded: true,
        path: "assets/Hero.class.babasset",
        guid: "hero-1",
      },
      {
        id: "assets/fx",
        kind: "folder",
        label: "fx",
        depth: 1,
        hasChildren: false,
        expanded: true,
        path: "assets/fx",
      },
    ];
    const added = applyContentBrowserTreeSelect(
      "assets/fx",
      { additive: true },
      rows,
      {
        selectedGuids: new Set(["hero-1"]),
        selectedFolderPaths: new Set(),
        selectedFolderPath: "assets",
        anchorId: "assets/Hero.class.babasset",
      },
    );
    expect([...added.selectedGuids]).toEqual(["hero-1"]);
    expect([...added.selectedFolderPaths]).toEqual(["assets/fx"]);
    expect(added.selectedFolderPath).toBe("assets");

    const ranged = applyContentBrowserTreeSelect(
      "assets/fx",
      { range: true },
      rows,
      {
        selectedGuids: new Set(["hero-1"]),
        selectedFolderPaths: new Set(),
        selectedFolderPath: "assets",
        anchorId: "assets/Hero.class.babasset",
      },
    );
    expect([...ranged.selectedGuids]).toEqual(["hero-1"]);
    expect([...ranged.selectedFolderPaths]).toEqual(["assets/fx"]);
  });
});
