import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import { collectExportClosure } from "./closure";
import { MISSING_STARTUP_SCENE_MESSAGE } from "./constants";
import type { ExportIndexedAsset } from "./types";

function asset(
  partial: Partial<ExportIndexedAsset> & Pick<ExportIndexedAsset, "guid" | "type" | "name">,
): ExportIndexedAsset {
  return {
    dependencies: [],
    rootId: "project",
    parentClass: null,
    ...partial,
  };
}

describe("collectExportClosure", () => {
  it("fails when startupSceneGuid is missing", () => {
    const result = collectExportClosure({
      startupSceneGuid: null,
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      pluginEnabledGuids: new Set(),
      parentOf: () => null,
      sceneByGuid: () => null,
      graphByGuid: () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(MISSING_STARTUP_SCENE_MESSAGE);
  });

  it("fails when the startup scene guid is stale", () => {
    const result = collectExportClosure({
      startupSceneGuid: "missing-scene",
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      pluginEnabledGuids: new Set(),
      parentOf: () => null,
      sceneByGuid: () => null,
      graphByGuid: () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(MISSING_STARTUP_SCENE_MESSAGE);
  });

  it("includes the GameInstance class and scene component asset guids", () => {
    const scene: SerializedScene = {
      ...createDefaultScene(),
      settings: {
        ...createDefaultScene().settings,
        gameInstanceClass: "MyGame",
        environmentTextureGuid: "ibl-1",
      },
      actors: [
        createActor("hero", "Hero", {
          classId: "Hero",
          components: [
            { ...createMeshComponent("mesh-1", "box"), properties: { meshKind: "box", assetGuid: "model-1" } },
            {
              id: "sprite-1",
              classId: "SpriteComponent",
              properties: { assetGuid: "sprite-1" },
            },
          ],
        }),
      ],
    };
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "class-game", type: "Class", name: "MyGame", parentClass: "GameInstance" }),
        asset({ guid: "class-hero", type: "Class", name: "Hero", parentClass: "Actor" }),
        asset({ guid: "ibl-1", type: "Texture", name: "IBL" }),
        asset({ guid: "model-1", type: "Model", name: "HeroMesh" }),
        asset({ guid: "sprite-1", type: "Sprite", name: "HeroSprite" }),
        asset({ guid: "unused", type: "Texture", name: "Unused" }),
        asset({
          guid: "euo-1",
          type: "Class",
          name: "LevelTools",
          parentClass: "EditorUtilityObject",
        }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: (id) => {
        if (id === "MyGame") return "GameInstance";
        if (id === "Hero") return "Actor";
        if (id === "LevelTools") return "EditorUtilityObject";
        if (id === "EditorUtilityObject") return "BObject";
        return null;
      },
      sceneByGuid: (guid) => (guid === "scene-1" ? scene : null),
      graphByGuid: () => null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sort()).toEqual(
      ["class-game", "class-hero", "ibl-1", "model-1", "scene-1", "sprite-1"].sort(),
    );
    expect(result.value).not.toContain("unused");
    expect(result.value).not.toContain("euo-1");
  });

  it("follows sprite payload textureGuid when header.dependencies is empty", () => {
    const scene: SerializedScene = {
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          components: [
            {
              id: "sprite-comp",
              classId: "SpriteComponent",
              properties: { assetGuid: "sprite-1" },
            },
          ],
        }),
      ],
    };
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "sprite-1", type: "Sprite", name: "Hero", dependencies: [] }),
        asset({ guid: "tex-atlas", type: "Texture", name: "Atlas" }),
        asset({ guid: "unused-tex", type: "Texture", name: "Unused" }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      payloadByGuid: (guid) =>
        guid === "sprite-1" ? { textureGuid: "tex-atlas" } : null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(
      expect.arrayContaining(["scene-1", "sprite-1", "tex-atlas"]),
    );
    expect(result.value).not.toContain("unused-tex");
  });

  it("follows Sprite Animation frame textureGuids when header.dependencies is empty", () => {
    const scene: SerializedScene = {
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          components: [
            {
              id: "anim-comp",
              classId: "AnimationGraphComponent",
              properties: { graphGuid: "loco-1" },
            },
          ],
        }),
      ],
    };
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "loco-1",
          type: "AnimationGraph",
          name: "Loco",
          dependencies: [],
        }),
        asset({
          guid: "walk-anim",
          type: "SpriteAnimation",
          name: "Walk",
          dependencies: [],
        }),
        asset({ guid: "tex-walk", type: "Texture", name: "WalkTex" }),
        asset({ guid: "unused-tex", type: "Texture", name: "Unused" }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      payloadByGuid: (guid) => {
        if (guid === "loco-1") {
          return {
            clips: [{ kind: "sprite", assetGuid: "walk-anim" }],
          };
        }
        if (guid === "walk-anim") {
          return { frames: [{ textureGuid: "tex-walk", durationMs: 100 }] };
        }
        return null;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(
      expect.arrayContaining(["scene-1", "loco-1", "walk-anim", "tex-walk"]),
    );
    expect(result.value).not.toContain("unused-tex");
  });

  it("follows graph pin guids and header dependencies", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "n1",
          type: "audio.play",
          position: { x: 0, y: 0 },
          data: { properties: { assetGuid: "sfx-1" } },
        },
      ],
      edges: [],
    };
    const scene: SerializedScene = {
      ...createDefaultScene(),
      actors: [createActor("a", "Pawn", { classId: "Pawn" })],
    };
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "class-pawn",
          type: "Class",
          name: "Pawn",
          parentClass: "Actor",
          dependencies: ["iface-1"],
        }),
        asset({ guid: "sfx-1", type: "Audio", name: "Jump" }),
        asset({ guid: "iface-1", type: "ScriptInterface", name: "Damageable" }),
        asset({ guid: "other-scene", type: "Scene", name: "Other" }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => "Actor",
      sceneByGuid: (guid) => (guid === "scene-1" ? scene : null),
      graphByGuid: (guid) => (guid === "class-pawn" ? graph : null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(
      expect.arrayContaining(["scene-1", "class-pawn", "sfx-1", "iface-1"]),
    );
    expect(result.value).not.toContain("other-scene");
  });

  it("omits disabled plugin roots", () => {
    const scene = createDefaultScene();
    scene.actors = [
      createActor("a", "Starter", { classId: "StarterActor" }),
    ];
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "plug-class",
          type: "Class",
          name: "StarterActor",
          parentClass: "Actor",
          rootId: "plugin:plug-1",
        }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => "Actor",
      sceneByGuid: () => scene,
      graphByGuid: () => null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(["scene-1"]);
  });

  it("keeps enabled plugin assets in the closure", () => {
    const scene = createDefaultScene();
    scene.actors = [
      createActor("a", "Starter", { classId: "StarterActor" }),
    ];
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "plug-class",
          type: "Class",
          name: "StarterActor",
          parentClass: "Actor",
          rootId: "plugin:plug-1",
        }),
      ],
      pluginEnabledGuids: new Set(["plug-1"]),
      parentOf: () => "Actor",
      sceneByGuid: () => scene,
      graphByGuid: () => null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(expect.arrayContaining(["scene-1", "plug-class"]));
  });

  it("strips PluginSettings and EditorUtilityInterface types", () => {
    const scene = createDefaultScene();
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main", dependencies: ["plug-settings", "eui-1"] }),
        asset({ guid: "plug-settings", type: "PluginSettings", name: "Tools" }),
        asset({ guid: "eui-1", type: "EditorUtilityInterface", name: "Dock" }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(["scene-1"]);
  });

  it("includes a Scene referenced by Change Scene display name", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "n1",
          type: "scene.change",
          position: { x: 0, y: 0 },
          data: { properties: { scene: "Level 2" } },
        },
      ],
      edges: [],
    };
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "scene-2", type: "Scene", name: "Level 2" }),
        asset({
          guid: "class-pawn",
          type: "Class",
          name: "Pawn",
          parentClass: "Actor",
        }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => "Actor",
      sceneByGuid: (guid) =>
        guid === "scene-1"
          ? {
              ...createDefaultScene(),
              actors: [createActor("a", "Pawn", { classId: "Pawn" })],
            }
          : guid === "scene-2"
            ? { ...createDefaultScene(), name: "Level 2", actors: [] }
            : null,
      graphByGuid: (guid) => (guid === "class-pawn" ? graph : null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(
      expect.arrayContaining(["scene-1", "scene-2", "class-pawn"]),
    );
  });

  it("includes the project AudioMixer, its channels, and Audio attenuation refs", () => {
    const scene: SerializedScene = {
      ...createDefaultScene(),
      actors: [
        createActor("speaker", "Speaker", {
          components: [
            {
              id: "audio-1",
              classId: "AudioComponent",
              properties: { audioAssetGuid: "sfx-1" },
            },
          ],
        }),
      ],
    };
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      audioMixerGuid: "mixer-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "mixer-1",
          type: "AudioMixer",
          name: "Master",
          dependencies: ["ch-sfx", "ch-music"],
        }),
        asset({
          guid: "ch-sfx",
          type: "AudioChannel",
          name: "SFX",
          dependencies: ["ch-master"],
        }),
        asset({ guid: "ch-master", type: "AudioChannel", name: "Master" }),
        asset({ guid: "ch-music", type: "AudioChannel", name: "Music" }),
        asset({
          guid: "sfx-1",
          type: "Audio",
          name: "Jump",
          dependencies: ["ch-sfx", "att-1"],
        }),
        asset({ guid: "att-1", type: "SoundAttenuation", name: "Near" }),
        asset({ guid: "unused-mix", type: "AudioMixer", name: "Unused" }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sort()).toEqual(
      [
        "att-1",
        "ch-master",
        "ch-music",
        "ch-sfx",
        "mixer-1",
        "scene-1",
        "sfx-1",
      ].sort(),
    );
    expect(result.value).not.toContain("unused-mix");
  });

  it("includes a project GameInstance class when the scene field is empty", () => {
    const scene = createDefaultScene();
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      gameInstanceClass: "MyGame",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "class-game",
          type: "Class",
          name: "MyGame",
          parentClass: "GameInstance",
        }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: (id) => (id === "MyGame" ? "GameInstance" : null),
      sceneByGuid: () => scene,
      graphByGuid: () => null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(expect.arrayContaining(["scene-1", "class-game"]));
  });

  it("includes mesh materials, post-process stack materials, and header dependencies", () => {
    const mesh = createMeshComponent("mesh-1", "box");
    mesh.properties.materialGuid = "mat-rock";
    const scene: SerializedScene = {
      ...createDefaultScene(),
      settings: {
        ...createDefaultScene().settings,
        postProcessStack: [{ materialGuid: "mat-bloom", enabled: true }],
      },
      actors: [createActor("hero", "Hero", { components: [mesh] })],
    };
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "mat-rock",
          type: "Material",
          name: "Rock",
          dependencies: ["fn-tint", "tex-albedo"],
        }),
        asset({
          guid: "mat-bloom",
          type: "Material",
          name: "Bloom",
          dependencies: [],
        }),
        asset({ guid: "fn-tint", type: "MaterialFunction", name: "Tint" }),
        asset({ guid: "tex-albedo", type: "Texture", name: "Albedo" }),
        asset({ guid: "unused-mat", type: "Material", name: "Unused" }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(
      expect.arrayContaining([
        "scene-1",
        "mat-rock",
        "mat-bloom",
        "fn-tint",
        "tex-albedo",
      ]),
    );
    expect(result.value).not.toContain("unused-mat");
  });

  it("includes a UserInterface referenced by namespaced class id", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "n1",
          type: "ui.applyToViewport",
          position: { x: 0, y: 0 },
          data: { properties: { asset: "UserInterface:hud-1" } },
        },
      ],
      edges: [],
    };
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "class-host",
          type: "Class",
          name: "HudHost",
          parentClass: "Actor",
        }),
        asset({ guid: "hud-1", type: "UserInterface", name: "HUD" }),
        asset({ guid: "unused-ui", type: "UserInterface", name: "Unused" }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => "Actor",
      sceneByGuid: () => ({
        ...createDefaultScene(),
        actors: [createActor("a", "HudHost", { classId: "HudHost" })],
      }),
      graphByGuid: (guid) => (guid === "class-host" ? graph : null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(
      expect.arrayContaining(["scene-1", "class-host", "hud-1"]),
    );
    expect(result.value).not.toContain("unused-ui");
  });

  it("includes nested UserInterface, image, and Font family references from a UI payload", () => {
    const scene: SerializedScene = {
      ...createDefaultScene(),
      actors: [
        createActor("hud", "HUD", {
          components: [
            {
              id: "ui",
              classId: "UserInterfaceComponent",
              properties: { assetGuid: "hud-1" },
            },
          ],
        }),
      ],
    };
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "hud-1", type: "UserInterface", name: "HUD" }),
        asset({ guid: "chip-1", type: "UserInterface", name: "Chip" }),
        asset({ guid: "tex-logo", type: "Texture", name: "Logo" }),
        asset({ guid: "font-1", type: "Font", name: "Display" }),
        asset({ guid: "unused-tex", type: "Texture", name: "Unused" }),
        asset({
          guid: "eui-1",
          type: "EditorUtilityInterface",
          name: "Dock",
        }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      payloadByGuid: (guid) => {
        if (guid === "hud-1") {
          return {
            widgets: {
              canvas: { id: "canvas", kind: "Canvas", children: ["logo", "host"] },
              logo: {
                id: "logo",
                kind: "Image",
                props: { imageGuid: "tex-logo" },
                style: { fontFamily: "Display" },
              },
              host: {
                id: "host",
                kind: "UserInterface",
                nestedUiGuid: "chip-1",
              },
            },
          };
        }
        if (guid === "chip-1") {
          return {
            widgets: {
              canvas: { id: "canvas", kind: "Canvas", children: ["label"] },
              label: { id: "label", kind: "Text", style: { fontFamily: "Display" } },
            },
          };
        }
        return null;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(
      expect.arrayContaining(["scene-1", "hud-1", "chip-1", "tex-logo", "font-1"]),
    );
    expect(result.value).not.toContain("unused-tex");
    expect(result.value).not.toContain("eui-1");
  });
});
