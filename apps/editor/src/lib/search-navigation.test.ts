import { describe, expect, it } from "vitest";
import type { SearchEntry } from "@babylonslate/assets";
import {
  documentOpenForTarget,
  groupSearchEntries,
  revealAssetFromTarget,
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

  it("reveals other assets in the Content Browser", () => {
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/hero.babasset",
        guid: "tex-1",
        assetType: "Texture",
      }),
    ).toEqual({ kind: "content-browser", path: "assets/hero.babasset" });
    expect(
      documentOpenForTarget({ kind: "class", classId: "Actor" }),
    ).toEqual({ kind: "content-browser", path: "" });
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
    ).toEqual({ guid: "tex-1", path: "assets/hero.babasset" });
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
