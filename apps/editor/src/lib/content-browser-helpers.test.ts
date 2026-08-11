import { describe, expect, it } from "vitest";
import type { IndexedAsset } from "@babylonslate/assets";
import {
  collectFolderGuids,
  compressionBadgeLabel,
  filterAssets,
  matchesAssetSearch,
  textureCompressionState,
} from "./content-browser-helpers";

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
      parentClass: null,
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
        typeFilter: null,
        search: "",
      }),
    ).toHaveLength(1);

    expect(
      filterAssets(items, {
        folderGuids: null,
        typeFilter: "Scene",
        search: "",
      }),
    ).toHaveLength(1);

    expect(
      filterAssets(items, {
        folderGuids: null,
        typeFilter: null,
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

  it("collects guids from a folder subtree", () => {
    const tree = {
      path: "assets",
      assets: ["root"],
      children: [
        {
          path: "assets/textures",
          assets: ["child"],
          children: [],
        },
      ],
    };
    const guids = collectFolderGuids("assets/textures", tree);
    expect([...guids]).toEqual(["child"]);
  });
});
