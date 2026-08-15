import { describe, expect, it } from "vitest";
import {
  assetTypeForDocumentKind,
  assetTypeForDocumentSave,
  createDocumentRef,
  documentKindForAssetType,
  documentKindLabel,
  isAssetDocumentKind,
  isLogicGraphAssetType,
  labelFromPath,
  parseDocumentId,
} from "./document";

describe("P9 document kinds", () => {
  it("maps UserInterface / Sprite / AnimationGraph / Shader kinds", () => {
    expect(documentKindForAssetType("UserInterface")).toBe("ui");
    expect(documentKindForAssetType("EditorUtilityInterface")).toBe("ui");
    expect(assetTypeForDocumentKind("ui")).toBe("UserInterface");
    expect(assetTypeForDocumentSave("ui", "EditorUtilityInterface")).toBe(
      "EditorUtilityInterface",
    );
    expect(assetTypeForDocumentSave("ui", null)).toBe("UserInterface");
    expect(documentKindForAssetType("AnimationGraph")).toBe("anim-graph");
    expect(documentKindForAssetType("BehaviourTree")).toBe("behaviour-tree");
    expect(documentKindForAssetType("Blackboard")).toBe("blackboard");
    expect(assetTypeForDocumentKind("behaviour-tree")).toBe("BehaviourTree");
    expect(assetTypeForDocumentKind("blackboard")).toBe("Blackboard");
    expect(isAssetDocumentKind("font")).toBe(true);
    expect(isAssetDocumentKind("content-browser")).toBe(false);
  });

  it("opens Tileset and Tilemap as their own document kinds", () => {
    expect(documentKindForAssetType("Tileset")).toBe("tileset");
    expect(documentKindForAssetType("Tilemap")).toBe("tilemap");
    expect(assetTypeForDocumentKind("tileset")).toBe("Tileset");
    expect(assetTypeForDocumentKind("tilemap")).toBe("Tilemap");
    expect(documentKindLabel("tileset")).toBe("Tileset");
    expect(documentKindLabel("tilemap")).toBe("Tilemap");
    expect(isAssetDocumentKind("tileset")).toBe(true);
    expect(isAssetDocumentKind("tilemap")).toBe(true);
    expect(labelFromPath("assets/ground.tileset.babasset")).toBe("Ground");
    expect(labelFromPath("assets/overworld.tilemap.babasset")).toBe("Overworld");
    expect(
      createDocumentRef("tileset", "assets/ground.tileset.babasset", {
        name: "Ground",
      }).label,
    ).toBe("Ground Tileset");
  });

  it("parses document ids and labels compound suffixes", () => {
    expect(parseDocumentId("ui:assets/hud.ui.babasset")).toEqual({
      kind: "ui",
      path: "assets/hud.ui.babasset",
    });
    expect(labelFromPath("assets/player_hud.ui.babasset")).toBe("Player Hud");
    expect(labelFromPath("assets/scene_tools.eui.babasset")).toBe("Scene Tools");
    expect(createDocumentRef("ui", "assets/hud.ui.babasset", { name: "HUD" }).label).toBe(
      "HUD UI",
    );
  });
});

describe("Class and settings documents", () => {
  it("opens Class as the graph workspace and labels the tab Class", () => {
    expect(documentKindForAssetType("Class")).toBe("graph");
    expect(documentKindForAssetType("Graph")).toBe("graph");
    expect(assetTypeForDocumentKind("graph")).toBe("Class");
    expect(documentKindLabel("graph")).toBe("Class");
    expect(isLogicGraphAssetType("Class")).toBe(true);
    expect(isLogicGraphAssetType("Graph")).toBe(true);
    expect(isLogicGraphAssetType("Scene")).toBe(false);
    expect(labelFromPath("assets/hero.class.babasset")).toBe("Hero");
    expect(
      createDocumentRef("graph", "assets/hero.class.babasset", { name: "Hero" })
        .label,
    ).toBe("Hero Class");
  });

  it("opens import assets as settings tabs", () => {
    for (const type of ["Texture", "Material", "Model", "Audio", "Animation"]) {
      expect(documentKindForAssetType(type)).toBe("asset-settings");
    }
    expect(assetTypeForDocumentKind("asset-settings")).toBe("Texture");
    expect(documentKindLabel("asset-settings")).toBe("Settings");
    expect(isAssetDocumentKind("asset-settings")).toBe(true);
    expect(parseDocumentId("asset-settings:assets/hero.babasset")).toEqual({
      kind: "asset-settings",
      path: "assets/hero.babasset",
    });
    expect(
      createDocumentRef("asset-settings", "assets/hero.babasset").label,
    ).toMatch(/Settings$/);
  });

  it("opens Enum, Structure, and ScriptInterface as their own document kinds", () => {
    expect(documentKindForAssetType("Enum")).toBe("enum");
    expect(documentKindForAssetType("Structure")).toBe("structure");
    expect(documentKindForAssetType("ScriptInterface")).toBe("script-interface");
    expect(assetTypeForDocumentKind("enum")).toBe("Enum");
    expect(assetTypeForDocumentKind("structure")).toBe("Structure");
    expect(assetTypeForDocumentKind("script-interface")).toBe("ScriptInterface");
    expect(documentKindLabel("enum")).toBe("Enum");
    expect(documentKindLabel("structure")).toBe("Structure");
    expect(documentKindLabel("script-interface")).toBe("Script Interface");
    expect(
      createDocumentRef("enum", "assets/colors.babasset", { name: "Colors" })
        .label,
    ).toBe("Colors Enum");
    expect(
      createDocumentRef("script-interface", "assets/hit.babasset", {
        name: "Hit",
      }).label,
    ).toBe("Hit Script Interface");
  });

  it("opens PluginSettings as its own document kind", () => {
    expect(documentKindForAssetType("PluginSettings")).toBe("plugin-settings");
    expect(assetTypeForDocumentKind("plugin-settings")).toBe("PluginSettings");
    expect(documentKindLabel("plugin-settings")).toBe("Plugin Settings");
    expect(isAssetDocumentKind("plugin-settings")).toBe(true);
    expect(
      parseDocumentId("plugin-settings:plugins/pack/pack.plugin.babasset"),
    ).toEqual({
      kind: "plugin-settings",
      path: "plugins/pack/pack.plugin.babasset",
    });
    expect(labelFromPath("plugins/pack/pack.plugin.babasset")).toBe("Pack");
    expect(
      createDocumentRef(
        "plugin-settings",
        "plugins/pack/pack.plugin.babasset",
        { name: "Pack" },
      ).label,
    ).toBe("Pack Plugin Settings");
  });
});
