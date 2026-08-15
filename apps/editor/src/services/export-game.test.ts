import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  defaultExportPreset,
  isErr,
  isOk,
} from "@babylonslate/core";
import { MISSING_STARTUP_SCENE_MESSAGE } from "@babylonslate/exporter";
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

  it("compiles UserInterface logic into the packed script bundle", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("hud", "HUD", {
          components: [
            {
              id: "ui",
              classId: "UserInterfaceComponent",
              properties: { assetGuid: "ui-1" },
            },
          ],
        }),
      ],
    };
    const logic = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "log",
          type: "debug.log",
          position: { x: 200, y: 0 },
          data: { message: "hud-ready" },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "begin",
          sourceHandle: "execOut",
          target: "log",
          targetHandle: "execIn",
        },
      ],
    };
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "ui-1",
          type: "UserInterface",
          name: "Status",
          path: "assets/HUD.ui.babasset",
        }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      payloadByGuid: (guid) => (guid === "ui-1" ? { logic } : null),
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new TextEncoder().encode(JSON.stringify({ logic })),
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    const scripts = new TextDecoder().decode(result.value.files.get("scripts.js"));
    expect(scripts).toContain("HUD");
    expect(scripts).toContain("onBeginPlay");
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
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.bundleDebugger).toBe(true);
  });

  it("records pixelsPerUnit and Font family names from payloads", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("label", "Label", {
          components: [
            {
              id: "text",
              classId: "UserInterfaceComponent",
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
