import { describe, expect, it } from "vitest";
import type { SearchEntry } from "@babylonslate/assets";
import {
  documentOpenForTarget,
  groupSearchEntries,
  revealAssetFromTarget,
  visualForSearchEntry,
} from "./search-navigation";

function entry(
  overrides: Pick<SearchEntry, "id" | "kind" | "label" | "target">,
): SearchEntry {
  return {
    keywords: [],
    ...overrides,
  };
}

describe("documentOpenForTarget", () => {
  it("opens Scene and Graph assets as documents", () => {
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/main.scene.babasset",
        guid: "s1",
        assetType: "Scene",
      }),
    ).toEqual({ kind: "scene", path: "assets/main.scene.babasset" });
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/main.graph.babasset",
        guid: "g1",
        assetType: "Graph",
      }),
    ).toEqual({ kind: "graph", path: "assets/main.graph.babasset" });
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/hero.class.babasset",
        guid: "c1",
        assetType: "Class",
      }),
    ).toEqual({ kind: "graph", path: "assets/hero.class.babasset" });
  });

  it("routes actors to their scene and nodes to their graph", () => {
    expect(
      documentOpenForTarget({
        kind: "scene-actor",
        scenePath: "assets/main.scene.babasset",
        actorId: "actor-1",
      }),
    ).toEqual({ kind: "scene", path: "assets/main.scene.babasset" });
    expect(
      documentOpenForTarget({
        kind: "graph-node",
        graphPath: "assets/main.graph.babasset",
        nodeId: "log-1",
      }),
    ).toEqual({ kind: "graph", path: "assets/main.graph.babasset" });
    expect(
      documentOpenForTarget({
        kind: "variable",
        name: "health",
        graphPath: "assets/main.graph.babasset",
        nodeId: "var-1",
      }),
    ).toEqual({ kind: "graph", path: "assets/main.graph.babasset" });
  });

  it("opens settings documents for import and type assets", () => {
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/hero.babasset",
        guid: "tex-1",
        assetType: "Texture",
      }),
    ).toEqual({ kind: "asset-settings", path: "assets/hero.babasset" });
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/colors.babasset",
        guid: "enum-1",
        assetType: "Enum",
      }),
    ).toEqual({ kind: "asset-settings", path: "assets/colors.babasset" });
    expect(
      documentOpenForTarget({ kind: "class", classId: "Actor" }),
    ).toEqual({ kind: "content-browser", path: "" });
    expect(
      documentOpenForTarget({
        kind: "class",
        classId: "MyHero",
        path: "assets/hero.class.babasset",
        guid: "c1",
      }),
    ).toEqual({ kind: "graph", path: "assets/hero.class.babasset" });
  });
});

describe("revealAssetFromTarget", () => {
  it("returns the guid and path for Content Browser reveal", () => {
    expect(
      revealAssetFromTarget({
        kind: "asset",
        path: "assets/hero.babasset",
        guid: "tex-1",
        assetType: "Texture",
      }),
    ).toBeNull();
    expect(
      revealAssetFromTarget({
        kind: "class",
        classId: "MyHero",
        path: "assets/my-hero.babasset",
        guid: "class-1",
      }),
    ).toEqual({ guid: "class-1", path: "assets/my-hero.babasset" });
    expect(
      revealAssetFromTarget({
        kind: "scene-actor",
        scenePath: "assets/main.scene.babasset",
        actorId: "actor-1",
      }),
    ).toBeNull();
  });
});

describe("groupSearchEntries", () => {
  it("groups in kind order and drops empty groups", () => {
    const grouped = groupSearchEntries([
      entry({
        id: "class:Actor",
        kind: "class",
        label: "Actor",
        target: { kind: "class", classId: "Actor" },
      }),
      entry({
        id: "asset:s1",
        kind: "asset",
        label: "Main",
        target: {
          kind: "asset",
          path: "assets/main.scene.babasset",
          guid: "s1",
          assetType: "Scene",
        },
      }),
      entry({
        id: "actor:s1:a1",
        kind: "actor",
        label: "Cube",
        target: {
          kind: "scene-actor",
          scenePath: "assets/main.scene.babasset",
          actorId: "a1",
        },
      }),
    ]);
    expect(grouped.map((group) => group.kind)).toEqual([
      "asset",
      "actor",
      "class",
    ]);
    expect(grouped[0]?.entries).toHaveLength(1);
  });
});

describe("visualForSearchEntry", () => {
  it("uses the asset type color for asset hits and the parent class icon for classes", () => {
    const texture = visualForSearchEntry(
      entry({
        id: "asset:tex",
        kind: "asset",
        label: "Hero",
        target: {
          kind: "asset",
          path: "assets/hero.babasset",
          guid: "tex-1",
          assetType: "Texture",
        },
      }),
    );
    expect(texture.iconKey).toBe("Texture");
    expect(texture.colorVar).toBe("var(--asset-texture)");

    const klass = visualForSearchEntry({
      id: "class:MyHero",
      kind: "class",
      label: "MyHero",
      description: "extends Actor",
      keywords: [],
      target: { kind: "class", classId: "MyHero" },
    });
    expect(klass.iconKey).toBe("Actor");
    expect(klass.colorVar).toBe("var(--asset-class)");
  });
});
