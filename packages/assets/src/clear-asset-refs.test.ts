import { describe, expect, it } from "vitest";
import { createEmptyProject } from "@babylonslate/core";
import {
  clearDeletedAssetRefs,
  clearDeletedRefsFromProjectSettings,
} from "./clear-asset-refs";

const deleted = new Set(["tex-1", "hud-1"]);

describe("clearDeletedAssetRefs", () => {
  it("replaces an exact deleted guid string with null", () => {
    expect(clearDeletedAssetRefs("tex-1", deleted)).toEqual({
      value: null,
      changed: true,
    });
  });

  it("leaves unrelated strings unchanged", () => {
    expect(clearDeletedAssetRefs("tex-2", deleted)).toEqual({
      value: "tex-2",
      changed: false,
    });
    expect(clearDeletedAssetRefs("Hero", deleted)).toEqual({
      value: "Hero",
      changed: false,
    });
  });

  it("does not substring-replace a guid inside other text", () => {
    expect(clearDeletedAssetRefs("prefix-tex-1-suffix", deleted)).toEqual({
      value: "prefix-tex-1-suffix",
      changed: false,
    });
  });

  it("drops deleted guids from string arrays instead of inserting null", () => {
    expect(clearDeletedAssetRefs(["keep", "tex-1", "also"], deleted)).toEqual({
      value: ["keep", "also"],
      changed: true,
    });
  });

  it("clears nested scene-like guid fields and reports changed", () => {
    const payload = {
      actors: [
        {
          classId: "Hero",
          components: [
            {
              properties: {
                assetGuid: "tex-1",
                materialGuid: "mat-keep",
                name: "Body",
              },
            },
          ],
        },
      ],
      settings: { environmentTextureGuid: "tex-1" },
    };
    expect(clearDeletedAssetRefs(payload, deleted)).toEqual({
      value: {
        actors: [
          {
            classId: "Hero",
            components: [
              {
                properties: {
                  assetGuid: null,
                  materialGuid: "mat-keep",
                  name: "Body",
                },
              },
            ],
          },
        ],
        settings: { environmentTextureGuid: null },
      },
      changed: true,
    });
  });

  it("returns the same object when nothing matches", () => {
    const payload = { textureGuid: "tex-2", frames: ["idle"] };
    const result = clearDeletedAssetRefs(payload, deleted);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(payload);
  });

  it("nulls gameInstanceClass when that class was deleted, leaving actor classId", () => {
    const payload = {
      actors: [{ classId: "HeroGame" }],
      settings: { gameInstanceClass: "HeroGame" },
    };
    expect(
      clearDeletedAssetRefs(payload, new Set(), new Set(["HeroGame"])),
    ).toEqual({
      value: {
        actors: [{ classId: "HeroGame" }],
        settings: { gameInstanceClass: null },
      },
      changed: true,
    });
  });
});

describe("clearDeletedRefsFromProjectSettings", () => {
  it("nulls startup scene, mixer, and default font guids", () => {
    const settings = {
      ...createEmptyProject("Demo").settings,
      startupSceneGuid: "scene-1",
      gameInstanceClass: "KeepGame",
      editorUtilityObjects: ["KeepTools"],
      fonts: {
        ...createEmptyProject("Demo").settings.fonts,
        defaultFontGuid: "font-1",
      },
      audio: {
        ...createEmptyProject("Demo").settings.audio,
        audioMixerGuid: "mix-1",
      },
    };
    const result = clearDeletedRefsFromProjectSettings(
      settings,
      new Set(["scene-1", "font-1", "mix-1"]),
      new Set(),
    );
    expect(result.changed).toBe(true);
    expect(result.value.startupSceneGuid).toBeNull();
    expect(result.value.fonts.defaultFontGuid).toBeNull();
    expect(result.value.audio.audioMixerGuid).toBeNull();
    expect(result.value.gameInstanceClass).toBe("KeepGame");
  });

  it("clears gameInstanceClass and editor utility names for deleted classes", () => {
    const settings = {
      ...createEmptyProject("Demo").settings,
      startupSceneGuid: "scene-keep",
      gameInstanceClass: "HeroGame",
      editorUtilityObjects: ["HeroTools", "KeepTools"],
    };
    const result = clearDeletedRefsFromProjectSettings(
      settings,
      new Set(),
      new Set(["HeroGame", "HeroTools"]),
    );
    expect(result.changed).toBe(true);
    expect(result.value.gameInstanceClass).toBeNull();
    expect(result.value.editorUtilityObjects).toEqual(["KeepTools"]);
    expect(result.value.startupSceneGuid).toBe("scene-keep");
  });
});
