import { describe, expect, it } from "vitest";
import type { IndexedAsset } from "@babylonslate/assets";
import {
  collectFolderGuids,
  compressionBadgeLabel,
  displayAssetTitle,
  filterAssets,
  flattenFolderTree,
  folderDropTargetFromElement,
  guidFromAssetDragData,
  isFolderNameTaken,
  isFolderTreeRoot,
  isNewAssetNameTaken,
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
      "assets/hero.babasset",
      "assets/textures/hero.babasset",
    ];
    expect(isNewAssetNameTaken(paths, "assets", "Scene", "main")).toBe(true);
    expect(isNewAssetNameTaken(paths, "assets", "Texture", "hero")).toBe(true);
    expect(isNewAssetNameTaken(paths, "assets", "Texture", "crate")).toBe(false);
    expect(isNewAssetNameTaken(paths, "assets/textures", "Texture", "hero")).toBe(
      true,
    );
    expect(isNewAssetNameTaken(paths, "assets/textures", "Texture", "main")).toBe(
      false,
    );
  });

  it("detects a folder name that already exists under the parent", () => {
    const folders = ["assets", "assets/textures", "assets/fx"];
    expect(isFolderNameTaken(folders, "assets", "textures")).toBe(true);
    expect(isFolderNameTaken(folders, "assets", "audio")).toBe(false);
    expect(isFolderNameTaken(folders, "assets/textures", "ui")).toBe(false);
  });

  it("treats the registry tree root as immovable", () => {
    expect(isFolderTreeRoot("assets")).toBe(true);
    expect(isFolderTreeRoot("assets/textures")).toBe(false);
    expect(isFolderTreeRoot("content", "content")).toBe(true);
  });

  it("reads a drop folder from folder-path or asset-folder attributes", () => {
    const tree = document.createElement("div");
    tree.innerHTML = `<button data-folder-path="assets"><span>assets</span></button>`;
    const span = tree.querySelector("span");
    expect(folderDropTargetFromElement(span)).toBe("assets");

    const tile = document.createElement("div");
    tile.setAttribute("data-asset-folder", "assets/fx");
    const inner = document.createElement("button");
    tile.appendChild(inner);
    expect(folderDropTargetFromElement(inner)).toBe("assets/fx");
  });

  it("parses HTML5 asset drag payloads, including raw guids", () => {
    expect(guidFromAssetDragData(JSON.stringify({ guid: "abc" }))).toBe("abc");
    expect(guidFromAssetDragData("plain-guid")).toBe("plain-guid");
    expect(guidFromAssetDragData("")).toBeNull();
  });
});
