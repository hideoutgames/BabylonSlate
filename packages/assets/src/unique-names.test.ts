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
  it("strips a typed container suffix, or only .hasset from any other name", () => {
    expect(stripAssetFileSuffix("main.scene.hasset")).toBe("main");
    expect(stripAssetFileSuffix("Item.datadefinition.hasset")).toBe("Item");
    expect(stripAssetFileSuffix("Items.datatree.hasset")).toBe("Items");
    expect(stripAssetFileSuffix("hero.class.hasset")).toBe("hero");
    expect(stripAssetFileSuffix("hud.ui.hasset")).toBe("hud.ui");
    expect(stripAssetFileSuffix("ground.tileset.hasset")).toBe("ground");
    expect(stripAssetFileSuffix("overworld.tilemap.hasset")).toBe("overworld");
    expect(stripAssetFileSuffix("pack.plugin.hasset")).toBe("pack");
    expect(stripAssetFileSuffix("master.mixer.hasset")).toBe("master");
    expect(stripAssetFileSuffix("sfx.channel.hasset")).toBe("sfx");
    expect(stripAssetFileSuffix("near.atten.hasset")).toBe("near");
    expect(stripAssetFileSuffix("tex.hasset")).toBe("tex");
    expect(stripAssetFileSuffix("walk.spriteanim.hasset")).toBe("walk");
    expect(stripAssetFileSuffix("day.skyboxcreator.hasset")).toBe("day");
    expect(stripAssetFileSuffix("Sparks.emitter.hasset")).toBe("Sparks");
    expect(stripAssetFileSuffix("Fire.particles.hasset")).toBe("Fire");
    expect(stripAssetFileSuffix("Duplicate_1.hasset")).toBe("Duplicate_1");
    expect(stripAssetFileSuffix("Hero.CLASS.HASSET")).toBe("Hero");
  });

  it("preserves the original container suffix", () => {
    expect(assetFileSuffix("Item.datadefinition.hasset")).toBe(".datadefinition.hasset");
    expect(assetFileSuffix("Items.datatree.hasset")).toBe(".datatree.hasset");
    expect(assetFileSuffix("main.scene.hasset")).toBe(".scene.hasset");
    expect(assetFileSuffix("hero.class.hasset")).toBe(".class.hasset");
    expect(assetFileSuffix("hud.ui.hasset")).toBe(".hasset");
    expect(assetFileSuffix("hero.sprite.hasset")).toBe(".sprite.hasset");
    expect(assetFileSuffix("walk.spriteanim.hasset")).toBe(
      ".spriteanim.hasset",
    );
    expect(assetFileSuffix("loco.anim.hasset")).toBe(".anim.hasset");
    expect(assetFileSuffix("ground.tileset.hasset")).toBe(".tileset.hasset");
    expect(assetFileSuffix("overworld.tilemap.hasset")).toBe(
      ".tilemap.hasset",
    );
    expect(assetFileSuffix("pack.plugin.hasset")).toBe(".plugin.hasset");
    expect(assetFileSuffix("master.mixer.hasset")).toBe(".mixer.hasset");
    expect(assetFileSuffix("sfx.channel.hasset")).toBe(".channel.hasset");
    expect(assetFileSuffix("near.atten.hasset")).toBe(".atten.hasset");
    expect(assetFileSuffix("day.skyboxcreator.hasset")).toBe(
      ".skyboxcreator.hasset",
    );
    expect(assetFileSuffix("Sparks.emitter.hasset")).toBe(".emitter.hasset");
    expect(assetFileSuffix("Fire.particles.hasset")).toBe(
      ".particles.hasset",
    );
    expect(assetFileSuffix("tex.hasset")).toBe(".hasset");
  });

  it("duplicates a Particle Graph under its own suffix", () => {
    const fileName = "Embers.particlegraph.hasset";
    const stem = stripAssetFileSuffix(fileName);
    expect(stem).toBe("Embers");
    expect(`${nextCopyName(stem, ["Embers"])}${assetFileSuffix(fileName)}`).toBe(
      "Embers_1.particlegraph.hasset",
    );
  });

  it("keeps a Save Game's display name and container suffix when duplicating", () => {
    const fileName = "PlayerProgress.savegame.hasset";
    const stem = stripAssetFileSuffix(fileName);
    expect(stem).toBe("PlayerProgress");
    expect(`${nextCopyName(stem, ["PlayerProgress"])}${assetFileSuffix(fileName)}`).toBe(
      "PlayerProgress_1.savegame.hasset",
    );
  });
});
