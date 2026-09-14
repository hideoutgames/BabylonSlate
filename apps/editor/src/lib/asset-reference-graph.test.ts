import { describe, expect, it } from "vitest";
import type { IndexedAsset } from "@babylonslate/assets";
import { buildAssetReferenceGraph } from "./asset-reference-graph";

function asset(
  guid: string,
  dependencies: string[] = [],
  type = "Texture",
): IndexedAsset {
  return {
    rootId: "project",
    path: `assets/${guid}.babasset`,
    header: {
      guid,
      dependencies,
      type,
      name: guid,
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      parentClass: null,
      payload: {},
      chunks: [],
    },
  };
}

describe("buildAssetReferenceGraph", () => {
  it("includes the whole connected chain across roots, with directed edges and no unrelated assets", () => {
    const assets = [
      asset("scene", ["material"]),
      asset("material", ["texture"]),
      {
        ...asset("other-material", ["texture", "other-texture"]),
        rootId: "plugin",
      },
      asset("texture"),
      asset("other-texture"),
      asset("unrelated"),
    ];
    const before = structuredClone(assets);
    const graph = buildAssetReferenceGraph("material", assets, []);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([
      "material",
      "other-material",
      "other-texture",
      "scene",
      "texture",
    ]);
    expect(graph.edges.map(({ source, target }) => [source, target])).toEqual([
      ["material", "texture"],
      ["other-material", "other-texture"],
      ["other-material", "texture"],
      ["scene", "material"],
    ]);
    const positions = new Map(
      graph.nodes.map((node) => [node.id, node.position]),
    );
    expect(positions.get("scene")!.x).toBeLessThan(
      positions.get("material")!.x,
    );
    expect(positions.get("texture")!.x).toBeGreaterThan(
      positions.get("material")!.x,
    );
    expect(
      new Set(graph.nodes.map((node) => JSON.stringify(node.position))).size,
    ).toBe(graph.nodes.length);
    expect(
      buildAssetReferenceGraph("material", [...assets].reverse(), []),
    ).toEqual(graph);
    expect(assets).toEqual(before);
  });

  it("terminates cycles, deduplicates edges, and retains self references and missing endpoints", () => {
    const graph = buildAssetReferenceGraph(
      "a",
      [asset("a", ["b", "b", "a"]), asset("b", ["a", "missing"])],
      [],
    );
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([
      "a",
      "b",
      "missing",
    ]);
    expect(graph.edges.map(({ source, target }) => [source, target])).toEqual([
      ["a", "a"],
      ["a", "b"],
      ["b", "a"],
      ["b", "missing"],
    ]);
    expect(
      graph.nodes.find((node) => node.id === "missing")?.data,
    ).toMatchObject({ title: "missing", missing: true });
    expect(
      buildAssetReferenceGraph("absent", [], []).nodes[0]?.data,
    ).toMatchObject({ missing: true });
    const placeholder = { ...asset("placeholder"), placeholder: true };
    expect(
      buildAssetReferenceGraph("placeholder", [placeholder], []).nodes[0]?.data,
    ).toMatchObject({ missing: true });
  });

  it("includes unsaved typed references alongside saved references without mutating documents", () => {
    const docs = [
      {
        ref: { path: "assets/model.babasset" },
        content: {
          materials: [],
          materialSlots: [{ name: "Surface", materialGuid: "live" }],
        },
      },
    ];
    const assets = [
      asset("model", ["saved"], "Model"),
      asset("saved"),
      asset("live"),
      asset("isolated"),
    ];
    const before = structuredClone(docs);
    const graph = buildAssetReferenceGraph("live", assets, docs);
    expect(graph.edges.map(({ source, target }) => [source, target])).toEqual([
      ["model", "live"],
      ["model", "saved"],
    ]);
    expect(docs).toEqual(before);
    expect(
      buildAssetReferenceGraph("isolated", assets, []).nodes.map(
        (node) => node.id,
      ),
    ).toEqual(["isolated"]);
  });
});
