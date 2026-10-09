import { describe, expect, it } from "vitest";
import type { AssetRegistry, FolderNode, IndexedAsset } from "@babylonslate/assets";
import { normalizeProjectSettings } from "@babylonslate/core";
import { createRegistryCatalogSource, playAssetCatalog } from "./asset-catalog";

function indexed(
  path: string,
  type: string,
  extra: { guid?: string; name?: string; dependencies?: string[]; parentClass?: string; rootId?: string; placeholder?: boolean } = {},
): IndexedAsset {
  const name = extra.name ?? path.split("/").pop()!.split(".")[0]!;
  return {
    rootId: extra.rootId ?? "project",
    path,
    ...(extra.placeholder ? { placeholder: true } : {}),
    header: {
      chunks: [], dependencies: extra.dependencies ?? [], engineVersion: "0", guid: extra.guid ?? `guid-${name}`, mode: "thin",
      name, parentClass: extra.parentClass ?? null, payload: {}, type, version: 1,
    },
  };
}

const node = (path: string, children: FolderNode[] = []): FolderNode => ({ name: path.split("/").pop()!, path, children, assets: [] });

describe("playAssetCatalog", () => {
  const assets = [
    indexed("assets/Levels/Main.scene.babasset", "Scene", { dependencies: ["guid-Hero"] }),
    indexed("assets/Levels/Bonus.scene.babasset", "Scene", { dependencies: ["guid-Gem"] }),
    indexed("assets/Hero.class.babasset", "Class", { parentClass: "Actor", dependencies: ["guid-hero-tex"] }),
    indexed("assets/Hero.texture.babasset", "Texture", { guid: "guid-hero-tex" }),
    indexed("assets/Gem.texture.babasset", "Texture", { guid: "guid-Gem" }),
    indexed("assets/Spare/Spare.texture.babasset", "Texture"),
    indexed("assets/Tools/Tool.class.babasset", "Class", { parentClass: "EditorUtilityObject" }),
    indexed("assets/Unused.texture.babasset", "Texture"),
    indexed("plugins/On/assets/Prop.class.babasset", "Class", { parentClass: "Actor", rootId: "plugin:on" }),
    indexed("__unresolved__/guid-Gone", "Unresolved", { placeholder: true }),
  ];
  const registry = { list: () => assets, listRoots: () => [{ id: "project" }, { id: "plugin:on" }] } as unknown as Pick<AssetRegistry, "list" | "listRoots">;
  const guids = (settings: Parameters<typeof normalizeProjectSettings>[0], sceneGuid: string) =>
    playAssetCatalog({ registry, settings: normalizeProjectSettings(settings), sceneGuid }).map((entry) => entry.guid).sort();

  it("lists what an export from the same settings would ship, plus the Scene Play starts from", () => {
    expect(guids({ startupSceneGuid: "guid-Main" }, "guid-Main")).toEqual(["guid-Hero", "guid-Main", "guid-hero-tex"]);
    expect(guids({ startupSceneGuid: "guid-Main" }, "guid-Bonus")).toEqual(["guid-Bonus", "guid-Gem", "guid-Hero", "guid-Main", "guid-hero-tex"]);
    expect(guids({}, "guid-Bonus")).toEqual(["guid-Bonus", "guid-Gem"]);
  });

  it("adds Always Package Folders but never editor-only or disabled plugin assets", () => {
    expect(
      guids({ startupSceneGuid: "guid-Main", alwaysPackageFolders: ["assets/Spare", "assets/Tools", "plugins/On/assets", "plugins/Off/assets"] }, "guid-Main"),
    ).toEqual(["guid-Hero", "guid-Main", "guid-Prop", "guid-Spare", "guid-hero-tex"]);
  });

  it("describes each asset by its storage path and class id", () => {
    const hero = playAssetCatalog({ registry, settings: normalizeProjectSettings({ startupSceneGuid: "guid-Main" }), sceneGuid: "guid-Main" })
      .find((entry) => entry.guid === "guid-Hero");
    expect(hero).toEqual({
      guid: "guid-Hero", name: "Hero", type: "Class", path: "assets/Hero.class.babasset", classId: "Hero", parentClass: "Actor",
      dependencies: ["guid-hero-tex"], requiredDependencies: [],
    });
  });

  it("lists nothing when no Scene can start", () => {
    expect(guids({}, "missing")).toEqual([]);
  });
});

describe("createRegistryCatalogSource", () => {
  function fakeRegistry(assets: IndexedAsset[]) {
    const registry = {
      generation: 1,
      list: () => assets,
      listRoots: () => [{ id: "project" }],
      folderTree: () => node("assets", [node("assets/Empty"), node("assets/Weapons")]),
    };
    return registry as typeof registry & Pick<AssetRegistry, "list" | "listRoots" | "generation" | "folderTree">;
  }

  it("lists every registry asset, including editor-only ones, and the empty folders", () => {
    const registry = fakeRegistry([
      indexed("assets/Weapons/Rifle.class.babasset", "Class", { parentClass: "Actor" }),
      indexed("assets/Tools/Tool.class.babasset", "Class", { parentClass: "EditorUtilityObject" }),
      indexed("__unresolved__/guid-Gone", "Unresolved", { placeholder: true }),
    ]);
    const catalog = createRegistryCatalogSource(() => registry)()!;
    expect(catalog.getAssetsByClass("EditorUtilityObject", true, "", true).map((asset) => asset.Class)).toEqual(["Tool"]);
    expect(catalog.hasAsset("guid-Gone")).toBe(false);
    expect(catalog.getSubFolders("assets", false)).toEqual(["assets/Empty", "assets/Tools", "assets/Weapons"]);
  });

  it("keeps one catalog until the registry changes, then reflects the change", () => {
    const assets = [indexed("assets/A.texture.babasset", "Texture")];
    const registry = fakeRegistry(assets);
    const source = createRegistryCatalogSource(() => registry);
    const first = source()!;
    expect(source()).toBe(first);
    assets.push(indexed("assets/B.texture.babasset", "Texture"));
    expect(source()).toBe(first);
    registry.generation += 1;
    const second = source()!;
    expect(second).not.toBe(first);
    expect(second.getAssetsByType("Texture", "", true)).toHaveLength(2);
  });

  it("follows a different registry even at the same generation, and reports none without one", () => {
    let current: ReturnType<typeof fakeRegistry> | null = fakeRegistry([indexed("assets/A.texture.babasset", "Texture")]);
    const source = createRegistryCatalogSource(() => current);
    const first = source()!;
    current = fakeRegistry([indexed("assets/B.texture.babasset", "Texture")]);
    expect(source()!.hasAsset("guid-B")).toBe(true);
    expect(source()!.hasAsset("guid-A")).toBe(false);
    expect(first.hasAsset("guid-A")).toBe(true);
    current = null;
    expect(source()).toBeNull();
  });
});
