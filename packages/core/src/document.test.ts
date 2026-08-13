import { describe, expect, it } from "vitest";
import {
  assetTypeForDocumentKind,
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
    expect(assetTypeForDocumentKind("ui")).toBe("UserInterface");
    expect(assetTypeForDocumentKind("anim-graph")).toBe("AnimationGraph");
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

  it("opens import and type assets as settings tabs", () => {
    for (const type of [
      "Texture",
      "Material",
      "Model",
      "Audio",
      "Animation",
      "Enum",
      "Structure",
      "ScriptInterface",
    ]) {
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
});
