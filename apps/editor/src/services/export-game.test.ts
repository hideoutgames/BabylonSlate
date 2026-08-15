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
});
