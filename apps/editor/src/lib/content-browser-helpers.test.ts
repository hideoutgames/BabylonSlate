import { describe, expect, it } from "vitest";
import type { IndexedAsset } from "@babylonslate/assets";
import {
  CREATABLE_ASSET_TYPES,
  ENGINE_BASE_CLASSES,
  buildNewAssetResult,
  classDocumentShowsPrefab,
  collectFolderGuids,
  compressionBadgeLabel,
  displayAssetTitle,
  filterAssets,
  flattenFolderTree,
  filterFolderTreeRows,
  isFolderNameTaken,
  isFolderTreeRoot,
  isNewAssetNameTaken,
  isValidMoveDestination,
  matchesAssetSearch,
  newAssetFileName,
  remapPathAfterFolderMove,
  textureCompressionState,
  visualForIndexedAsset,
  classParentLookup,
  addSelectedAssetGuid,
  assetTypeCardAccent,
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
    expect([...collectFolderGuids("assets", tree)].sort()).toEqual(
      ["child", "nested", "root"].sort(),
    );
    expect([
      ...collectFolderGuids("assets/textures", tree, { recursive: true }),
    ]).toEqual(["child", "nested"]);
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
    expect(hud.payload.rootId).toBe("canvas");
    expect(hud.payload.viewportLayer).toBe(true);
    expect(hud.chunks.some((chunk) => chunk.id === "document")).toBe(true);
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
      "Enum",
      "Structure",
      "ScriptInterface",
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

  it("does not drop a guid that is already selected", () => {
    const current = new Set(["scene-1"]);
    const selected = addSelectedAssetGuid(current, "scene-1");
    expect([...selected]).toEqual(["scene-1"]);
    expect(selected).not.toBe(current);
  });

  it("mixes the type token into card and thumb accents", () => {
    const colorVar = "var(--asset-texture)";
    const card = assetTypeCardAccent(colorVar);
    expect(card.backgroundColor).toBe(
      "color-mix(in oklch, var(--asset-texture) 16%, var(--card))",
    );
    expect(card.borderColor).toBe(
      "color-mix(in oklch, var(--asset-texture) 50%, var(--border))",
    );
    expect(assetTypeThumbAccent(colorVar).backgroundColor).toBe(
      "color-mix(in oklch, var(--asset-texture) 28%, var(--muted))",
    );
  });
});
