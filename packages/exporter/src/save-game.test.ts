import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "@babylonslate/core";
import { collectExportReachability } from "./closure";
import { exportGame, parseGameManifest } from "./export-game";

const definition = {
  id: "progress", schemaVersion: 2,
  fields: [{ id: "skin-id", name: "skin", type: "asset" as const, defaultValue: "skin" }],
};

describe("Save Game export contract", () => {
  it("includes the default definition and assets referenced by its typed defaults", () => {
    const result = collectExportReachability({
      startupSceneGuid: "scene", saveGameDefinitionGuid: "save", pluginEnabledGuids: new Set(),
      parentOf: () => null, sceneByGuid: () => null, graphByGuid: () => null,
      payloadByGuid: (guid) => guid === "save" ? definition : null,
      assets: [
        { guid: "scene", type: "Scene", name: "Start", dependencies: [], rootId: "project" },
        { guid: "save", type: "SaveGame", name: "Progress", dependencies: [], rootId: "project" },
        { guid: "skin", type: "Texture", name: "Skin", dependencies: [], rootId: "project" },
        { guid: "unused", type: "Texture", name: "Unused", dependencies: [], rootId: "project" },
      ],
    });
    expect(result.ok && result.value.guids).toEqual(["save", "scene", "skin"]);
  });

  it.each(["packed", "loose"] as const)("retains stable identity, schema and save defaults in the %s player", async (mode) => {
    const result = await exportGame({
      mode, bundleDebugger: false, startupSceneGuid: "scene", scripts: [], assets: [],
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      saveGame: { projectId: "stable-project-guid", definition, defaultProfile: "player-one", defaultSlot: "checkpoint", preview: false },
      playerFiles: new Map([["index.html", new TextEncoder().encode('<script type="module" src="./player.js"></script>')], ["player.js", new Uint8Array()]]),
    });
    if (!result.ok) throw new Error(result.error);
    const loaded = parseGameManifest(new TextDecoder().decode(result.value.files.get("game.json")));
    expect(loaded.saveGame).toMatchObject({ projectId: "stable-project-guid", defaultSlot: "checkpoint", defaultProfile: "player-one", preview: false, definition: { id: "progress", schemaVersion: 2 } });
  });
});
