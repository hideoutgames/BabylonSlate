import { describe, expect, it } from "vitest";
import type { SearchEntry } from "@haptic/assets";
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
  it("opens Scene and Class assets as documents", () => {
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/main.scene.hasset",
        guid: "s1",
        assetType: "Scene",
      }),
    ).toEqual({ kind: "scene", path: "assets/main.scene.hasset" });
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/hero.class.hasset",
        guid: "c1",
        assetType: "Class",
      }),
    ).toEqual({ kind: "graph", path: "assets/hero.class.hasset" });
  });

  it("routes actors to their scene and nodes to their graph", () => {
    expect(
      documentOpenForTarget({
        kind: "scene-actor",
        scenePath: "assets/main.scene.hasset",
        actorId: "actor-1",
      }),
    ).toEqual({ kind: "scene", path: "assets/main.scene.hasset" });
    expect(
      documentOpenForTarget({
        kind: "graph-node",
        graphPath: "assets/main.class.hasset",
        nodeId: "log-1",
      }),
    ).toEqual({ kind: "graph", path: "assets/main.class.hasset" });
    expect(
      documentOpenForTarget({
        kind: "variable",
        name: "health",
        graphPath: "assets/main.class.hasset",
        nodeId: "var-1",
      }),
    ).toEqual({ kind: "graph", path: "assets/main.class.hasset" });
  });

  it("opens settings documents for import and type assets", () => {
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/hero.hasset",
        guid: "tex-1",
        assetType: "Texture",
      }),
    ).toEqual({ kind: "texture", path: "assets/hero.hasset" });
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/hero.hasset",
        guid: "mesh-1",
        assetType: "Model",
      }),
    ).toEqual({ kind: "model", path: "assets/hero.hasset" });
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/hero.skeleton.hasset",
        guid: "skel-1",
        assetType: "Skeleton",
      }),
    ).toEqual({ kind: "skeleton", path: "assets/hero.skeleton.hasset" });
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/hero_idle.hasset",
        guid: "anim-1",
        assetType: "Animation",
      }),
    ).toEqual({ kind: "animation", path: "assets/hero_idle.hasset" });
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/jump.hasset",
        guid: "audio-1",
        assetType: "Audio",
      }),
    ).toEqual({ kind: "audio", path: "assets/jump.hasset" });
    expect(
      documentOpenForTarget({
        kind: "asset",
        path: "assets/colors.hasset",
        guid: "enum-1",
        assetType: "Enum",
      }),
    ).toEqual({ kind: "enum", path: "assets/colors.hasset" });
    expect(
      documentOpenForTarget({ kind: "class", classId: "Actor" }),
    ).toEqual({ kind: "content-browser", path: "" });
    expect(
      documentOpenForTarget({
        kind: "class",
        classId: "MyHero",
        path: "assets/hero.class.hasset",
        guid: "c1",
      }),
    ).toEqual({ kind: "graph", path: "assets/hero.class.hasset" });
  });
});

describe("revealAssetFromTarget", () => {
  it("returns the guid and path for Content Browser reveal", () => {
    expect(
      revealAssetFromTarget({
        kind: "asset",
        path: "assets/hero.hasset",
        guid: "tex-1",
        assetType: "Texture",
      }),
    ).toBeNull();
    expect(
      revealAssetFromTarget({
        kind: "asset",
        path: "assets/tools.hasset",
        guid: "tools-1",
        assetType: "EditorUtilityInterface",
      }),
    ).toEqual({ guid: "tools-1", path: "assets/tools.hasset" });
    expect(
      revealAssetFromTarget({
        kind: "class",
        classId: "MyHero",
        path: "assets/my-hero.hasset",
        guid: "class-1",
      }),
    ).toEqual({ guid: "class-1", path: "assets/my-hero.hasset" });
    expect(
      revealAssetFromTarget({
        kind: "scene-actor",
        scenePath: "assets/main.scene.hasset",
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
          path: "assets/main.scene.hasset",
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
          scenePath: "assets/main.scene.hasset",
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

