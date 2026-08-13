import { describe, expect, it } from "vitest";
import {
  assetTypeForDocumentKind,
  createDocumentRef,
  documentKindForAssetType,
  isAssetDocumentKind,
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
