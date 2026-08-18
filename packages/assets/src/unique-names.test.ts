import { describe, expect, it } from "vitest";
import {
  assetFileSuffix,
  nextCopyName,
  stripAssetFileSuffix,
  stripTrailingCopyIndex,
} from "./unique-names";

describe("stripTrailingCopyIndex", () => {
  it("strips a single trailing _digits suffix", () => {
    expect(stripTrailingCopyIndex("Duplicate_1")).toBe("Duplicate");
    expect(stripTrailingCopyIndex("Hero_12")).toBe("Hero");
  });

  it("leaves unsuffixed names unchanged", () => {
    expect(stripTrailingCopyIndex("Hero")).toBe("Hero");
    expect(stripTrailingCopyIndex("Duplicate")).toBe("Duplicate");
  });
});

describe("nextCopyName", () => {
  it("keeps the stem when it is unused in the destination", () => {
    expect(nextCopyName("Hero", [])).toBe("Hero");
    expect(nextCopyName("tex", ["other"])).toBe("tex");
  });

  it("allocates Hero_1 when Hero is taken", () => {
    expect(nextCopyName("Hero", ["Hero"])).toBe("Hero_1");
  });

  it("uses the next free index on the stripped stem, not stem_N_1", () => {
    expect(
      nextCopyName("Duplicate_1", ["Duplicate", "Duplicate_1", "Duplicate_2"]),
    ).toBe("Duplicate_3");
  });
});

describe("asset file suffix helpers", () => {
  it("strips .scene.babasset, .graph.babasset, .class.babasset, and .babasset", () => {
    expect(stripAssetFileSuffix("main.scene.babasset")).toBe("main");
    expect(stripAssetFileSuffix("logic.graph.babasset")).toBe("logic");
    expect(stripAssetFileSuffix("hero.class.babasset")).toBe("hero");
    expect(stripAssetFileSuffix("hud.ui.babasset")).toBe("hud");
    expect(stripAssetFileSuffix("tools.eui.babasset")).toBe("tools");
    expect(stripAssetFileSuffix("ground.tileset.babasset")).toBe("ground");
    expect(stripAssetFileSuffix("overworld.tilemap.babasset")).toBe("overworld");
    expect(stripAssetFileSuffix("pack.plugin.babasset")).toBe("pack");
    expect(stripAssetFileSuffix("master.mixer.babasset")).toBe("master");
    expect(stripAssetFileSuffix("sfx.channel.babasset")).toBe("sfx");
    expect(stripAssetFileSuffix("near.atten.babasset")).toBe("near");
    expect(stripAssetFileSuffix("tex.babasset")).toBe("tex");
    expect(stripAssetFileSuffix("walk.spriteanim.babasset")).toBe("walk");
    expect(stripAssetFileSuffix("day.skyboxcreator.babasset")).toBe("day");
    expect(stripAssetFileSuffix("Duplicate_1.babasset")).toBe("Duplicate_1");
  });

  it("preserves the original container suffix", () => {
    expect(assetFileSuffix("main.scene.babasset")).toBe(".scene.babasset");
    expect(assetFileSuffix("logic.graph.babasset")).toBe(".graph.babasset");
    expect(assetFileSuffix("hero.class.babasset")).toBe(".class.babasset");
    expect(assetFileSuffix("hud.ui.babasset")).toBe(".ui.babasset");
    expect(assetFileSuffix("tools.eui.babasset")).toBe(".eui.babasset");
    expect(assetFileSuffix("hero.sprite.babasset")).toBe(".sprite.babasset");
    expect(assetFileSuffix("walk.spriteanim.babasset")).toBe(
      ".spriteanim.babasset",
    );
    expect(assetFileSuffix("loco.anim.babasset")).toBe(".anim.babasset");
    expect(assetFileSuffix("surface.shader.babasset")).toBe(".shader.babasset");
    expect(assetFileSuffix("ground.tileset.babasset")).toBe(".tileset.babasset");
    expect(assetFileSuffix("overworld.tilemap.babasset")).toBe(
      ".tilemap.babasset",
    );
    expect(assetFileSuffix("pack.plugin.babasset")).toBe(".plugin.babasset");
    expect(assetFileSuffix("master.mixer.babasset")).toBe(".mixer.babasset");
    expect(assetFileSuffix("sfx.channel.babasset")).toBe(".channel.babasset");
    expect(assetFileSuffix("near.atten.babasset")).toBe(".atten.babasset");
    expect(assetFileSuffix("day.skyboxcreator.babasset")).toBe(
      ".skyboxcreator.babasset",
    );
    expect(assetFileSuffix("tex.babasset")).toBe(".babasset");
  });
});
