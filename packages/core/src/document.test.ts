import { describe, expect, it } from "vitest";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  assetTypeForDocumentKind,
  assetTypeForDocumentSave,
  createDocumentRef,
  createEmptyLayouts,
  documentId,
  documentKindForAssetType,
  documentKindLabel,
  isAssetDocumentKind,
  isClosableDocumentKind,
  isContentBrowserId,
  isLogicGraphAssetType,
  labelFromPath,
  migrateLegacyLayout,
  parseDocumentId,
} from "./document";

describe("P9 document kinds", () => {
  it("opens legacy Shader assets and imported Material assets as Material documents", () => {
    expect(documentKindForAssetType("Material")).toBe("material");
    expect(documentKindForAssetType("Shader")).toBe("material");
    expect(documentKindForAssetType("ShaderGraph")).toBe("material");
    expect(documentKindForAssetType("MaterialFunction")).toBe(
      "material-function",
    );
  });

  it("saves a Material document under the canonical header type", () => {
    expect(assetTypeForDocumentKind("material")).toBe("Material");
    expect(assetTypeForDocumentSave("material", "Shader")).toBe("Material");
    expect(assetTypeForDocumentKind("material-function")).toBe(
      "MaterialFunction",
    );
  });

  it("labels material documents in Title Case", () => {
    expect(documentKindLabel("material")).toBe("Material");
    expect(documentKindLabel("material-function")).toBe("Material Function");
  });

  it("strips material file suffixes from tab labels", () => {
    expect(labelFromPath("assets/Rock.material.babasset")).toBe("Rock");
    expect(labelFromPath("assets/Tint.matfunc.babasset")).toBe("Tint");
    expect(labelFromPath("assets/Legacy.shader.babasset")).toBe("Legacy");
  });

  it("maps UserInterface / Sprite / AnimationGraph kinds", () => {
    expect(documentKindForAssetType("UserInterface")).toBe("ui");
    expect(documentKindForAssetType("EditorUtilityInterface")).toBeNull();
    expect(assetTypeForDocumentKind("ui")).toBe("UserInterface");
    expect(assetTypeForDocumentSave("ui", "EditorUtilityInterface")).toBe(
      "UserInterface",
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

  it("opens Sprite Animation as its own document kind", () => {
    expect(documentKindForAssetType("SpriteAnimation")).toBe("sprite-animation");
    expect(assetTypeForDocumentKind("sprite-animation")).toBe("SpriteAnimation");
    expect(documentKindLabel("sprite-animation")).toBe("Sprite Animation");
    expect(isAssetDocumentKind("sprite-animation")).toBe(true);
    expect(labelFromPath("assets/walk.spriteanim.babasset")).toBe("Walk");
    expect(
      createDocumentRef("sprite-animation", "assets/walk.spriteanim.babasset", {
        name: "Walk",
      }).label,
    ).toBe("Walk Sprite Animation");
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

  it("opens imported Audio as a DockView document", () => {
    expect(documentKindForAssetType("Audio")).toBe("audio");
    expect(assetTypeForDocumentKind("audio")).toBe("Audio");
    expect(documentKindLabel("audio")).toBe("Audio");
    expect(isAssetDocumentKind("audio")).toBe(true);
    expect(labelFromPath("assets/jump.babasset")).toBe("Jump");
    expect(
      createDocumentRef("audio", "assets/jump.babasset", { name: "Jump" }).label,
    ).toBe("Jump Audio");
  });

  it("opens import assets as settings tabs", () => {
    for (const type of ["Texture", "Model", "Animation"]) {
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

  it("opens AudioMixer, AudioChannel, and SoundAttenuation as DockView documents", () => {
    expect(documentKindForAssetType("AudioMixer")).toBe("audio-mixer");
    expect(documentKindForAssetType("AudioChannel")).toBe("audio-channel");
    expect(documentKindForAssetType("SoundAttenuation")).toBe(
      "sound-attenuation",
    );
    expect(assetTypeForDocumentKind("audio-mixer")).toBe("AudioMixer");
    expect(assetTypeForDocumentKind("audio-channel")).toBe("AudioChannel");
    expect(assetTypeForDocumentKind("sound-attenuation")).toBe(
      "SoundAttenuation",
    );
    expect(documentKindLabel("audio-mixer")).toBe("Audio Mixer");
    expect(documentKindLabel("audio-channel")).toBe("Audio Channel");
    expect(documentKindLabel("sound-attenuation")).toBe("Sound Attenuation");
    expect(isAssetDocumentKind("audio-mixer")).toBe(true);
    expect(labelFromPath("assets/master.mixer.babasset")).toBe("Master");
    expect(labelFromPath("assets/sfx.channel.babasset")).toBe("Sfx");
    expect(labelFromPath("assets/near.atten.babasset")).toBe("Near");
    expect(
      createDocumentRef("audio-mixer", "assets/master.mixer.babasset", {
        name: "Master",
      }).label,
    ).toBe("Master Audio Mixer");
  });

  it("opens ParticleEmitter and ParticleSystem as DockView documents", () => {
    expect(documentKindForAssetType("ParticleEmitter")).toBe("particle-emitter");
    expect(documentKindForAssetType("ParticleSystem")).toBe("particle-system");
    expect(assetTypeForDocumentKind("particle-emitter")).toBe("ParticleEmitter");
    expect(assetTypeForDocumentKind("particle-system")).toBe("ParticleSystem");
    expect(documentKindLabel("particle-emitter")).toBe("Particle Emitter");
    expect(documentKindLabel("particle-system")).toBe("Particle System");
    expect(isAssetDocumentKind("particle-emitter")).toBe(true);
    expect(labelFromPath("assets/sparks.emitter.babasset")).toBe("Sparks");
    expect(labelFromPath("assets/fire.particles.babasset")).toBe("Fire");
    expect(
      createDocumentRef("particle-system", "assets/fire.particles.babasset", {
        name: "Fire",
      }).label,
    ).toBe("Fire Particle System");
  });

  it("opens SkyboxCreator as its own DockView document kind", () => {
    expect(documentKindForAssetType("SkyboxCreator")).toBe("skybox-creator");
    expect(assetTypeForDocumentKind("skybox-creator")).toBe("SkyboxCreator");
    expect(documentKindLabel("skybox-creator")).toBe("Skybox Creator");
    expect(isAssetDocumentKind("skybox-creator")).toBe(true);
    expect(labelFromPath("assets/day.skyboxcreator.babasset")).toBe("Day");
    expect(
      createDocumentRef("skybox-creator", "assets/day.skyboxcreator.babasset", {
        name: "Day",
      }).label,
    ).toBe("Day Skybox Creator");
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

describe("document ids and layouts", () => {
  it("uses a stable id for the pinned Content Browser", () => {
    expect(documentId(CONTENT_BROWSER_REF)).toBe(CONTENT_BROWSER_ID);
    expect(isContentBrowserId(CONTENT_BROWSER_ID)).toBe(true);
    expect(isContentBrowserId("scene:assets/main.scene.babasset")).toBe(false);
    expect(isClosableDocumentKind("content-browser")).toBe(false);
    expect(isClosableDocumentKind("scene")).toBe(true);
  });

  it("namespaces asset document ids by kind and path", () => {
    expect(
      documentId({ kind: "scene", path: "assets/main.scene.babasset" }),
    ).toBe("scene:assets/main.scene.babasset");
    expect(parseDocumentId("not-an-id")).toBeNull();
    expect(parseDocumentId(CONTENT_BROWSER_ID)).toEqual({
      kind: "content-browser",
      path: "",
    });
  });

  it("starts empty and wraps a legacy dock layout under the main scene", () => {
    expect(createEmptyLayouts()).toEqual({
      documents: {},
      tabOrder: [],
      activeDocumentId: null,
      showPluginContent: false,
    });
    const legacy = { grid: { root: "viewport" } };
    expect(migrateLegacyLayout(legacy, "scene:main")).toEqual({
      documents: { "scene:main": legacy },
      tabOrder: ["scene:main"],
      activeDocumentId: "scene:main",
    });
  });
});
