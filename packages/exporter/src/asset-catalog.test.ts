import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "@babylonslate/core";
import { runtimeAssetCatalogFromIndexed, runtimeAssetCatalogFromManifest } from "./asset-catalog";
import { exportGame } from "./export-game";
import type { ExportIndexedAsset } from "./types";

const header = (partial: Partial<ExportIndexedAsset> & Pick<ExportIndexedAsset, "guid" | "type" | "name">): ExportIndexedAsset =>
  ({ dependencies: [], rootId: "project", ...partial });

describe("runtimeAssetCatalogFromIndexed", () => {
  const assets = [
    header({ guid: "rifle", name: "Rifle", type: "Class", path: "assets/Weapons/rifle-v2.class.babasset", parentClass: "Weapon",
      dependencies: ["tex"], requiredDependencies: ["tex"] }),
    header({ guid: "tex", name: "Scope", type: "Texture", path: "assets/Weapons/scope.texture.babasset", parentClass: "NotAClass" }),
    header({ guid: "missing", name: "Missing Asset", type: "Unresolved" }),
  ];

  it("describes each header with its storage path and, for Classes, the class id the runtime knows", () => {
    expect(runtimeAssetCatalogFromIndexed(assets)).toEqual([
      {
        guid: "rifle", name: "Rifle", type: "Class", path: "assets/Weapons/rifle-v2.class.babasset",
        classId: "rifle_v2", parentClass: "Weapon", dependencies: ["tex"], requiredDependencies: ["tex"],
      },
      {
        guid: "tex", name: "Scope", type: "Texture", path: "assets/Weapons/scope.texture.babasset",
        dependencies: [], requiredDependencies: [],
      },
    ]);
  });

  it("keeps only the packaged guids when given", () => {
    expect(runtimeAssetCatalogFromIndexed(assets, new Set(["tex"])).map((entry) => entry.guid)).toEqual(["tex"]);
  });
});

describe("runtimeAssetCatalogFromManifest", () => {
  it("lists exactly the authored assets of an exported game, not its generated entries", async () => {
    const result = await exportGame({
      bundleDebugger: false, startupSceneGuid: "scene", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [{ assetGuid: "hero", classId: "Hero", parentClassId: "Actor", source: "export function onTick() {}", anchors: [], entryPoints: [] }],
      assets: [
        { guid: "scene", type: "Scene", sceneGuid: "scene", name: "Main", bytes: new TextEncoder().encode("{}"),
          assetPath: "assets/Levels/Main.scene.babasset", dependencies: ["hero"], requiredDependencies: [] },
        { guid: "hero", type: "Class", sceneGuid: "scene", name: "Hero", parentClass: "Actor", bytes: new TextEncoder().encode("{}"),
          assetPath: "plugins/Foo/assets/Hero.class.babasset", dependencies: ["tex"], requiredDependencies: ["tex"] },
        { guid: "tex", type: "Texture", sceneGuid: "scene", name: "Skin", bytes: new Uint8Array([1]),
          assetPath: "assets/Skin.texture.babasset" },
        { guid: "nav:scene", type: "NavMesh", sceneGuid: "scene", bytes: new Uint8Array([2]), encoding: "bytes" },
      ],
    });
    if (!result.ok) throw new Error(result.error);
    // Sidecars (a Class's compiled script, a Scene's navigation) stay references of their owner; they are not assets.
    expect(runtimeAssetCatalogFromManifest(result.value.manifest.assets)).toEqual([
      { guid: "scene", name: "Main", type: "Scene", path: "assets/Levels/Main.scene.babasset",
        dependencies: ["hero", "nav:scene"], requiredDependencies: ["nav:scene"] },
      { guid: "hero", name: "Hero", type: "Class", path: "plugins/Foo/assets/Hero.class.babasset", classId: "Hero", parentClass: "Actor",
        dependencies: ["tex", "script:hero:Hero"], requiredDependencies: ["tex", "script:hero:Hero"] },
      { guid: "tex", name: "Skin", type: "Texture", path: "assets/Skin.texture.babasset", dependencies: [], requiredDependencies: [] },
    ]);
  });
});
