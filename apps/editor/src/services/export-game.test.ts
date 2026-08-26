import { describe, expect, it } from "vitest";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  createActor,
  createDefaultScene,
  createText3DComponent,
  createText2DComponent,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  defaultExportPreset,
  isErr,
  isOk,
} from "@babylonslate/core";
import { MISSING_STARTUP_SCENE_MESSAGE, parseScriptRegistry } from "@babylonslate/exporter";
import { collectAndExportGame } from "./export-game";
import type { ExportIndexedAsset } from "@babylonslate/exporter";

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

const playerFiles = new Map([
  ["index.html", new TextEncoder().encode("<html></html>")],
  ["player.js", new TextEncoder().encode("void 0")],
]);

describe("collectAndExportGame", () => {
  it("fails with the startup scene copy when the guid is missing", async () => {
    const result = await collectAndExportGame({
      startupSceneGuid: null,
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => null,
      graphByGuid: () => null,
      bytesByGuid: () => null,
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(false);
    if (isErr(result)) {
      expect(result.error).toBe(MISSING_STARTUP_SCENE_MESSAGE);
    }
  });

  it("packs the startup scene guid and strips editor-only classes", async () => {
    const scene = {
      ...createDefaultScene(),
      settings: {
        ...createDefaultScene().settings,
        gameInstanceClass: "MyGame",
      },
      actors: [createActor("hero", "Hero", { classId: "Hero" })],
    };
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "class-game",
          type: "Class",
          name: "MyGame",
          parentClass: "GameInstance",
        }),
        asset({
          guid: "euo-1",
          type: "Class",
          name: "Tools",
          parentClass: "EditorUtilityObject",
        }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      preset: defaultExportPreset(),
      parentOf: (id) => {
        if (id === "MyGame") return "GameInstance";
        if (id === "Tools" || id === "EditorUtilityObject") return "BObject";
        return null;
      },
      sceneByGuid: (guid) => (guid === "scene-1" ? scene : null),
      graphByGuid: () => null,
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new TextEncoder().encode("{}"),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.startupSceneGuid).toBe("scene-1");
    expect(result.value.manifest.mode).toBe("packed");
    expect(result.value.manifest.bundleDebugger).toBe(false);
    expect(result.value.files.has("boot.babpack")).toBe(true);
    expect(result.value.manifest.assets.some((entry) => entry.guid === "euo-1")).toBe(
      false,
    );
  });

  it("packs a project Game Instance when the startup scene omits one", async () => {
    const scene = createDefaultScene();
    const result = await collectAndExportGame({
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
      plugins: [],
      projectPluginOverrides: {},
      preset: defaultExportPreset(),
      parentOf: (id) => (id === "MyGame" ? "GameInstance" : null),
      sceneByGuid: (guid) => (guid === "scene-1" ? scene : null),
      graphByGuid: () => null,
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new TextEncoder().encode("{}"),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.gameInstanceClass).toBe("MyGame");
    expect(result.value.manifest.assets.some((entry) => entry.guid === "class-game")).toBe(
      true,
    );
  });

  it("packs a sprite textureGuid reached through the sprite payload", async () => {
    const scene = {
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
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "sprite-1", type: "Sprite", name: "Hero" }),
        asset({ guid: "tex-atlas", type: "Texture", name: "Atlas" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      payloadByGuid: (guid) =>
        guid === "sprite-1" ? { textureGuid: "tex-atlas" } : null,
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new TextEncoder().encode(guid),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    const guids = result.value.manifest.assets.map((entry) => entry.guid);
    expect(guids).toEqual(expect.arrayContaining(["scene-1", "sprite-1", "tex-atlas"]));
  });

  it("reports Compiling then Writing Pack", async () => {
    const scene = createDefaultScene();
    const phases: string[] = [];
    await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: () => new TextEncoder().encode(JSON.stringify(scene)),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
      onPhase: (phase) => phases.push(phase),
    });
    expect(phases).toEqual(["Compiling", "Writing Pack"]);
  });

  it("export-preset layer 3 can disable a plugin that is enabled in the editor", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [createActor("a", "Starter", { classId: "StarterActor" })],
    };
    const result = await collectAndExportGame({
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
      plugins: [{ pluginGuid: "plug-1", enabledByDefault: true }],
      projectPluginOverrides: { "plug-1": { enabled: true } },
      preset: {
        ...defaultExportPreset(),
        pluginOverrides: { "plug-1": { enabled: false } },
      },
      parentOf: () => "Actor",
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new TextEncoder().encode("{}"),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.assets.some((entry) => entry.guid === "plug-class")).toBe(
      false,
    );
  });

  it("compiles AnimationGraph lifecycle and transition rules into packed scripts", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          components: [
            {
              id: "anim",
              classId: "AnimationGraphComponent",
              properties: { graphGuid: "graph-1" },
            },
          ],
        }),
      ],
    };
    const doc = createDefaultAnimGraph();
    doc.transitions.push({
      id: "idle-to-idle",
      fromStateId: "idle",
      toStateId: "idle",
      blendSeconds: 0,
      priority: 0,
      ruleGraph: {
        nodes: [
          {
            id: "enter-state",
            type: "anim.rule.enterState",
            position: { x: 0, y: 0 },
            data: { __protected: true },
          },
          {
            id: "exit-state",
            type: "anim.rule.exitState",
            position: { x: 0, y: 80 },
            data: { __protected: true },
          },
        ],
        edges: [],
      },
    });
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "graph-1",
          type: "AnimationGraph",
          name: "Loco",
          path: "assets/Loco.anim.babasset",
        }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      payloadByGuid: (guid) => (guid === "graph-1" ? doc : null),
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new TextEncoder().encode(JSON.stringify(doc)),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    const scripts = new TextDecoder().decode(result.value.files.get("scripts.js"));
    const registry = parseScriptRegistry(scripts);
    expect(registry.map((entry) => entry.classId)).toEqual(
      expect.arrayContaining([
        "AnimGraph:graph-1",
        "AnimRule:graph-1:idle-to-idle",
      ]),
    );
    expect(scripts).toContain("onInitializeAnimation");
    expect(scripts).toContain("export function evaluate(ctx)");
  });

  it("packs a scene navmesh chunk under a sidecar guid", async () => {
    const scene = createDefaultScene();
    const nav = new Uint8Array([9, 8, 7]);
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: () => new TextEncoder().encode(JSON.stringify(scene)),
      navmeshByGuid: (guid) => (guid === "scene-1" ? nav : null),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.some(
        (entry) => entry.type === "NavMesh" && entry.guid === "navmesh:scene-1",
      ),
    ).toBe(true);
  });

  it("packs Texture KTX2 GPU bytes", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          components: [
            {
              id: "mesh-1",
              classId: "MeshComponent",
              properties: { textureGuid: "tex-1" },
            },
          ],
        }),
      ],
    };
    const ktx2 = new Uint8Array([
      0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "tex-1", type: "Texture", name: "Logo" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: (guid) => {
        if (guid === "scene-1") return new TextEncoder().encode(JSON.stringify(scene));
        if (guid === "tex-1") return ktx2;
        return null;
      },
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.some(
        (entry) => entry.type === "Texture" && entry.guid === "tex-1",
      ),
    ).toBe(true);
  });

  it("packs a scene audioReverb chunk under a sidecar guid", async () => {
    const scene = createDefaultScene();
    const field = new Uint8Array([3, 2, 1]);
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: () => new TextEncoder().encode(JSON.stringify(scene)),
      audioReverbByGuid: (guid) => (guid === "scene-1" ? field : null),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.some(
        (entry) =>
          entry.type === "AudioReverb" && entry.guid === "audioReverb:scene-1",
      ),
    ).toBe(true);
  });

  it("packs Font facetype JSON as a FontFacetype sidecar alongside Font source bytes", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("label", "3D Text", {
          components: [
            {
              ...createText3DComponent("text-1"),
              properties: {
                ...createText3DComponent("text-1").properties,
                fontAssetGuid: "font-1",
              },
            },
          ],
        }),
      ],
    };
    const source = new Uint8Array([1, 2, 3]);
    const facetype = new Uint8Array([9, 8, 7]);
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "font-1", type: "Font", name: "Display" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: (guid) => {
        if (guid === "scene-1") return new TextEncoder().encode(JSON.stringify(scene));
        if (guid === "font-1") return source;
        return null;
      },
      fontFacetypeBytesByGuid: (guid) => (guid === "font-1" ? facetype : null),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.some(
        (entry) => entry.type === "Font" && entry.guid === "font-1",
      ),
    ).toBe(true);
    expect(
      result.value.manifest.assets.some(
        (entry) =>
          entry.type === "FontFacetype" && entry.guid === "font-facetype:font-1",
      ),
    ).toBe(true);
  });

  it("packs Font MSDF JSON and atlas PNG as FontMsdf sidecars", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("label", "2D Text", {
          components: [
            {
              ...createText2DComponent("text-1"),
              properties: {
                ...createText2DComponent("text-1").properties,
                fontAssetGuid: "font-1",
              },
            },
          ],
        }),
      ],
    };
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "font-1", type: "Font", name: "Display" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: (guid) => {
        if (guid === "scene-1") return new TextEncoder().encode(JSON.stringify(scene));
        if (guid === "font-1") return new Uint8Array([1, 2]);
        return null;
      },
      fontMsdfJsonByGuid: (guid) => (guid === "font-1" ? new Uint8Array([9]) : null),
      fontMsdfPngByGuid: (guid) => (guid === "font-1" ? new Uint8Array([8]) : null),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.some(
        (entry) => entry.type === "FontMsdf" && entry.guid === "font-msdf:font-1",
      ),
    ).toBe(true);
    expect(
      result.value.manifest.assets.some(
        (entry) =>
          entry.type === "FontMsdfAtlas" && entry.guid === "font-msdf-png:font-1",
      ),
    ).toBe(true);
  });

  it("Preview Build always bundles the debugger", async () => {
    const scene = createDefaultScene();
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [],
      projectPluginOverrides: {},
      preset: defaultExportPreset(),
      previewBuild: true,
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: () => new TextEncoder().encode(JSON.stringify(scene)),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      infiniteLoopDetection: false,
      loopCount: 25,
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.bundleDebugger).toBe(true);
    expect(result.value.manifest.infiniteLoopDetection).toBe(false);
    expect(result.value.manifest.loopCount).toBe(25);
  });

  it("records pixelsPerUnit and Font family names from payloads", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("label", "Label", {
          components: [
            {
              id: "text",
              classId: "Text3DComponent",
              properties: { fontGuid: "font-1" },
            },
          ],
        }),
      ],
    };
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "font-1", type: "Font", name: "Custom Font" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      payloadByGuid: (guid) => (guid === "font-1" ? { family: "Display" } : null),
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new Uint8Array([1, 2, 3]),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      pixelsPerUnit: 64,
      pixelPerfect: true,
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.pixelsPerUnit).toBe(64);
    expect(result.value.manifest.pixelPerfect).toBe(true);
    expect(
      result.value.manifest.assets.find((entry) => entry.guid === "font-1")?.name,
    ).toBe("Display");
  });
});
