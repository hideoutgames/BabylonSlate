import { describe, expect, it } from "vitest";
import {
  assetFolderOfPath,
  isFolderWithin,
  normalizeAlwaysPackageFolders,
  normalizeAssetFolderPath,
  remapAlwaysPackageFolders,
  removeAlwaysPackageFolders,
} from "./asset-folders";
import { ASSET_TYPES, classIdForAssetPath } from "./asset-catalog";

describe("asset folder paths", () => {
  it("trims, strips outer slashes and collapses repeated slashes", () => {
    expect(normalizeAssetFolderPath("  /assets//Weapons/ ")).toBe("assets/Weapons");
    expect(normalizeAssetFolderPath("/")).toBe("");
  });

  it("matches a folder only at a path boundary, case-sensitively", () => {
    expect(isFolderWithin("assets/Weapons", "assets/Weapons")).toBe(true);
    expect(isFolderWithin("assets/Weapons/Rifles", "assets/Weapons")).toBe(true);
    expect(isFolderWithin("assets/WeaponsOld", "assets/Weapons")).toBe(false);
    expect(isFolderWithin("assets/weapons", "assets/Weapons")).toBe(false);
    expect(isFolderWithin("assets/Anything", "")).toBe(true);
  });

  it("takes the parent directory of a storage path", () => {
    expect(assetFolderOfPath("assets/Weapons/Rifle.class.babasset")).toBe("assets/Weapons");
    expect(assetFolderOfPath("Rifle.class.babasset")).toBe("");
  });
});

describe("Always Package Folders", () => {
  it("normalizes, drops blanks and non-strings, and keeps the first of a duplicate", () => {
    expect(
      normalizeAlwaysPackageFolders(["assets/B/", "", 3, "assets/A", "/assets/B"]),
    ).toEqual(["assets/B", "assets/A"]);
    expect(normalizeAlwaysPackageFolders(undefined)).toEqual([]);
  });

  it("follows a folder move by prefix without touching siblings that share a name prefix", () => {
    expect(
      remapAlwaysPackageFolders(
        ["assets/Weapons", "assets/Weapons/Rifles", "assets/WeaponsOld", "assets/UI"],
        "assets/Weapons",
        "assets/Gear/Weapons",
      ),
    ).toEqual([
      "assets/Gear/Weapons",
      "assets/Gear/Weapons/Rifles",
      "assets/WeaponsOld",
      "assets/UI",
    ]);
  });

  it("merges entries that collapse to the same folder after a move", () => {
    expect(
      remapAlwaysPackageFolders(["assets/A", "assets/B"], "assets/A", "assets/B"),
    ).toEqual(["assets/B"]);
  });

  it("drops entries inside a deleted folder but keeps its parent", () => {
    expect(
      removeAlwaysPackageFolders(
        ["assets/Weapons", "assets/Weapons/Rifles", "assets/Weapons/Rifles/Old", "assets/UI"],
        ["assets/Weapons/Rifles"],
      ),
    ).toEqual(["assets/Weapons", "assets/UI"]);
  });
});

describe("asset catalog helpers", () => {
  it.each([
    ["assets/Weapons/Rifle.class.babasset", "Rifle"],
    ["assets/my-weapon.class.babasset", "my_weapon"],
    ["assets/Old.graph.babasset", "Old"],
    ["assets/.class.babasset", "Graph"],
  ])("derives the class id of %s", (path, expected) => {
    expect(classIdForAssetPath(path)).toBe(expected);
  });

  it("lists each asset type once, including Class and Texture", () => {
    expect(new Set(ASSET_TYPES).size).toBe(ASSET_TYPES.length);
    expect(ASSET_TYPES).toEqual(expect.arrayContaining(["Class", "Texture", "Scene", "Model"]));
  });
});
